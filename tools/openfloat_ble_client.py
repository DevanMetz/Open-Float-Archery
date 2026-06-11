#!/usr/bin/env python3
"""OpenFloat BLE telemetry test client.

Scans for an OpenFloat BLE peripheral, subscribes to telemetry notifications,
decodes OpenFloat binary frames or OFRAW text lines, and prints live samples.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import math
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


OPENFLOAT_SERVICE_UUID = "8f3f3b10-0f5a-4f4c-9a2d-000000000001"
OPENFLOAT_LIVE_UUID = "8f3f3b10-0f5a-4f4c-9a2d-000000000002"
OPENFLOAT_CONTROL_UUID = "8f3f3b10-0f5a-4f4c-9a2d-000000000003"

NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

FRAME_SIZE = 29
LIVE_V2_FRAME_SIZE = 20
FRAME_STRUCT = struct.Struct("<2sBBHHhhhhhhhhhhB")
LIVE_V2_STRUCT = struct.Struct("<2sBBHHbbbhhhhB")


@dataclass
class Sample:
    protocol: int
    frame_type: int
    sequence: int
    uptime_us: Optional[int]
    dt_us: int
    ax_mg: int
    ay_mg: int
    az_mg: int
    gx_dps: float
    gy_dps: float
    gz_dps: float
    qw: float
    qx: float
    qy: float
    qz: float
    flags: int
    checksum_ok: bool
    mic_amp: int = 0
    shot_count: Optional[int] = None

    @property
    def accel_g(self) -> float:
        return math.sqrt(
            (self.ax_mg / 1000.0) ** 2
            + (self.ay_mg / 1000.0) ** 2
            + (self.az_mg / 1000.0) ** 2
        )

    @property
    def gyro_dps(self) -> float:
        return math.sqrt(self.gx_dps**2 + self.gy_dps**2 + self.gz_dps**2)


class OpenFloatParser:
    def __init__(self) -> None:
        self.binary_buffer = bytearray()
        self.text_buffer = bytearray()

    def feed(self, data: bytes) -> list[Sample]:
        if self._looks_like_text(data):
            return self._feed_text(data)
        return self._feed_binary(data)

    @staticmethod
    def _looks_like_text(data: bytes) -> bool:
        if not data:
            return False
        if data.startswith((b"OFRAW", b"OFSHOT", b"#", b"*")):
            return True
        printable = sum(32 <= b < 127 or b in (9, 10, 13) for b in data)
        return printable >= max(1, int(len(data) * 0.9))

    def _feed_text(self, data: bytes) -> list[Sample]:
        samples: list[Sample] = []
        self.text_buffer.extend(data)

        while b"\n" in self.text_buffer:
            line_bytes, _, rest = self.text_buffer.partition(b"\n")
            self.text_buffer = bytearray(rest)
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            sample = parse_ofraw_line(line)
            if sample:
                samples.append(sample)
            else:
                print(line)

        return samples

    def _feed_binary(self, data: bytes) -> list[Sample]:
        samples: list[Sample] = []
        self.binary_buffer.extend(data)

        while True:
            start = self.binary_buffer.find(b"OF")
            if start < 0:
                self.binary_buffer.clear()
                return samples
            if start > 0:
                del self.binary_buffer[:start]
            if len(self.binary_buffer) < 4:
                return samples

            frame_len = binary_frame_len(self.binary_buffer)
            if frame_len is None:
                del self.binary_buffer[:2]
                continue
            if len(self.binary_buffer) < frame_len:
                return samples

            frame = bytes(self.binary_buffer[:frame_len])
            del self.binary_buffer[:frame_len]
            sample = parse_binary_frame(frame)
            if sample:
                samples.append(sample)


def binary_frame_len(buf: bytes | bytearray) -> Optional[int]:
    if len(buf) < 4 or buf[:2] != b"OF":
        return None
    protocol = buf[2]
    frame_type = buf[3]
    if protocol == 2 and frame_type == 1:
        return LIVE_V2_FRAME_SIZE
    return FRAME_SIZE


def parse_binary_frame(frame: bytes) -> Optional[Sample]:
    if frame[:2] != b"OF":
        return None

    if len(frame) == LIVE_V2_FRAME_SIZE and frame[2] == 2 and frame[3] == 1:
        (
            _magic,
            protocol,
            frame_type,
            sequence_u16,
            dt_us,
            ax_deci_g,
            ay_deci_g,
            az_deci_g,
            qw_q10k,
            qx_q10k,
            qy_q10k,
            qz_q10k,
            mic_raw,
        ) = LIVE_V2_STRUCT.unpack(frame)
        return Sample(
            protocol=protocol,
            frame_type=frame_type,
            sequence=sequence_u16,
            uptime_us=None,
            dt_us=dt_us,
            ax_mg=ax_deci_g * 100,
            ay_mg=ay_deci_g * 100,
            az_mg=az_deci_g * 100,
            gx_dps=0.0,
            gy_dps=0.0,
            gz_dps=0.0,
            qw=qw_q10k / 10000.0,
            qx=qx_q10k / 10000.0,
            qy=qy_q10k / 10000.0,
            qz=qz_q10k / 10000.0,
            flags=0,
            checksum_ok=True,
            mic_amp=mic_raw,
        )

    if len(frame) != FRAME_SIZE:
        return None

    (
        _magic,
        protocol,
        frame_type,
        sequence_u16,
        dt_us,
        ax_mg,
        ay_mg,
        az_mg,
        gx_q4,
        gy_q4,
        gz_q4,
        qw_q10k,
        qx_q10k,
        qy_q10k,
        qz_q10k,
        mic_raw,
    ) = FRAME_STRUCT.unpack(frame)

    # type 1 = live sample; type 2 = shot event; type 3 = count sync. Only live
    # frames are samples — the others reuse the envelope with different fields,
    # so report them and skip so they do not pollute sequence-loss tracking.
    if frame_type == 2:
        shot_sequence = int.from_bytes(frame[26:28], "little")
        print(
            "OFSHOT(ble) "
            f"shot_count={sequence_u16} shot_id={dt_us} "
            f"shot_sequence={shot_sequence}"
        )
        return None
    if frame_type == 3:
        print(f"OFCOUNT(ble) shot_count={sequence_u16}")
        return None
    if frame_type == 4:
        print(f"OFSTORED(ble) shot_count={sequence_u16} shot_id={dt_us}")
        return None
    if frame_type != 1:
        return None

    return Sample(
        protocol=protocol,
        frame_type=frame_type,
        sequence=sequence_u16,
        uptime_us=None,
        dt_us=dt_us,
        ax_mg=ax_mg,
        ay_mg=ay_mg,
        az_mg=az_mg,
        gx_dps=gx_q4 / 16.0,
        gy_dps=gy_q4 / 16.0,
        gz_dps=gz_q4 / 16.0,
        qw=qw_q10k / 10000.0,
        qx=qx_q10k / 10000.0,
        qy=qy_q10k / 10000.0,
        qz=qz_q10k / 10000.0,
        flags=0,
        checksum_ok=True,
        mic_amp=mic_raw,
    )


def parse_ofraw_line(line: str) -> Optional[Sample]:
    if not line.startswith("OFRAW,"):
        return None

    parts = line.split(",")
    if len(parts) < 19:
        return None

    try:
        return Sample(
            protocol=int(parts[1]),
            frame_type=1,
            sequence=int(parts[2]),
            uptime_us=int(parts[3]),
            dt_us=int(parts[4]),
            ax_mg=int(parts[5]),
            ay_mg=int(parts[6]),
            az_mg=int(parts[7]),
            gx_dps=int(parts[8]) / 1000.0,
            gy_dps=int(parts[9]) / 1000.0,
            gz_dps=int(parts[10]) / 1000.0,
            qw=float(parts[14]) / 1000000.0,
            qx=float(parts[15]) / 1000000.0,
            qy=float(parts[16]) / 1000000.0,
            qz=float(parts[17]) / 1000000.0,
            flags=0,
            checksum_ok=True,
            shot_count=int(parts[18]),
        )
    except ValueError:
        return None


def format_sample(sample: Sample, rate_hz: float, lost: int) -> str:
    return (
        f"{rate_hz:6.1f} Hz "
        f"seq={sample.sequence:<8} "
        f"lost={lost:<5} "
        f"dt={sample.dt_us:<5} us "
        f"accel=({sample.ax_mg:5d},{sample.ay_mg:5d},{sample.az_mg:5d}) mg "
        f"|a|={sample.accel_g:5.2f} g "
        f"gyro=({sample.gx_dps:7.1f},{sample.gy_dps:7.1f},{sample.gz_dps:7.1f}) dps "
        f"mic={sample.mic_amp:3d} "
        f"ok={sample.checksum_ok}"
    )


async def find_device(args):
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: bleak. Install it with:\n"
            "  python -m pip install bleak"
        ) from exc

    if args.address:
        return args.address

    print(f"Scanning for BLE devices for {args.scan_timeout:.1f}s...")
    devices = await BleakScanner.discover(timeout=args.scan_timeout)
    for device in devices:
        name = device.name or ""
        if args.name and name == args.name:
            print(f"Found {name} at {device.address}")
            return device
        if args.name_prefix and name.startswith(args.name_prefix):
            print(f"Found {name} at {device.address}")
            return device

    print("No matching BLE device found.")
    print("Visible devices:")
    for device in devices:
        print(f"  {device.address}  {device.name or '(unnamed)'}")
    raise SystemExit(2)


async def choose_notify_uuid(client, requested_uuid: str) -> str:
    get_services = getattr(client, "get_services", None)
    services = await get_services() if get_services else client.services
    requested = requested_uuid.lower()
    for service in services:
        for char in service.characteristics:
            if char.uuid.lower() == requested:
                return char.uuid

    notify_chars = [
        char
        for service in services
        for char in service.characteristics
        if "notify" in char.properties
    ]
    if len(notify_chars) == 1 and notify_chars[0].uuid.lower() != "00002a19-0000-1000-8000-00805f9b34fb":
        char = notify_chars[0]
        print(f"Requested notify UUID not found; using only notify characteristic {char.uuid}")
        return char.uuid

    print("Available GATT services and characteristics:")
    for service in services:
        print(f"Service {service.uuid}")
        for char in service.characteristics:
            print(f"  {char.uuid} props={','.join(char.properties)}")
    raise SystemExit(f"Notify characteristic not found: {requested_uuid}")


async def run_client(args) -> None:
    try:
        from bleak import BleakClient
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: bleak. Install it with:\n"
            "  python -m pip install bleak"
        ) from exc

    address = await find_device(args)
    notify_uuid = NUS_TX_UUID if args.nus else args.notify_uuid

    parser = OpenFloatParser()
    start = 0.0
    last_print = 0.0
    last_seq: Optional[int] = None
    frames = 0
    notifications = 0
    bytes_received = 0
    lost = 0
    steady_frames = 0
    steady_notifications = 0
    steady_bytes_received = 0
    steady_lost = 0
    csv_writer = None
    csv_file = None

    if args.csv:
        csv_path = Path(args.csv)
        csv_file = csv_path.open("w", newline="", encoding="utf-8")
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow(
            [
                "host_time_s",
                "sequence",
                "uptime_us",
                "dt_us",
                "ax_mg",
                "ay_mg",
                "az_mg",
                "gx_dps",
                "gy_dps",
                "gz_dps",
                "flags",
                "checksum_ok",
                "lost_total",
            ]
        )

    def on_notify(_sender, data: bytearray) -> None:
        nonlocal frames, notifications, bytes_received, last_print, last_seq, lost
        nonlocal steady_frames, steady_notifications, steady_bytes_received, steady_lost

        now = time.monotonic()
        in_steady_window = now - start >= args.warmup
        notifications += 1
        bytes_received += len(data)
        if in_steady_window:
            steady_notifications += 1
            steady_bytes_received += len(data)

        if args.raw:
            print(data.hex(" "))

        for sample in parser.feed(bytes(data)):
            frames += 1
            gap = 0
            if last_seq is not None:
                seq_delta = (sample.sequence - last_seq) & 0xFFFF
                gap = seq_delta - args.sequence_step
                if gap > 0:
                    lost += gap
                    if in_steady_window:
                        steady_lost += gap
            last_seq = sample.sequence
            if in_steady_window:
                steady_frames += 1
            rate_hz = frames / max(0.001, now - start)

            if csv_writer:
                csv_writer.writerow(
                    [
                        f"{now:.6f}",
                        sample.sequence,
                        sample.uptime_us if sample.uptime_us is not None else "",
                        sample.dt_us,
                        sample.ax_mg,
                        sample.ay_mg,
                        sample.az_mg,
                        f"{sample.gx_dps:.3f}",
                        f"{sample.gy_dps:.3f}",
                        f"{sample.gz_dps:.3f}",
                        sample.flags,
                        int(sample.checksum_ok),
                        lost,
                    ]
                )

            if args.every or now - last_print >= args.print_interval:
                print(format_sample(sample, rate_hz, lost))
                last_print = now

    client = BleakClient(address, winrt={"use_cached_services": False})
    try:
        await client.connect()
        print(f"Connected to {address}")
        notify_uuid = await choose_notify_uuid(client, notify_uuid)
        print(f"Subscribing to {notify_uuid}")
        start = time.monotonic()
        last_print = start
        await client.start_notify(notify_uuid, on_notify)

        if args.reset_command:
            print(f"Sending control command: {args.reset_command!r}")
            control_uuid = NUS_RX_UUID if args.nus else args.control_uuid
            await client.write_gatt_char(control_uuid, args.reset_command.encode("utf-8"))

        deadline = None if args.duration <= 0 else time.monotonic() + args.duration
        while deadline is None or time.monotonic() < deadline:
            await asyncio.sleep(0.2)

        try:
            await client.stop_notify(notify_uuid)
        except OSError as exc:
            print(f"Warning: stop_notify failed: {exc}")
    finally:
        if client.is_connected:
            try:
                await client.disconnect()
            except AssertionError:
                print("Warning: Bleak/WinRT reported a disconnect assertion after stopping notifications.")
        if csv_file:
            csv_file.close()

    elapsed = time.monotonic() - start
    print(
        f"Done. frames={frames} lost={lost} elapsed={elapsed:.1f}s "
        f"rate={frames / max(elapsed, 0.001):.1f} Hz "
        f"notifications={notifications} notify_rate={notifications / max(elapsed, 0.001):.1f} Hz "
        f"bytes={bytes_received} bytes_per_s={bytes_received / max(elapsed, 0.001):.0f}"
    )
    if args.warmup > 0:
        steady_elapsed = max(elapsed - args.warmup, 0.001)
        print(
            f"Steady after warmup={args.warmup:.1f}s: "
            f"frames={steady_frames} lost={steady_lost} elapsed={steady_elapsed:.1f}s "
            f"rate={steady_frames / steady_elapsed:.1f} Hz "
            f"notifications={steady_notifications} notify_rate={steady_notifications / steady_elapsed:.1f} Hz "
            f"bytes={steady_bytes_received} bytes_per_s={steady_bytes_received / steady_elapsed:.0f}"
        )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Connect to OpenFloat BLE telemetry and print samples.")
    parser.add_argument("--address", help="BLE address to connect to instead of scanning.")
    parser.add_argument("--name", help="Exact BLE device name to scan for.")
    parser.add_argument("--name-prefix", default="OpenFloat", help="BLE name prefix to scan for.")
    parser.add_argument("--scan-timeout", type=float, default=8.0, help="BLE scan time in seconds.")
    parser.add_argument("--duration", type=float, default=0.0, help="Run time in seconds; 0 means until Ctrl+C.")
    parser.add_argument("--warmup", type=float, default=0.0, help="Exclude this many initial seconds from steady-state stats.")
    parser.add_argument("--notify-uuid", default=OPENFLOAT_LIVE_UUID, help="Telemetry notify characteristic UUID.")
    parser.add_argument("--control-uuid", default=OPENFLOAT_CONTROL_UUID, help="Control write characteristic UUID.")
    parser.add_argument("--nus", action="store_true", help="Use Nordic UART Service UUIDs.")
    parser.add_argument("--raw", action="store_true", help="Print raw notification bytes as hex.")
    parser.add_argument("--every", action="store_true", help="Print every decoded sample.")
    parser.add_argument("--print-interval", type=float, default=0.25, help="Seconds between printed sample summaries.")
    parser.add_argument(
        "--sequence-step",
        type=int,
        default=1,
        help="Expected sequence increment between decoded BLE frames.",
    )
    parser.add_argument("--csv", help="Optional CSV output path.")
    parser.add_argument("--reset-command", help="Optional command to write after connecting, such as start or zero.")
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    try:
        asyncio.run(run_client(args))
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
