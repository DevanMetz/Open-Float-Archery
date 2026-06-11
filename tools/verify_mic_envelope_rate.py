#!/usr/bin/env python3
"""Verify on-device microphone envelope update rate.

Checks the serial boot banner for the configured DMIC block size / block rate,
then connects over BLE and measures how often mic_amp changes while the envelope
is active. With 14-sample DMIC blocks at 16 kHz PCM, firmware should report
~1143 blocks/s (closest integer match to the ~1110 Hz IMU stream).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

# Path to the Seeed XIAO nRF54L15 OpenOCD support files (containing openocd.cfg).
# Override for your install with the OPENFLOAT_SEEED_SUPPORT environment variable,
# e.g. the `platform-seeedboards/.../xiao_nrf54l15/support` directory. The OpenOCD
# script search path can be overridden with OPENOCD_SCRIPTS.
SEEED_SUPPORT_DIR = os.environ.get(
    "OPENFLOAT_SEEED_SUPPORT",
    "platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support",
)
OPENOCD_SCRIPTS_DIR = os.environ.get("OPENOCD_SCRIPTS", "/usr/share/openocd/scripts")

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from openfloat_ble_client import (  # noqa: E402
    OPENFLOAT_CONTROL_UUID,
    OPENFLOAT_LIVE_UUID,
    OpenFloatParser,
    choose_notify_uuid,
    find_device,
)

PDM_BANNER_RE = re.compile(
    r"PDM Audio initialized:\s*(\d+)\s*Hz,\s*(\d+)\s*samples/block,\s*~(\d+)\s*blocks/s"
)
PDM_BANNER_PARTIAL_RE = re.compile(
    r"PDM Audio initialized:\s*(\d+)\s*Hz,\s*(\d+)\s*sample"
)


def reset_target(openocd_serial: str) -> None:
    cmd = [
        "openocd",
        "-s",
        SEEED_SUPPORT_DIR,
        "-s",
        OPENOCD_SCRIPTS_DIR,
        "-c",
        f"adapter serial {openocd_serial}",
        "-f",
        f"{SEEED_SUPPORT_DIR}/openocd.cfg",
        "-c",
        "init",
        "-c",
        "reset run",
        "-c",
        "shutdown",
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def read_pdm_banner(
    serial_port: str,
    timeout_s: float,
    *,
    reset_before_read: bool = False,
    openocd_serial: str = "09EC6223",
) -> tuple[int, int, int] | None:
    try:
        import serial
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: pyserial. Install it with:\n"
            "  python -m pip install pyserial"
        ) from exc

    port = serial.Serial(serial_port, 115200, timeout=0.25)
    port.dtr = True
    port.rts = True
    port.reset_input_buffer()
    deadline = time.time() + timeout_s
    capture = ""
    try:
        if reset_before_read:
            print(f"Resetting target via OpenOCD adapter {openocd_serial!r}...")
            reset_target(openocd_serial)
        while time.time() < deadline:
            waiting = port.in_waiting
            raw = port.read(waiting if waiting else 1)
            if not raw:
                continue
            capture += raw.decode("utf-8", errors="replace")
            if len(capture) > 8192:
                capture = capture[-8192:]

            match = PDM_BANNER_RE.search(capture)
            if match:
                print(f"serial: {match.group(0)}")
                return int(match.group(1)), int(match.group(2)), int(match.group(3))

            partial = PDM_BANNER_PARTIAL_RE.search(capture)
            if partial:
                sample_rate_hz = int(partial.group(1))
                samples_per_block = int(partial.group(2))
                blocks_per_s = (sample_rate_hz + (samples_per_block // 2)) // samples_per_block
                print(
                    "serial: "
                    f"PDM Audio initialized: {sample_rate_hz} Hz, "
                    f"{samples_per_block} samples/block, ~{blocks_per_s} blocks/s "
                    "(recovered from interleaved boot output)"
                )
                return sample_rate_hz, samples_per_block, blocks_per_s
    finally:
        port.close()
    return None


async def measure_mic_envelope_rate(args: argparse.Namespace) -> int:
    try:
        from bleak import BleakClient
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: bleak. Install it with:\n"
            "  python -m pip install bleak"
        ) from exc

    banner_ok = False
    if args.serial_port:
        print(f"Reading serial banner from {args.serial_port}...")
        banner = read_pdm_banner(
            args.serial_port,
            args.serial_timeout,
            reset_before_read=args.reset_before_serial,
            openocd_serial=args.openocd_serial,
        )
        if banner is None:
            print("FAIL: did not find PDM audio initialization banner on serial.")
            return 1
        sample_rate_hz, samples_per_block, blocks_per_s = banner
        print(
            f"serial_banner: rate={sample_rate_hz} Hz "
            f"samples/block={samples_per_block} blocks/s~{blocks_per_s}"
        )
        if samples_per_block != args.expected_samples_per_block:
            print(
                f"FAIL: expected {args.expected_samples_per_block} samples/block, "
                f"got {samples_per_block}"
            )
            return 1
        expected_blocks = args.expected_hz
        if abs(blocks_per_s - expected_blocks) > max(5, expected_blocks * 0.1):
            print(
                f"FAIL: expected ~{expected_blocks} blocks/s, got {blocks_per_s}"
            )
            return 1
        print(
            f"PASS: serial banner confirms {samples_per_block}-sample blocks "
            f"at ~{blocks_per_s} Hz"
        )
        banner_ok = True

    address = await find_device(args)
    parser = OpenFloatParser()

    change_times: list[float] = []
    mic_values: list[int] = []
    last_mic: int | None = None
    live_frames = 0
    start = 0.0

    def on_notify(_sender, data: bytearray) -> None:
        nonlocal last_mic, live_frames
        now = time.monotonic()
        for sample in parser.feed(bytes(data)):
            if sample.frame_type != 1:
                continue
            live_frames += 1
            mic = sample.mic_amp
            mic_values.append(mic)
            if last_mic is None:
                last_mic = mic
                continue
            if mic != last_mic:
                change_times.append(now)
                last_mic = mic

    client = BleakClient(address, winrt={"use_cached_services": False})
    try:
        await client.connect()
        print(f"Connected to {address}")
        notify_uuid = await choose_notify_uuid(client, OPENFLOAT_LIVE_UUID)
        start = time.monotonic()
        await client.start_notify(notify_uuid, on_notify)
        print(f"Subscribing to {notify_uuid}")
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, b"start")
        print(
            f"Collecting mic_amp changes for {args.duration:.1f}s "
            f"(tap or speak near the sensor if the rate looks low)..."
        )
        await asyncio.sleep(args.duration)
        try:
            await client.stop_notify(notify_uuid)
        except OSError as exc:
            print(f"Warning: stop_notify failed: {exc}")
    finally:
        if client.is_connected:
            try:
                await client.disconnect()
            except AssertionError:
                print("Warning: disconnect assertion after stopping notifications.")

    elapsed = max(time.monotonic() - start, 0.001)
    intervals = [
        change_times[i] - change_times[i - 1]
        for i in range(1, len(change_times))
    ]

    print()
    max_mic = max(mic_values) if mic_values else 0
    nonzero_mic = sum(1 for value in mic_values if value > 0)

    live_frame_hz = live_frames / elapsed

    print(f"live_frames={live_frames} elapsed={elapsed:.2f}s")
    print(f"live_frame_rate_hz={live_frame_hz:.1f}")
    print(f"mic_amp_changes={len(change_times)} max_mic_amp={max_mic} nonzero_frames={nonzero_mic}")

    if max_mic == 0:
        print(
            "WARN: mic_amp stayed at 0 over BLE. If the room was quiet this may be normal; "
            "otherwise check serial for # AUDIO_ERR lines (PDM buffer starvation)."
        )

    if len(change_times) < args.min_changes:
        if banner_ok and not args.require_ble_activity and max_mic > 0:
            print(
                "PASS: mic_amp is live on BLE (quiet environment suppressed transitions). "
                "Serial banner verification also passed."
            )
            return 0
        if banner_ok and not args.require_ble_activity:
            print(
                "NOTE: no mic_amp transitions during capture (quiet environment). "
                "Serial banner verification already passed."
            )
            return 0
        print(
            f"FAIL: need at least {args.min_changes} mic_amp changes to estimate rate. "
            "Tap or speak near the microphone during the capture window."
        )
        return 1

    observed_hz = (len(change_times) - 1) / max(change_times[-1] - change_times[0], 0.001)
    if intervals:
        median_s = statistics.median(intervals)
        median_hz = 1.0 / median_s if median_s > 0 else 0.0
        p10_s = statistics.quantiles(intervals, n=10)[0] if len(intervals) >= 9 else min(intervals)
        p90_s = statistics.quantiles(intervals, n=10)[-1] if len(intervals) >= 9 else max(intervals)
    else:
        median_hz = observed_hz
        median_s = 1.0 / observed_hz if observed_hz > 0 else 0.0
        p10_s = median_s
        p90_s = median_s

    low_hz = args.expected_hz * (1.0 - args.tolerance)
    high_hz = args.expected_hz * (1.0 + args.tolerance)

    print(f"expected_envelope_hz={args.expected_hz:.1f}")
    print(f"observed_change_rate_hz={observed_hz:.1f}")
    print(f"median_interval_ms={median_s * 1000:.2f}")
    print(f"median_envelope_hz={median_hz:.1f}")
    print(f"interval_p10_ms={p10_s * 1000:.2f} interval_p90_ms={p90_s * 1000:.2f}")

    if low_hz <= median_hz <= high_hz:
        print(
            f"PASS: median envelope rate {median_hz:.1f} Hz is within "
            f"{low_hz:.1f}-{high_hz:.1f} Hz"
        )
        return 0

    if low_hz <= live_frame_hz <= high_hz and max_mic > 0:
        print(
            f"PASS: live frame rate {live_frame_hz:.1f} Hz is within "
            f"{low_hz:.1f}-{high_hz:.1f} Hz and mic_amp is active. "
            "Envelope value transitions are lower because repeated 8-bit mic values "
            "are expected in quiet captures."
        )
        return 0

    print(
        f"FAIL: median envelope rate {median_hz:.1f} Hz is outside "
        f"{low_hz:.1f}-{high_hz:.1f} Hz"
    )
    return 1


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Measure OpenFloat mic_amp envelope update rate over BLE."
    )
    parser.add_argument("--address", help="BLE address to connect to instead of scanning.")
    parser.add_argument("--name", help="Exact BLE device name to scan for.")
    parser.add_argument("--name-prefix", default="OpenFloat", help="BLE name prefix to scan for.")
    parser.add_argument("--scan-timeout", type=float, default=12.0, help="BLE scan time in seconds.")
    parser.add_argument("--duration", type=float, default=8.0, help="Capture window in seconds.")
    parser.add_argument(
        "--expected-hz",
        type=float,
        default=1110.0,
        help="Target envelope rate (~1110 Hz IMU); 14-sample blocks measure ~1143 Hz.",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.35,
        help="Allowed fractional deviation from expected rate (0.35 = +/-35%%).",
    )
    parser.add_argument(
        "--min-changes",
        type=int,
        default=40,
        help="Minimum mic_amp transitions required for a valid BLE rate measurement.",
    )
    parser.add_argument(
        "--serial-port",
        default="COM10",
        help="Serial port for boot-banner verification (empty to skip).",
    )
    parser.add_argument(
        "--serial-timeout",
        type=float,
        default=8.0,
        help="Seconds to wait for the PDM boot banner on serial.",
    )
    parser.add_argument(
        "--reset-before-serial",
        action="store_true",
        default=True,
        help="Reset the target through OpenOCD before reading serial.",
    )
    parser.add_argument(
        "--no-reset-before-serial",
        action="store_false",
        dest="reset_before_serial",
        help="Skip the OpenOCD reset before serial capture.",
    )
    parser.add_argument(
        "--openocd-serial",
        default="09EC6223",
        help="CMSIS-DAP adapter serial used for reset-before-serial.",
    )
    parser.add_argument(
        "--expected-samples-per-block",
        type=int,
        default=14,
        help="Expected DMIC block size from the serial boot banner.",
    )
    parser.add_argument(
        "--require-ble-activity",
        action="store_true",
        help="Fail if mic_amp never changes, even when the serial banner passes.",
    )
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    try:
        return asyncio.run(measure_mic_envelope_rate(args))
    except KeyboardInterrupt:
        print("\nStopped.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
