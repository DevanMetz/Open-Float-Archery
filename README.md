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

## Repository Layout

- `index.html`, `styles.css`, `manifest.json`, and `service-worker.js` are the
  static browser app shell and PWA assets.
- `app/` contains native ES modules with no build step: protocol parsing,
  device adapters, IndexedDB storage, telemetry scoring/sync, and UI rendering.
- `firmware/` is the Zephyr/NCS app for the Seeed XIAO nRF54L15 Sense.
- `tools/` contains host-side validation utilities, including the BLE client and
  follow-through trace verifier.
- `Blender/` and `FreeCAD/` contain visual/mechanical assets used by the app and
  enclosure work.
- `Blueprint.md` is the detailed architecture and implementation status.

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
- Buffered shot traces now freeze after a configurable follow-through delay
  (default 1.5 s, set over BLE with `followms:<ms>`) so stored traces include
  both pre-shot hold and post-release recovery.
- Fresh firmware defaults disconnected deep sleep to 300 s. Existing persisted
  settings can override it; update devices with `sleeptime:<s>` or the dashboard
  sleep slider.
- BLE notifications batch seven 28-byte frames (containing on-board quaternions)
  into 196-byte notifications. The same 28-byte envelope also carries shot,
  count-sync, storage-status, stored-shot, and trace-chunk frames.
- Latest Windows/Bleak validation received 28,670 sequential frames with zero
  sequence loss over 25.5 s; warm-up-excluded rate was about 1129 Hz, with
  0 FIFO overruns, 0 resyncs, 0 outlier frames, and 100% distinct frames
  (|a| held 0.814-1.179 g).
- CPU load during the interrupt-driven loop measured about 35% active, leaving
  about 65% idle (down from ~51% with busy-polling).
- **On-Chip Battery Monitoring**: Exposes standard BLE Battery Service (BAS, UUID `0x180F`) and Level characteristic (`0x2A19`). Measures battery level percentage from pin `P1.14/AIN7_VBAT` (divider $2.0$) using the dynamic power switch regulator `vbat_pwr` (`P1.15`) to save power.
- **Bow Orientation Calibration**: Supports zeroing pitch and roll calibration values via the control BLE command `zero` or browser dashboard button. Offsets are saved persistently in Settings RRAM (`"cant_offset"`, `"pitch_offset"`) and loaded automatically on boot.
- **Configurable Wake-up & Sleep Settings**: Allows tuning wake-up sensitivity (`wakesens:<g>`), deep sleep timeout (`sleeptime:<s>`), and active sleep movement sensitivity (`sleepsens:<g>`) via BLE commands, stored in Settings RRAM.
- **Release Recoil Signature Filtering**: Checks gyroscope dynamic magnitude squared ($\ge 1.5\text{ rad/s}$ / $85^\circ\text{/s}$ minimum recoil velocity) during acceleration peaks to filter out accidental arrow bumps, bow drops, or setting the device down.

## Current Browser Dashboard Status

- Live calibration views include a calibrated digital bubble level and a 3D bow
  orientation visualizer. Both apply the current zero offsets before rendering,
  so a properly zeroed bow appears level.
- **On-Device Orientation Processing**: Consumes high-rate Madgwick filter quaternions directly from BLE notifications, avoiding client-side complementary filter lag.
- Pin Float shot review shows phase-colored traces (green aiming hold,
  amber/red release break, and gray follow-through), centered on the point of
  shot detection so the release reticle sits at the center of the target face.
- The shot review canvas also renders a 1-sigma float ellipse, release reticle,
  and an animated replay marker. The replay controls live in their own sections
  below the target (not overlapping it): a Trace Review banner and a full-width
  scrubber with a circular play/pause button, a phase-colored timeline, an
  adjustable replay speed (0.25×-4×), and scroll-wheel (desktop) or pinch
  (mobile) zoom directly on the trace.
- **Live Shot Traces**: While the device is connected, the browser captures each
  shot's trace from the live stream and saves it shortly after the
  follow-through window completes; the device itself only stores traces for
  shots taken while disconnected, which then upload on reconnect.
- **Stored-Shot Upload Indicator**: When a device that buffered shots while
  disconnected reconnects, an inline "Uploading N" status appears beside the
  live rate and shot counter and counts down as the backlog transfers.
- **Configurable Device Settings**: The Settings view can send threshold,
  wake/sleep, trace buffer, follow-through, BLE stream-rate, NVS buffering, and
  auto-sleep commands over BLE. Settings are cached locally and persisted on the
  device when firmware supports the command.
- **Bow Profile Manager**: Organize and save stabilizer configurations, draw weights, and notes under custom bow profiles.
- **Automatic Practice Sessions**: Saved shots are grouped into collapsible sessions automatically by timestamp — any gap longer than 30 minutes starts a new session. Rename any session and assign the bow used directly from the Saved Shots view.
- **Manual Long-Trace Recording**: A Record button inline with the Shot Sequence Trace title starts, stops, and saves custom-length telemetry captures of arbitrary duration — useful for capturing full ends or holding drills.
- **Shot Comparison in Trace Review**: While reviewing any saved shot on the Pin Float target, use **Compare with** to overlay another shot (release-centered, matched scale) on the same replay scrubber.
- **Interactive Connection Badge**: Easily toggle sensor connection by clicking the connection status badge in the top left of the header.
- **Offline PWA Support**: Registers a service worker to cache application assets (markup, styling, scripts, and the 3D model GLB), enabling full offline operation at remote archery ranges.
- **Optional Supabase Sync**: The Cloud modal accepts a Supabase URL and anon key
  for self-hosted sync. Local IndexedDB writes remain the source of truth and are
  queued before upload; leaving cloud settings blank keeps the app local-only.

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

On Windows, the client keeps the scanned BLE device object for name/prefix
matches before connecting, which is more reliable than reconnecting by address
alone. If an older persisted sleep timeout is still short, reset the module and
use a short scan timeout immediately after reset.

Verify delayed trace freeze behavior without hardware:

```powershell
python tools\verify_follow_through_trace.py
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
  add column if not exists stored_upload boolean default false,
  add column if not exists hold_stability numeric,
  add column if not exists release_quality numeric,
  add column if not exists follow_through numeric;

create unique index if not exists shots_device_shot_id_unique
  on public.shots (device_id, device_shot_id)
  where device_shot_id is not null;

notify pgrst, 'reload schema';
```

## Safety

OpenFloat Archery is an experimental, hobby/educational telemetry project, not a
safety device. Do not rely on it for any safety-critical decision. Always follow
normal archery range safety rules. Mount the sensor securely so it cannot become
a projectile or interfere with the bow; an improperly mounted accessory can fail
under release shock. You are responsible for the safe use of your equipment.

## License and Attribution

This project is licensed under the MIT License (see `LICENSE`); firmware sources
additionally carry `Apache-2.0` SPDX headers. Third-party software, algorithms,
and platform components are credited in `THIRD_PARTY_NOTICES.md`. If you
redistribute or build on this project, preserve upstream copyright and license
headers and keep the notices file accurate.

OpenFloat Archery is an independent, open-source project. It is not affiliated
with, endorsed by, or derived from any commercial archery-electronics product or
its maker, and all third-party product and company names are the property of
their respective owners.
