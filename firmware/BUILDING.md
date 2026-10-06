# Building the OpenFloat Firmware

The firmware is a Zephyr / nRF Connect SDK (NCS) application for the
**Seeed Studio XIAO nRF54L15 Sense**. It reads the onboard IMU at full rate,
runs the orientation math and shot detection, samples the PDM microphone
envelope, and streams telemetry to the web app over BLE.

- Board target: `xiao_nrf54l15/nrf54l15/cpuapp`
- Tested SDK: **NCS v3.3.0** (also builds on v3.1.0 via the legacy path below)
- Device UI: user LED (status + shot pulse), user button (calibration), and the
  BLE/serial telemetry stream

## Prerequisites

1. **nRF Connect SDK v3.3.0** and a matching toolchain. The easiest setup is the
   [nRF Connect for VS Code](https://docs.nordicsemi.com/bundle/nrf-connect-vscode/page/index.html)
   extension, or a manual install via `nrfutil`/`west`. NCS v3.3.0 ships a
   built-in `xiao_nrf54l15` board, so **no external board package is required**.
2. **OpenOCD** with the Seeed XIAO nRF54L15 support files, for flashing over the
   board's CMSIS-DAP debug interface.

> **Do not pass an external Seeed `BOARD_ROOT` on NCS v3.3.0.** It collides with
> the built-in board definition and fails with
> `Board(s): {'xiao_nrf54l15'}, defined multiple times.`

## Build

From an environment that has the NCS v3.3.0 toolchain available (e.g. the
nRF Connect terminal, or `nrfutil toolchain-manager launch`), run `west build`
against this `firmware/` directory:

```sh
west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp -d build-v3.3.0 .
```

If you launch the toolchain explicitly with `nrfutil`, the equivalent is:

```sh
nrfutil toolchain-manager launch --ncs-version v3.3.0 -- \
  west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp -d build-v3.3.0 .
```

A successful build produces the flashable image at:

```text
firmware/build-v3.3.0/merged.hex
```

Before flashing, check the actual GATT objects and advertised service UUID in
the unstripped ARM32 ELF. Run from the repository root:

```sh
python tools/verify_ble_uuids.py firmware/build-v3.3.0/firmware/zephyr/zephyr.elf
```

The check uses Python's standard library and compares compiled bytes with the
browser adapter and both Python BLE clients. It requires no connected sensor
and runs in firmware CI before the image is uploaded. The application build
also rejects shifts outside their operand width; the 48-bit UUID fields use
64-bit literals so Zephyr's encoding shifts are defined. This preserves the
published UUIDs. Physical advertising and connection tests still require a
flashed device.

Counter settings now save the lifetime count and last capture ID together in
eight bytes. Four-byte settings from older firmware still load, and count
corrections/resets preserve IDs through subsequent reboots. Older firmware
cannot load the new eight-byte record. Before downgrading, record the displayed
count so you can restore it with that version's `shotset` command; its original
range limits and ID-reset behavior apply. See the counter section in
[`Blueprint.md`](../Blueprint.md) for the layout and migration details.

Numeric tuning commands now reject incomplete values, overflow, NaN, and infinity
before changing settings. Valid inputs retain their documented clamps. Persisted
tuning values must have complete four-byte reads and supported values, including
a nonzero stream divider; invalid records retain defaults. Portable parser and
range checks run from `tests/control_values_test.c` (commands in
[`test/README.md`](../test/README.md)). On-device GATT errors and reboot behavior
still need hardware verification.

Queued-shot restore preserves the current 2,804-byte Settings layout and accepts
the older 2,202/1,802-byte layouts. Declared sizes and actual read counts must
match; invalid counts and incomplete reads leave the RAM queue unchanged. The
portable restore and stored-frame checks run from `tests/shot_log_test.c`, with
browser/Python verification commands in `test/README.md`. See `Blueprint.md` for
the layouts and boot-stack notes. Physical Settings and power-cycle verification
remain pending.

The queue writer clears unused slots and padding, and `prj.conf` enables
`CONFIG_ZMS_NO_DOUBLE_WRITE=y`. An acknowledgment that drains an already empty
stored log no longer rewrites it. Initial empty values, changed backlogs, and
backlog removal still write; counter and enabled trace storage are separate.
The comparison adds reads on the system workqueue. Firmware CI runs the actual
SDK ZMS host capacity and flash-call checks through `tools/verify_trace_storage.py`;
the model proves write suppression and remount recovery, not physical RRAM
timing or the complete Settings backend.

Automatic System OFF now waits for follow-through, blocks new control updates,
drains prior writers, and saves all twelve Settings values plus requested
unsaved traces. `src/sleep_flush.c` allows three passes with one-second delays;
continued errors keep the sensor awake and retry sleep after thirty seconds.
Hardware shutdown and its reboot fallback follow only a successful flush.
Ordinary saves share one worker with independent per-key budgets: three attempts,
one second after each failed write. New updates coalesce and supersede older
write results; exhausted failures remain eligible for an update or final sleep
save. Ready settings continue during another key's backoff. Host tests inject
faults at every value and trace write, and the
SDK storage model verifies final snapshots after GC/remount. Physical sleep,
workqueue/control timing, wake-up, and battery behavior remain unverified.
See `Blueprint.md` for sealing, trace failure retention, and recovery details.
The real SDK Settings backend also passes 108 callback write-fault cases,
remounts, recovery after exhausted retries by update/sleep, and newer counters
during old I/O. These single-threaded checks exclude physical flash failures
and actual Zephyr worker scheduling.

Startup waits for storage restoration before BLE, acquisition, or application
save jobs start. It tries three times with one-second delays; continued errors
cause a double-pulsing user LED and another batch after thirty seconds. Malformed
counters/shot queues also keep startup closed, preventing unread IDs/backlog from
being overwritten with defaults. Missing fresh-device keys and malformed tunings
use defaults. The reader uses the pinned SDK's internal Settings/ZMS definitions
because ordinary Settings lookup can hide read errors. Existing layouts and
write APIs are unchanged; SDK metadata repair can still write. Portable tests,
SDK backend/hash fault checks, and the NCS build pass. Physical startup delay
and LED/error behavior are pending.

Startup also reconciles the capture ID against complete saved shots/traces,
preventing an older counter from reusing a retained full ID. The saved count
stays unchanged. After every read succeeds, a changed ID must save before BLE or
acquisition starts, so replay cannot remove its only durable evidence. Failed
repair uses the same bounded startup retries. Fresh defaults and unchanged IDs
need no application save. Wrap-aware
ordering assumes retained IDs span less than half the unsigned range, and an
exact half-range ambiguity keeps startup closed. Legacy 16-bit shot logs cannot
infer high bits. Portable/cross-client and real SDK remount checks pass; physical
power-cycle behavior remains unverified. This adds no storage-schema changes.

These two warnings are expected and harmless:

```text
warning: SB_CONFIG_PARTITION_MANAGER is enabled, partition manager has been deprecated
warning: BT_HCI_TX_STACK_SIZE was assigned 2048 but got 1536
```

### Build configurations

- **`prj.conf` (default)** is battery-safe: it disables the USB UART console so
  the board can boot from Li-ion battery power.
- **`prj_uart.conf`** is an overlay that re-enables the USB serial console for
  bench debugging. Add it to the build:

  ```sh
  west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp -d build-v3.3.0 . \
    -- -DOVERLAY_CONFIG=prj_uart.conf
  ```

- **`app.overlay`** adds the IMU power supply, sets the PDM queue size, and
  routes the console for USB debug builds.

> The BLE config keeps a larger MTU / data-length than the Zephyr defaults
> (`CONFIG_BT_BUF_ACL_RX_SIZE=217`, `CONFIG_BT_BUF_ACL_TX_SIZE=217`,
> `CONFIG_BT_L2CAP_TX_MTU=212`) so the high-rate notification path can batch six
> 20-byte live frames into 120-byte notifications. The tiny defaults fragment or
> block that path; very large 251-byte settings caused net-buffer faults during
> bring-up. Retest boot and BLE if these values change.

## Flash

Connect the board over USB and flash `merged.hex` with OpenOCD over the
CMSIS-DAP probe. Replace the angle-bracket placeholders with your local paths
and your probe's CMSIS-DAP serial:

```sh
openocd \
  -s "<seeed-support>/boards/arm/xiao_nrf54l15/support" \
  -s "<openocd-scripts>" \
  -c "adapter serial <PROBE_SERIAL>" \
  -f "<seeed-support>/boards/arm/xiao_nrf54l15/support/openocd.cfg" \
  -c "init" \
  -c "reset init" \
  -c "nrf54l-load build-v3.3.0/merged.hex" \
  -c "verify_image build-v3.3.0/merged.hex" \
  -c "reset run" \
  -c "shutdown"
```

The board resets and runs the new firmware immediately. You can also flash with
`west flash` if your environment is configured for the XIAO runner.

## Verify

After flashing, the firmware advertises over BLE as **`OpenFloat-XXXX`** and
blinks the user LED. Connect from the web app (see the repo `README.md`) or use
the host-side test client in `tools/openfloat_ble_client.py`.

If you built with the `prj_uart.conf` overlay, you can also confirm boot over
serial at **115200 baud**. Open the port with DTR/RTS asserted, then reset the
board. Expected lines:

```text
*** Booting nRF Connect SDK v3.3.0 ***
# OPENFLOAT_PROTO,1
# target: Seeed XIAO nRF54L15 Sense
# imu_odr_hz: 3332
# IMU ready: ... accel+gyro ODR 3332 Hz, accel +/- 16g, gyro +/- 2000 dps
# IMU INT1 watermark on gpio@10a000 pin 2, FTH=15 samples
OFRAW,1,0,77728,900,-753,654,-104,505,-525,488,3,3,0,1000000,228,223,17,0
```

The verification serial stream prints every 100th output frame (~11 Hz of text)
so 115200 baud can keep up; the BLE stream itself runs at ~1110 averaged
frames/s. A healthy device shows `fifo_overruns=0` and `fifo_resyncs=0` in the
periodic `# CPU_LOAD` line. If a serial client sees no bytes, make sure no other
app holds the port, then assert DTR/RTS and reset the board with the port open.

## How it runs (key tuning knobs)

The IMU is configured through raw registers for **3332 Hz ODR** and read via an
interrupt-driven FIFO watermark on INT1 (P0.02). Each output frame averages 3
raw samples (`dt_us = 900`, ~1110 frames/s). The relevant constants in
`src/main.c`:

| Constant | Purpose |
| --- | --- |
| `IMU_ODR_HZ` / `LSM6DSL_IMU_ODR_REG` | IMU output data rate (keep both in sync) |
| `LSM6DSL_FIFO_WATERMARK_SAMPLES` | FIFO threshold; larger = lower CPU, larger batches |
| `SAMPLES_PER_OUTPUT` | Averaging window / output frame rate |
| `AUDIO_SAMPLES_PER_BLOCK` | PDM mic block size (~1143 blocks/s) |
| `AUDIO_ENVELOPE_TAU_S` | Mic peak-follower decay (5 ms) |
| `AUDIO_BLE_SCALE_DIVISOR` | Scales the `mic_amp` byte into 0–255 |

If `init_imu_interrupt()` fails at boot, the loop falls back to cooperative FIFO
polling automatically.

The BLE GATT services, characteristics, frame layout, and the full ASCII
control-command set are documented in the repo `README.md` and `docs/`. The
1 MHz I2C bus is the transport ceiling on this board (the IMU is I2C-only, not
routed to SPI), so going meaningfully above 3332 Hz cleanly would need different
hardware.

## Legacy NCS v3.1.0 path

NCS v3.1.0 predates the built-in board, so it needs the external Seeed board
package via `BOARD_ROOT`:

```sh
west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp -d build . \
  -- -DBOARD_ROOT="<path-to>/platform-seeedboards/zephyr"
```

Use v3.1.0 only as a comparison point; **v3.3.0 is the supported target.**
