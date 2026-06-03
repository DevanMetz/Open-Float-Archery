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
Current toolchain:     C:\ncs\toolchains\936afb6332
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
CMSIS-DAP serial: 463D5515
Windows VCOM:    COM11
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
  -c "reset run" `
  -c "shutdown"
```

The v3.3.0 image has flashed successfully with this command.

## Serial Verification

Expected text line while using the current verification build:

```text
OFRAW,1,seq,uptime_us,dt_us,ax_mg,ay_mg,az_mg,gx_mdps,gy_mdps,gz_mdps,roll_cdeg,pitch_cdeg,yaw_cdeg,qw_1e6,qx_1e6,qy_1e6,qz_1e6,shot_count
```

The IMU loop is configured for 416 Hz. The verification serial stream prints every eighth sample so 115200 baud can keep up:

```text
Firmware sample rate: 416 Hz
Text serial rate:     about 52 Hz
Baud:                 115200
```

PowerShell serial probe. Open COM11 with DTR/RTS asserted, then reset the target while the port is still open:

```powershell
$job = Start-Job -ScriptBlock {
  $port = New-Object System.IO.Ports.SerialPort "COM11",115200,None,8,One
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
  -c "adapter serial 463D5515" `
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
# sample_hz: 416
# ui: user LED status, user button calibration
# IMU ready: lsm6ds3tr-c@6a, accel+gyro 416 Hz
OFRAW,1,0,181088,2403,790,-625,49,521,-678,-1431,-1,-2,0,1000000,-108,-165,-30,0
```

## BLE Verification

The firmware advertises as:

```text
OpenFloat-463D
```

Custom OpenFloat GATT UUIDs:

```text
Service: 8f3f3b10-0f5a-4f4c-9a2d-000000000001
Live:    8f3f3b10-0f5a-4f4c-9a2d-000000000002
Control: 8f3f3b10-0f5a-4f4c-9a2d-000000000003
```

The BLE live characteristic notifies ten compact 20-byte binary frames per notification, for a 200-byte payload and a target cadence of about 100 notifications/s:

```text
magic[2]="OF", proto u8, type u8, seq u16, dt_us u16,
accel_mg int16[3], gyro_dps_q4 int16[3]
```

The BLE control characteristic accepts ASCII commands:

```text
start       Enable live notifications
stop        Disable live notifications
zero        Acknowledge a zeroing request; user button still owns live zeroing
thresh:<g>  Set shot detection threshold in g, clamped to 2.0-30.0
```

The host-side test client lives in the web repo:

```text
C:\Users\metzd\Documents\GitHub\Open-Float-Archery\tools\openfloat_ble_client.py
```

Install/use:

```powershell
python -m pip install bleak
python tools\openfloat_ble_client.py --name-prefix OpenFloat --scan-timeout 15 --duration 6
```

Current BLE verification status:

```text
Windows found OpenFloat-463D at DB:92:7D:1C:E9:DA.
The client connected to the custom live UUID.
Decoded 200-byte notifications were received; each contained ten averaged 20-byte frames.
Serial banner confirmed imu_odr_hz=6664 and ble_output_hz=1000 averaged samples/s.
Raw-register IMU path configured the LSM6DS3TR-C directly over I2C at 6664 Hz ODR, accel +/-16 g, gyro +/-2000 dps.
Final high-rate checked run: frames=7500, lost=0, elapsed=8.6s, rate=873.0 Hz, notifications=750, notify_rate=87.3 Hz, bytes=150000, bytes_per_s=17461.
```

The Python client uses `--sequence-step 1` by default because each decoded BLE frame represents one IMU sample. Do not treat the intentional sequence stride as packet loss.

The 1000 Hz averaged BLE mode is currently a throughput experiment, not a validated capture rate. The IMU accepts the requested 6664 Hz ODR and BLE carries 200-byte notifications without sequence loss, but the raw I2C polling loop measured about 873 averaged frames/s. Reaching the 1000 Hz target likely needs the LSM6DS3TR-C FIFO/data-ready path so multiple raw samples can be drained per I2C transaction.
On Windows, include `--reset-command start` in automated BLE tests to match the browser adapter's control write after subscribing:

```powershell
python tools\openfloat_ble_client.py --name-prefix OpenFloat --scan-timeout 12 --duration 8 --reset-command start
```

One Windows-specific caveat remains: after the Python/Bleak client exits, Windows may hold the BLE connection for a while. In that state immediate rediscovery by scanning can fail even though serial continues streaming and the firmware remains alive. The firmware restarts advertising in its `disconnected` callback, so if a real disconnect reaches the device it should advertise again. For repeat automated tests on this host, resetting the module through OpenOCD before the next scan is currently the reliable path.

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
