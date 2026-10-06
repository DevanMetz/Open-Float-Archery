# Show HN draft

## Title (80 char limit; pick one)

1. Show HN: OpenFloat – open-source bow telemetry, 1110 Hz over BLE to a web app
2. Show HN: I built an open-source archery sensor that streams 1110 Hz to the browser
3. Show HN: Bow-mounted IMU + Web Bluetooth dashboard for analyzing archery shots

(1 is the safest HN register: plain, names the thing, has one concrete number.)

**URL:** https://github.com/DevanMetz/Open-Float-Archery

## First comment (post immediately after submitting)

I shoot archery and wanted to see what my pin float actually looks like — the
wander of the aim point in the last second before release. So I built
OpenFloat: a small sensor (Seeed XIAO nRF54L15 Sense, Zephyr) that mounts on
the riser and streams ~1110 Hz of motion data over BLE to a web dashboard. It
detects the shot from the release impulse, splits the trace into hold /
release / follow-through phases, and scores each one. There's a live demo
with real captured shots at https://openfloatarchery.com — no hardware needed.

A few things that might interest HN:

The hard part was the I2C bus, not BLE. The IMU does 6664 Hz, and BLE happily
carried it (40 s, 40,080 frames, zero sequence loss) — but the IMU is
I2C-only on this board and a 1 MHz bus can't drain ~80 KB/s of FIFO, so it
overran about once a second and each overrun injected one corrupted sample.
Silent data corruption at 1 Hz is the worst kind of bug for a shot detector.
The fix: 3332 Hz ODR plus an interrupt-driven FIFO watermark that drains a
batch per interrupt in one I2C burst, with the decode validated against the
FIFO pattern register so a desync drops a partial sample instead of splicing
two time periods together. Validation run: 28,670 frames, 0 lost, 0 overruns,
0 outliers, at 1129 Hz.

The web app is deliberately boring tech: plain ES modules, no build step, no
framework, no npm. Web Bluetooth in, IndexedDB for storage, a service worker
for offline, three.js (the one dependency, loaded for the 3D bow view). Your
shot data never leaves the machine unless you opt into sync.

Shots survive disconnects: the firmware persists shot records and trace
windows to RRAM through deep-sleep power loss and uploads them when you walk
back into range.

Honest limitations: Web Bluetooth means Chrome/Edge only (no Safari, so no
iPhones); battery life under full-rate streaming isn't characterized yet; OTA
updates aren't implemented, so reflashing needs a debug probe. v0.1.0 has a
CI-built hex attached, so a first flash is ~10 minutes.

Happy to answer questions about Zephyr, the FIFO watermark path, Web
Bluetooth quirks, or whether any of this makes you better at archery (early
answer: it makes you *honest* about your hold).

## Notes

- Post morning US time, weekday. Don't submit the same week as the Hackaday
  tip — space them so each gets its own traffic.
- HN guideline: it's fine that a store link exists, but lead with the open
  source, not the product.
