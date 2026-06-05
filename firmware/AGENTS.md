# Project Notes For Agents

## Project

The active firmware project is:

```text
C:\Users\metzd\Documents\GitHub\Open-Float-Archery\firmware
```

This is now the OpenFloat live telemetry prototype for the Seeed Studio XIAO nRF54L15 Sense. The firmware reads the onboard IMU, keeps the IMU loop at full rate, runs the orientation math, detects high-accel shot events, and uses only the built-in user LED and user button for device UI.

Do not bring back the XIAO RGB matrix code unless the user explicitly asks for it. The current device UI scope is:

```text
User LED: status blink and shot pulse
User button: calibration / zeroing input
Serial: live telemetry for the web app
```

## Current SDKs

Installed SDKs and toolchains:

```text
Known-good legacy SDK: C:\ncs\v3.1.0
Known-good toolchain:  C:\ncs\toolchains\b8b84efebd

Current test SDK:      C:\ncs\v3.3.0
Current toolchain:     C:\ncs\toolchains\b8b84efebd
Board target:          xiao_nrf54l15/nrf54l15/cpuapp
```

NCS v3.3.0 includes a built-in Seeed `xiao_nrf54l15` board. Do not pass the external Seeed `BOARD_ROOT` for v3.3.0 builds, because it collides with the built-in board definition:

```text
Board(s): {'xiao_nrf54l15'}, defined multiple times.
```

The external board package at `C:\Users\metzd\Downloads\platform-seeedboards\zephyr` is still useful for the OpenOCD support files. Its `board.yml` may need a `full_name` field if it is ever used with newer Zephyr schema validation.

## Important Files

```text
src\main.c       OpenFloat IMU loop, Madgwick math, shot detection, LED/button UI, serial/BLE telemetry
prj.conf         Zephyr/Kconfig settings
app.overlay      IMU power and console routing overrides
CMakeLists.txt   Zephyr app declaration
```

The v3.3.0 built-in board names the Sense IMU node `lsm6ds3tr_c` and already uses the `st,lsm6dsl` driver. The current overlay adds the IMU power supply and leaves console output on `uart20`, which is the built-in board's USB debug UART route.

## Build With NCS v3.3.0

Use `nrfutil toolchain-manager launch` so the command runs with the v3.3.0 environment:

```powershell
& "C:\ncs\toolchains\b8b84efebd\nrfutil\bin\nrfutil.exe" toolchain-manager launch `
  --ncs-version v3.3.0 `
  --chdir "C:\ncs\v3.3.0" `
  -- west build `
  -p always `
  -b xiao_nrf54l15/nrf54l15/cpuapp `
  -d "C:\Users\metzd\Documents\GitHub\Open-Float-Archery\firmware\build-v3.3.0" `
  "C:\Users\metzd\Documents\GitHub\Open-Float-Archery\firmware"
```

The current v3.3.0 build succeeds and creates:

```text
C:\Users\metzd\Documents\GitHub\Open-Float-Archery\firmware\build-v3.3.0\merged.hex
```

Expected non-blocking warnings:

```text
warning: SB_CONFIG_PARTITION_MANAGER is enabled, partition manager has been deprecated
warning: BT_HCI_TX_STACK_SIZE was assigned 2048 but got 1536
```

The BLE bring-up originally required modest Bluetooth buffer sizing that matched the working stock Zephyr peripheral sample. The current firmware keeps a larger MTU/data-length configuration so notification payload size can be tuned without returning to tiny defaults:

```text
CONFIG_BT_BUF_ACL_RX_SIZE=217
CONFIG_BT_BUF_ACL_TX_SIZE=217
CONFIG_BT_L2CAP_TX_MTU=212
```

Leaving these at the tiny defaults (`BT_BUF_ACL_RX_SIZE=27`, `BT_BUF_ACL_TX_SIZE=27`, `BT_L2CAP_TX_MTU=23`) fragments or prevents the intended 200-byte notification path. Very large 251-byte ACL/data-length settings caused net buffer faults in earlier bring-up. The current 217/212 settings build, boot, advertise, and stream 200-byte notifications on Windows/Bleak; retest boot and BLE any time these values move.

## Flash With OpenOCD

Connected probe observed during the v3.3.0 bring-up:

```text
CMSIS-DAP serial: 09EC6223
Windows VCOM:    COM10
VID/PID:         2886:0066
```

Flash the v3.3.0 build with:

```powershell
openocd `
  -s "C:/Users/metzd/Downloads/platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support" `
  -s "C:/Program Files/OpenOCD/share/openocd/scripts" `
  -c "adapter serial 463D5515" `
  -f "C:/Users/metzd/Downloads/platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support/openocd.cfg" `
  -c "init" `
  -c "targets" `
  -c "reset init" `
  -c "nrf54l-load C:/Users/metzd/Documents/GitHub/Open-Float-Archery/firmware/build-v3.3.0/merged.hex" `
  -c "verify_image C:/Users/metzd/Documents/GitHub/Open-Float-Archery/firmware/build-v3.3.0/merged.hex" `
  -c "reset run" `
  -c "shutdown"
```

