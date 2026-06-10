# Feature Status

This page is the detailed, shipped-feature inventory for OpenFloat Archery —
what the firmware and browser dashboard actually do today. For the system
architecture, design intent, and forward-looking targets, see
[`Blueprint.md`](../Blueprint.md). For setup, see
[Quick Start](quick-start.md); for the BLE control vocabulary, see
[BLE Control Commands](reference/ble-commands.md).

---

## Firmware

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
  only after IndexedDB save, then firmware frees that stored slot. Every shot is
  queued the moment it is detected (even while connected), so a dropped live
  shot notification is recovered via the same ack/retry path without a
  reconnect. The nonvolatile write is deferred a few seconds and skipped when
  the browser acks in time, so RRAM is written only when a live frame was lost.
- Buffered shot traces now freeze after a configurable follow-through delay
  (default 1.5 s, set over BLE with `followms:<ms>`) so stored traces include
  both pre-shot hold and post-release recovery. Firmware trace points and
  browser `shot_traces` records now store microphone envelope samples (`micAmp`
  per motion point plus a full-rate `mic_series` window on connected shots).
- Fresh firmware defaults disconnected deep sleep to 300 s. Existing persisted
  settings can override it; update devices with `sleeptime:<s>` or the dashboard
  sleep slider.
- The default firmware config is battery-safe and disables the USB UART console
  so the XIAO nRF54L15 can boot from Li-ion battery power. For USB bench logs,
  build with the `firmware/prj_uart.conf` overlay.
- BLE notifications batch six 29-byte frames (on-board quaternions plus a
  microphone peak-envelope byte) into 174-byte notifications. The same 29-byte
  envelope also carries shot, count-sync, storage-status, stored-shot, and
  trace-chunk frames.
- **On-Chip Microphone Envelope**: The XIAO Sense PDM microphone runs at 16 kHz
  in a dedicated audio thread. Audio is read in **14-sample blocks** (~1143
  envelope updates/s), aligned with the ~1110 Hz IMU/BLE stream. A
  noise-floor-subtracted peak follower with a **5 ms decay** packs a scaled
  envelope byte into each live BLE frame (offset 28, firmware scale divisor 3,
  range 0–255) for dashboard acoustic metering without extra bandwidth.
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

## Browser Dashboard

- Live calibration views include a calibrated digital bubble level and a 3D bow
  orientation visualizer. Both apply the current zero offsets before rendering,
  so a properly zeroed bow appears level.
- **On-Device Orientation Processing**: Consumes high-rate Madgwick filter quaternions directly from BLE notifications, avoiding client-side complementary filter lag.
- **Live Acoustic Envelope Meter**: When connected, the dashboard header shows a
  clicker/volume bar driven by the firmware microphone envelope byte in each live
  frame (~1110/s). The meter reflects the on-device peak follower (5 ms decay),
  not raw PCM.
- Pin Float shot review shows phase-colored traces (green aiming hold,
  amber/red release break, and gray follow-through), centered on the point of
  shot detection so the release reticle sits at the center of the target face.
- **OpenFloat Float Score**: The browser computes an independent, open-source
  0-100 form score from trace data. The score blends hold stability, release
  quality, follow-through control, and level consistency. It is versioned in
  saved shots as `openfloat-float-score-v1` so future scoring changes can be
  compared safely.
- The shot review canvas also renders a 1-sigma float ellipse, release reticle,
  and an animated replay marker. The replay controls live in their own sections
  below the target (not overlapping it): a Trace Review banner and a full-width
  scrubber with a circular play/pause button, a phase-colored timeline, an
  adjustable replay speed (0.25×-4×), and scroll-wheel (desktop) or pinch
  (mobile) zoom directly on the trace.
- **Live Shot Traces**: While the device is connected, the browser captures each
  shot's trace from the live stream and saves it shortly after the
  follow-through window completes. Connected captures keep about 3.5 seconds of
  pre-shot hold plus the configured follow-through window, while the 20-second
  rolling buffer is only used as browser-side retention headroom. BLE shot
  events include the live sample sequence from detection, so connected traces
  align motion and microphone envelope data to the device-side release sample
  instead of browser notification receipt time. The device itself only stores
  traces for shots taken while disconnected, which then upload on reconnect.
- **Session Review**: Saved shots are grouped into practice sessions and each
  session summarizes average Float Score, best and worst shot, consistency
  trend, shots by drill label, and the biggest recurring issue. A compact plot
  shows Float Score progression across the session.
