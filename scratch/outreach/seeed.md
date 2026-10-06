# Seeed Studio submission

Channels (any/all):
- Seeed "Make It Real" / XIAO project showcase form on seeedstudio.com
- forum.seeedstudio.com → Projects category
- X/Twitter tag @seeedstudio (they reshare XIAO builds)

## Submission blurb

**Title:** OpenFloat: XIAO nRF54L15 Sense as a 1110 Hz bow-mounted telemetry
sensor

**Project description:**

OpenFloat turns the XIAO nRF54L15 Sense into a complete archery training
system: the board mounts on a bow riser, samples its onboard LSM6DS3TR-C IMU
at 3332 Hz via an interrupt-driven FIFO watermark, runs a Madgwick filter and
shot detection on-device, and streams ~1110 averaged frames/s over BLE to an
open-source web dashboard (Web Bluetooth, no app install). The onboard PDM
microphone captures the release and target-impact sounds, which the app uses
to estimate shooting distance from time of flight.

The XIAO was a great fit: the Sense variant's IMU + mic combination covers
both sensing jobs, nRF54L15 BLE sustains the full-rate stream with zero loss
in validation runs (28,670 frames / 0 lost / 1129 Hz), RRAM persists shots
through battery disconnects, and the form factor is small enough to live on a
riser without affecting the shot. Firmware is Zephyr / nRF Connect SDK v3.3.0
using the built-in `xiao_nrf54l15` board target.

Everything is open source (MIT): firmware, web app, validation tools, and a
prebuilt firmware image on the GitHub release so other XIAO owners can try it
with a ~10 minute flash instead of a toolchain install.

- Repo: https://github.com/DevanMetz/Open-Float-Archery
- Live demo with real captured shots: https://openfloatarchery.com
- Build guide: docs/quick-start.md + firmware/BUILDING.md in the repo

**One ask:** the project currently flashes over the CMSIS-DAP debug interface
with OpenOCD; if Seeed has reference material for shipping XIAO nRF54L15
firmware to non-developers (or wants to feature the project), I'd love to
connect.

## Notes

- Attach the riser-mounted sensor photo and a dashboard screenshot/GIF when
  available — Seeed's blog picks are image-driven. (Same assets as the README
  image spots; do the screenshot task first if possible.)
