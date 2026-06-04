# Open-Float-Archery

OpenFloat Archery is a local-first browser dashboard plus Zephyr/NCS firmware
for bow-mounted IMU telemetry on the Seeed XIAO nRF54L15 Sense.

## Open the Web App

Serve the repo root over localhost so native ES modules, Web Serial, and Web
Bluetooth are available:

```powershell
python -m http.server 4178
```

Then open:

```text
http://localhost:4178/
```

Use Chrome or Edge for Web Serial and Web Bluetooth. The demo stream works
without hardware.

## Current Firmware Status

- IMU raw-register FIFO path runs the LSM6DS3TR-C at 3332 Hz ODR, read via an
  interrupt-driven FIFO watermark on INT1 (P0.02). (An earlier experiment used
  the 6664 Hz max ODR, but the 1 MHz I2C bus could not drain it without ~1/s
  FIFO overruns that corrupted a sample around each overrun.)
- Each output frame averages 3 raw samples (~0.9 ms), giving ~1110 distinct
  averaged frames/s; no frames are duplicated to pad the rate.
- Shot detection persists a lifetime shot count to RRAM (Zephyr Settings/ZMS),
  restores it on boot, and notifies the web app on every increment (and on
  connect). Correct it over BLE with `shotset:<n>` or clear with `shotreset`.
- Firmware keeps the newest 100 compact shot records in nonvolatile storage and
  uploads them to the browser on reconnect. The web app acknowledges each shot
  only after IndexedDB save, then firmware frees that stored slot.
- BLE notifications batch ten 20-byte frames into about 200 bytes each.
- Latest Windows/Bleak validation received 28,670 sequential frames with zero
  sequence loss over 25.5 s; warm-up-excluded rate was about 1129 Hz, with
  0 FIFO overruns, 0 resyncs, 0 outlier frames, and 100% distinct frames
  (|a| held 0.814-1.179 g).
- CPU load during the interrupt-driven loop measured about 35% active, leaving
  about 65% idle (down from ~51% with busy-polling).

## BLE Telemetry Test Client

The host-side BLE validation script is:

```text
tools/openfloat_ble_client.py
```

Install its Python dependency:

```powershell
python -m pip install bleak
```

On this Windows test host, Bleak may be installed in the local dependency folder
used during bring-up. If the script cannot import `bleak`, run commands with:

```powershell
$env:PYTHONPATH='C:\tmp\openfloat-pydeps'
```

Scan for an OpenFloat BLE peripheral and print decoded telemetry:

```powershell
python tools\openfloat_ble_client.py --name-prefix OpenFloat --every
```

Run for 30 seconds and save decoded samples:

```powershell
python tools\openfloat_ble_client.py --duration 30 --csv openfloat_ble_capture.csv
```

Run a steady-state throughput validation (~1100 Hz) after BLE warm-up:

```powershell
$env:PYTHONPATH='C:\tmp\openfloat-pydeps'
python tools\openfloat_ble_client.py --name-prefix OpenFloat --scan-timeout 12 --duration 20 --warmup 5 --reset-command start
```

If the first firmware bring-up uses Nordic UART Service instead of the custom
OpenFloat GATT UUIDs, add `--nus`:

```powershell
python tools\openfloat_ble_client.py --nus --name-prefix OpenFloat --every
```

## Supabase Schema Updates

If cloud sync reports unsupported `shots` fields, add the current local shot
metadata columns in the Supabase SQL editor:

```sql
alter table public.shots
  add column if not exists device_shot_id integer,
  add column if not exists shot_score numeric,
  add column if not exists stored_upload boolean default false;

create unique index if not exists shots_device_shot_id_unique
  on public.shots (device_id, device_shot_id)
  where device_shot_id is not null;

notify pgrst, 'reload schema';
```