- **Battery Badge**: When the BLE device exposes the standard Battery Service,
  the dashboard reads Battery Level and displays it in the header.
- **Stored-Shot Upload Indicator**: When a device that buffered shots while
  disconnected reconnects, an inline "Uploading N" status appears beside the
  live rate and shot counter and counts down as the backlog transfers.
- **BLE Link Recovery**: If the radio link drops, the firmware retries advertising and the browser attempts to reconnect automatically.
  - **Firmware-side Retry**: Upon disconnection, the firmware schedules BLE advertising via a delayable work queue after a 250 ms delay, retrying every 1000 ms if the stack is not ready, and cancels retries once a connection is re-established.
  - **Stale Link Cleanup**: If a BLE client disables live notifications without closing the connection, the firmware disconnects that idle central after a short grace period so the sensor can advertise again.
  - **Browser-side Reconnection**: If the link drops unexpectedly, the web app updates the status badge to `"BLE reconnecting..."` and retries connection up to 6 times using an exponential backoff strategy (`Math.min(1000 * 2^attempts, 8000)` ms, i.e., 1s, 2s, 4s, 8s, 8s, 8s). If reconnection succeeds, the live stream is restored; if all 6 attempts fail, it reverts to `"Disconnected"`, prompting the user to manually click the status badge to search again.
- **Configurable Device Settings**: The Settings view can send threshold,
  wake/sleep, trace buffer, follow-through, BLE stream-rate, NVS buffering, and
  auto-sleep commands over BLE. Settings are cached locally and persisted on the
  device when firmware supports the command.
- **Bow Profile Manager**: Organize and save stabilizer configurations, draw weights, and notes under custom bow profiles.
- **Automatic Practice Sessions**: Saved shots are grouped into collapsible sessions automatically by timestamp — any gap longer than 30 minutes starts a new session. Rename any session and assign the bow used directly from the Saved Shots view.
- **Manual Long-Trace Recording**: A Record button inline with the Shot Sequence Trace title starts, stops, and saves custom-length telemetry captures of arbitrary duration — useful for capturing full ends or holding drills.
- **Shot Comparison in Trace Review**: While reviewing any saved shot on the Pin Float target, use **Compare with** to overlay another shot (release-centered, matched scale) on the same replay scrubber.
- **Interactive Connection Badge**: Easily toggle sensor connection by clicking the connection status badge in the top left of the header.
- **Steady Aim Training**: The Steady Aim tab runs a guided hold drill with a
  5-second draw countdown, configurable hold duration (5–30 s), live Pin Float
  tracing, steadiness scoring (sigma ellipse, cant/pitch deviation, max float),
  coaching feedback, and optional save to IndexedDB as a labeled practice shot.
- **Bow Shop 3D Customization**: The Bow Shop tab loads `Blender/BowModel.glb`
  and creates color pickers from the named compound-bow materials in the GLB.
  Current bow materials are `string`, `cam`, `riser`, `grip`, and `text`; color
  choices are cached locally and applied to the dashboard and alignment 3D
  previews. The GLB also contains a named `MCU` object, which the app detaches
  from the scene and uses as the live XIAO module preview.
- **Consolidated Settings**: Full-width Power Management and Telemetry & Buffer cards sit at the top, followed by a combined, collapsible **Sensor & 3D Alignment** card that pairs the sensor mount axis mapping (which changes the data) with the 3D model display (visual only) under one shared 3D preview. Connecting and zeroing live on the header badge and dashboard, so a separate connection card is no longer needed.
- **Offline PWA Support**: Registers a service worker to cache application assets (markup, styling, scripts, and the 3D model GLB), enabling full offline operation at remote archery ranges.
- **Local Data Backup & Restore**: A Settings card exports every locally stored shot, trace, session override, and bow profile to a single JSON file, and imports one back (merging by key). Fully local — no account needed — so field-test data is portable between devices and easy to back up.
- **Single Shot Export**: You can export individual shots along with their telemetry trace to a standalone JSON file. This is accessible via the "Export Shot" button in the Trace Review banner on the Dashboard, or via the export icon (📤) next to any shot in the Saved Shots history list. This makes it easy to share specific shots for analysis.
- **Optional Supabase Sync**: The Cloud modal accepts a Supabase URL and anon key
  for self-hosted sync. Local IndexedDB writes remain the source of truth and are
  queued before upload; leaving cloud settings blank keeps the app local-only.
