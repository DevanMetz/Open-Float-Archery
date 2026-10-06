First tagged release of OpenFloat Archery: an open-source bow telemetry sensor (Seeed XIAO nRF54L15 Sense, Zephyr / nRF Connect SDK v3.3.0) paired with a local-first web dashboard — no app store, no account, no cloud required.

## Prebuilt firmware

**`openfloat-v0.1.0-xiao-nrf54l15-merged.hex`** (attached) is a ready-to-flash image built by CI from this tag's source — no NCS toolchain install needed. Flash it to a XIAO nRF54L15 Sense over the CMSIS-DAP debug interface with OpenOCD, following [firmware/BUILDING.md](https://github.com/DevanMetz/Open-Float-Archery/blob/v0.1.0/firmware/BUILDING.md#flash). This drops a first build from roughly an hour of toolchain setup to about ten minutes of flash-and-connect.

After flashing, the board advertises as `OpenFloat-XXXX`; connect from the hosted app at [openfloatarchery.com](https://openfloatarchery.com) (Chrome/Edge, Web Bluetooth) using the status badge in the header.

## What's in v0.1.0

**Firmware**
- 3332 Hz IMU sampling via interrupt-driven FIFO watermark, averaged to ~1110 frames/s over BLE (120-byte notifications batching six 20-byte v2 live frames)
- On-board Madgwick filter; quaternions are the canonical orientation value
- Shot detection with PDM microphone envelope capture
- Offline shot storage in RRAM with dropped-shot recovery, stalled-upload retries, and 32-bit shot IDs
- ASCII control-command set (thresholds, trace rates, calibration, shot trigger) — see [docs/reference/ble-commands.md](https://github.com/DevanMetz/Open-Float-Archery/blob/v0.1.0/docs/reference/ble-commands.md)

**Web app** (plain ES modules, no build step; installable PWA that works offline)
- Live dashboard: bubble level, quaternion-driven 3D bow visualizer, ~1110 Hz trace
- Pin Float shot review: phase-colored trace, sigma ellipse, replay scrubber, shot compare, and versioned Float Score (`openfloat-float-score-v1`)
- Saved-shot history auto-grouped into practice sessions with score-trend review
- Steady Aim hold training, bow profiles, Bow Shop 3D customization
- Local-first IndexedDB storage with JSON export/import; optional Supabase sync
- Demo shots from real captures load on first visit — explore without hardware

**Project**
- GitHub Actions CI: web unit tests, Python tool checks, and the Zephyr firmware build that produced the attached image

## Known limitations

- Web Bluetooth requires Chrome or Edge (no Firefox/Safari, including all iPhones)
- Battery life under full-rate streaming is not yet characterized
- No BLE OTA updates yet — firmware updates require the debug probe
- Enclosure/mount design is still in progress (fit-test body only)