The v3.3.0 image has flashed and verified successfully with this command.

## Serial Verification

Expected text line while using the current verification build:

```text
OFRAW,1,seq,uptime_us,dt_us,ax_mg,ay_mg,az_mg,gx_mdps,gy_mdps,gz_mdps,roll_cdeg,pitch_cdeg,yaw_cdeg,qw_1e6,qx_1e6,qy_1e6,qz_1e6,shot_count
```

The historical stable IMU loop was configured for 416 Hz. An earlier high-rate
experiment ran the LSM6DS3TR-C at its 6664 Hz max ODR, but the 1 MHz I2C bus
could not drain ~80 KB/s sustainably, so the FIFO overran about once per second
and emitted a corrupted sample around each overrun (the documented "FIFO-pattern
outlier" frames, e.g. `|a|=0.41 g` with a single ~111 dps gyro axis).

The current build configures the LSM6DS3TR-C through raw registers for
**3332 Hz ODR** and reads it with an **interrupt-driven FIFO watermark**:

- The IMU INT1 pin is wired to **P0.02** on this board (`irq-gpios` in the board
  devicetree). `INT1_CTRL.FTH` routes the FIFO watermark to it.
- The FIFO threshold (`LSM6DSL_FIFO_WATERMARK_SAMPLES`, 15 samples ~= 4.5 ms)
  fires a level-triggered GPIO interrupt that wakes the main loop, which drains
  the whole batch in one I2C burst, then re-arms the interrupt. This replaced the
  old busy-poll of `FIFO_STATUS`.
- Each batch is split into fixed `SAMPLES_PER_OUTPUT` (3) groups, and each group
  is emitted as one **distinct** averaged frame (`dt_us = 900`, ~1110 frames/s).
  No frame is duplicated to fake the rate, and the short average preserves the
  shot-impulse peak for `detect_shot()`.

Measured on hardware over a 25 s / 28,670-frame BLE capture: **0 overruns, 0
resyncs, 0 outlier frames, 0 sequence loss, 100% distinct frames** (`|a|` held
0.814-1.179 g), at ~35% active CPU. For comparison, 3332 Hz busy-polling was
~51% CPU with 83% distinct frames, and 6664 Hz overran ~1/s with 16 corrupted
frames per 25 s. The verification serial stream prints every 100th output frame
so 115200 baud can keep up:

```text
IMU ODR:              3332 Hz
FIFO read:            INT1 watermark (P0.02), FTH=15 samples
BLE output rate:      ~1110 averaged frames/s (3 raw samples each, dt_us=900)
Text serial rate:     about 11 Hz
Baud:                 115200
```

Tuning knobs in `src/main.c`: `IMU_ODR_HZ` + `LSM6DSL_IMU_ODR_REG` (ODR; keep in
sync), `LSM6DSL_FIFO_WATERMARK_SAMPLES` (larger = lower CPU, larger batches),
`SAMPLES_PER_OUTPUT` (averaging window / output rate). If `init_imu_interrupt()`
fails, the loop automatically falls back to cooperative FIFO polling.

PowerShell serial probe. Open COM11 with DTR/RTS asserted, then reset the target while the port is still open:

```powershell
$job = Start-Job -ScriptBlock {
  $port = New-Object System.IO.Ports.SerialPort "COM10",115200,None,8,One
  $port.ReadTimeout = 500
  $port.DtrEnable = $true
  $port.RtsEnable = $true
  $port.Open()
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    try { $port.ReadLine().Trim() } catch [System.TimeoutException] {}
  }
  $port.Close()
}
Start-Sleep -Seconds 1
openocd `
  -s "C:/Users/metzd/Downloads/platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support" `
  -s "C:/Program Files/OpenOCD/share/openocd/scripts" `
  -c "adapter serial 09EC6223" `
  -f "C:/Users/metzd/Downloads/platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support/openocd.cfg" `
  -c "init" `
  -c "reset run" `
  -c "shutdown"
Receive-Job -Job $job -Wait
Remove-Job -Job $job
```

Current v3.3.0 serial status:

```text
COM11 initially failed with "Access denied" because a Chrome telemetry window held the port.
After gracefully closing the OpenFloat Live Telemetry Chrome window, COM11 opened.
COM11 stayed silent until DTR and RTS were asserted by the serial client.
With DTR/RTS asserted and the target reset while COM11 was already open, COM11 received the v3.3.0 Zephyr boot banner, the OpenFloat startup lines, the IMU ready line, and live OFRAW samples.
```

That means the v3.3.0 firmware builds, flashes, runs, and serial output is verified on the visible Windows VCOM. If a serial client sees no bytes, first check that no other app has COM11 open, then assert DTR/RTS and reset the module after the port is open.

Verified boot and telemetry excerpt:

```text
*** Booting nRF Connect SDK v3.3.0-ba167d9f3db4 ***
*** Using Zephyr OS v4.3.99-fd9204a02d52 ***
# OPENFLOAT_PROTO,1
# target: Seeed XIAO nRF54L15 Sense
# imu_odr_hz: 3332
# ble_output_hz: 1110 averaged samples/s (3 raw samples averaged per frame)
# ui: user LED status, user button calibration
# IMU ready: raw FIFO I2C on i2c@104000@0x6a, accel+gyro ODR 3332 Hz, accel +/- 16g, gyro +/- 2000 dps
# IMU INT1 watermark on gpio@10a000 pin 2, FTH=15 samples
OFRAW,1,0,77728,900,-753,654,-104,505,-525,488,3,3,0,1000000,228,223,17,0
```

## BLE Verification

The firmware advertises as:

```text
OpenFloat-463F (or similar, forced increment to clear Windows cache)
```

GATT Services:

```text
Service: 8f3f3b10-0f5a-4f4c-9a2d-000000000001 (Custom OpenFloat Service)
Live:    8f3f3b10-0f5a-4f4c-9a2d-000000000002 (Live stream characteristic)
Control: 8f3f3b10-0f5a-4f4c-9a2d-000000000003 (Control command characteristic)
Battery: 0000180f-0000-1000-8000-00805f9b34fb (Standard Battery Service / BAS)
  Level: 00002a19-0000-1000-8000-00805f9b34fb (Battery Level 0-100%)
```

The BLE live characteristic notifies 20-byte binary frames. Live samples are
batched ten per notification (200-byte payload, ~112 notifications/s). Shot and
count frames reuse the same 20-byte envelope, demultiplexed by the type byte, and
are sent as standalone notifications:

```text
type 1 (live):  magic[2]="OF", proto u8, type u8, seq u16, dt_us u16,
                accel_mg int16[3], gyro_dps_q4 int16[3]
type 2 (shot):  "OF", proto, type, shot_count u16, shot_id u16,
                accel_mg int16[3], threshold_cg u16, roll/pitch cdeg
                -- sent on each real shot
type 3 (count): "OF", proto, type, shot_count u16, shot_id u16, ...
                -- count sync sent on subscribe so the persisted lifetime
                   count displays immediately without logging a shot
type 4 (stored shot):
                same payload as type 2; replayed from the RRAM-backed
                stored-shot queue until the browser saves and acknowledges it
```

The shot count is detected on-device, persisted to RRAM via Zephyr Settings
(key `openfloat/shots`, ZMS backend), restored on boot (`# shot_count restored:
N` banner line), and a type-2 notification is sent on every increment. The
firmware also keeps the newest 100 compact shot records in `openfloat/shotlog`.
On subscribe/start it uploads queued shots one at a time as type-4 frames. The
browser sends `shotack:<shot_id>` after IndexedDB save; firmware then removes
that record from RRAM-backed storage.

The BLE control characteristic accepts ASCII commands:

```text
start         Enable live notifications (also triggers a count-sync frame)
stop          Disable live notifications
zero          Capture the current roll/pitch and save them as permanent offsets in RRAM
thresh:<g>    Set shot detection threshold in g, clamped to 2.0-30.0
wakesens:<g>  Set wake-up trigger accelerometer threshold in g, clamped to 0.5-8.0
sleeptime:<s> Set deep sleep timeout in seconds, clamped to 5-600
sleepsens:<g> Set active sleep movement accelerometer threshold in g, clamped to 0.05-0.50
bufrate:<hz>  Set trace buffer rate to 0, 52, 104, or 208 Hz
bufnvs:<0|1>  Toggle RRAM persistence for buffered traces
followms:<ms> Set post-release trace freeze delay, clamped to 0-3000 ms
streamrate:<n> Set BLE live stream divider to 1, 2, 5, 10, or 20
shotreset     Reset the persisted shot count to 0
shotset:<n>   Set the persisted shot count to n (e.g. correct a miscount)
shotack:<n>   Confirm a type-2/type-4 shot was saved by the browser; frees it
tracereq:<n>  Request chunked upload of a stored trace
```

Fresh firmware defaults disconnected deep sleep to 300 seconds. Existing
devices may still have an older persisted `openfloat/sleeptime` value in RRAM;
send `sleeptime:300` or use the dashboard sleep slider to migrate them.

The host-side test client lives in the web repo:

```text
C:\Users\metzd\Documents\GitHub\Open-Float-Archery\tools\openfloat_ble_client.py
```

Install/use:

```powershell
python -m pip install bleak
python tools\openfloat_ble_client.py --name-prefix OpenFloat --scan-timeout 15 --duration 6
```

On the current Windows host, Bleak was installed into a local dependency folder
instead of the global Python environment. If `import bleak` fails, use:

```powershell
$env:PYTHONPATH='C:\tmp\openfloat-pydeps'
python tools\openfloat_ble_client.py --name-prefix OpenFloat --scan-timeout 15 --duration 6
```

Current BLE verification status:

```text
Windows found OpenFloat-463D at DB:92:7D:1C:E9:DA.
The client connected to the custom live UUID.
Decoded 200-byte notifications were received; each contained ten distinct 20-byte frames (dt_us=900).
Serial banner confirmed imu_odr_hz=3332, ~1110 averaged frames/s, INT1 watermark FTH=15.
Raw-register FIFO IMU path configured the LSM6DS3TR-C directly over I2C at 3332 Hz ODR, accel +/-16 g, gyro +/-2000 dps, read via INT1 watermark.
Current run: frames=28670, lost=0, elapsed=25.5s, rate=1123.2 Hz, notifications=2867, notify_rate=112.3 Hz, bytes=573400, bytes_per_s=22463.
Warm-up-excluded window: frames=23180, lost=0, elapsed=20.5s, rate=1129.3 Hz, notifications=2318, notify_rate=112.9 Hz.
FIFO health: fifo_overruns=0, fifo_resyncs=0, severe accel-misalignment frames=0, distinct frames=100% (|a| held 0.814-1.179 g), CPU ~35% active.
Earlier 6664 Hz experiment (for comparison): frames=40080, lost=0, rate=991.9 Hz, but ~1 FIFO overrun/s and ~16 corrupted frames per 25 s.
```

The Python client uses `--sequence-step 1` by default because each decoded BLE frame represents one IMU sample. Do not treat the intentional sequence stride as packet loss.

The ~1110 Hz averaged BLE mode at 3332 Hz ODR with interrupt-driven FIFO
draining is both a throughput and a capture-cleanliness validation on this host:
zero sequence loss, zero FIFO overruns/resyncs, zero outlier frames, and 100%
distinct frames over 28,670 samples. The earlier 6664 Hz experiment matched the
throughput but overran the 1 MHz I2C bus ~1/s and corrupted a sample around each
overrun. The IMU is I2C-only on this board (the LSM6DS3TR-C is at 0x6a on
`i2c30`; it is not routed to SPI), so 1 MHz I2C is the transport ceiling here;
going meaningfully above 3332 Hz cleanly would need different hardware (SPI).

## CPU Load Measurement

`CONFIG_CPU_LOAD=y` is enabled in `prj.conf`. The firmware samples Zephyr CPU
load once per second and prints a serial comment line. The line also carries
running FIFO health counters: `fifo_overruns` (FIFO overran and was reset) and
`fifo_resyncs` (the FIFO pattern register disagreed with the assembled sample, so
a partial sample was discarded). Both should stay flat at 0 in steady state.

```text
# CPU_LOAD,active_permille=364,active_pct=36.4,idle_pct=63.6,fifo_overruns=0,fifo_resyncs=0
```

Validated measurements on the XIAO nRF54L15 Sense at 3332 Hz ODR:

```text
Interrupt-driven FIFO (FTH=15): about 35-37% active CPU, fifo_overruns=0, fifo_resyncs=0.
3332 Hz busy-polling (earlier): about 51% active CPU.
```

The interrupt-driven watermark path cut CPU from ~51% (busy-polling, many small
I2C status reads) to ~35% by draining one large I2C burst per watermark
interrupt and sleeping in between. A larger `LSM6DSL_FIFO_WATERMARK_SAMPLES`
lowers CPU further at the cost of larger batches (more latency, more RAM in the
drain buffer). This is whole-system active-vs-idle load, including the IMU loop,
BLE stack, interrupts, serial logging, and housekeeping. Use thread runtime stats
or cycle counters around FIFO drain / BLE notify / fusion paths for per-section
profiling.

On Windows, include `--reset-command start` in automated BLE tests to match the browser adapter's control write after subscribing:

```powershell
$env:PYTHONPATH='C:\tmp\openfloat-pydeps'
python tools\openfloat_ble_client.py --name-prefix OpenFloat --scan-timeout 12 --duration 20 --warmup 5 --reset-command start
```

Use `--warmup <seconds>` for steady-state BLE throughput stats after the Windows connection parameter and PHY updates settle.

One Windows-specific caveat remains: after the Python/Bleak client exits, Windows may hold the BLE connection for a while. In that state immediate rediscovery by scanning can fail even though serial continues streaming and the firmware remains alive. The firmware restarts advertising in its `disconnected` callback, so if a real disconnect reaches the device it should advertise again. The Python client now connects with the scanned BLE device object for name/prefix matches, which helps WinRT reliability; if repeat scans still fail, reset the module through OpenOCD and use a short scan timeout before an older persisted sleep timer can fire.

Useful CPU liveness check:

```powershell
openocd `
  -s "C:/Users/metzd/Downloads/platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support" `
  -s "C:/Program Files/OpenOCD/share/openocd/scripts" `
  -c "adapter serial 463D5515" `
  -f "C:/Users/metzd/Downloads/platform-seeedboards/zephyr/boards/arm/xiao_nrf54l15/support/openocd.cfg" `
  -c "init" `
  -c "halt" `
  -c "reg pc" `
  -c "shutdown"
```

The latest halt mapped `pc=0x00003380` to `nrfx_coredep_delay_us`, which is normal running firmware delay code.

## v3.1.0 Legacy Path

The older v3.1.0 path used the external Seeed board package:

```powershell
& "C:\ncs\toolchains\b8b84efebd\opt\bin\Scripts\west.exe" build `
  -p always `
  -b xiao_nrf54l15/nrf54l15/cpuapp `
  -d "C:\Users\metzd\Documents\GitHub\Open-Float-Archery\firmware\build" `
  "C:\Users\metzd\Documents\GitHub\Open-Float-Archery\firmware" `
  -- `
  -DBOARD_ROOT="C:\Users\metzd\Downloads\platform-seeedboards\zephyr"
```

Use v3.1.0 only as a comparison point while bringing up v3.3.0. The active goal is to move the OpenFloat telemetry firmware to v3.3.0.
