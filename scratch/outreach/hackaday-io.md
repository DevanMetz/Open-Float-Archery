# Hackaday.io — project page + tip submission

## Project page

**Title:** OpenFloat — Open-Source Bow Telemetry at 1110 Hz over BLE

**Summary (short description field):**
A tiny BLE sensor (Seeed XIAO nRF54L15 Sense, Zephyr) that mounts on a bow
riser and streams ~1110 Hz motion data to a local-first web dashboard. It
detects shots, scores your aiming hold, release, and follow-through, and
replays every shot as a phase-colored trace — no app, no account, no cloud.

**Details (long description):**

OpenFloat started with a simple question: what does an archer's pin float
actually look like in the second before release? Answering it well needs a
high sample rate, which is where the engineering story got interesting.

**The I2C wall.** The XIAO's LSM6DS3TR-C IMU maxes out at 6664 Hz ODR, and the
first experiment ran it there. BLE kept up — a 40 s run received 40,080
1 ms frames with zero sequence loss — but the IMU is I2C-only on this board,
and a 1 MHz I2C bus cannot drain ~80 KB/s of FIFO data. The FIFO overran about
once per second, and every overrun spliced a corrupted sample into the stream
(|a| = 0.41 g with a single phantom ~111 dps gyro axis — exactly the kind of
artifact that poisons a shot-detection algorithm).

**The fix.** Two parts: drop the ODR to 3332 Hz so the bus has headroom, and
replace busy-polling with an interrupt-driven FIFO watermark (INT1) that
drains a whole batch in one I2C burst per interrupt, then averages 3 raw
samples per output frame (~1110 frames/s over BLE, six 20-byte frames batched
per 120-byte notification). The decode validates a linear word counter against
the FIFO pattern register, so a desync discards a partial sample instead of
splicing two time periods into one frame. A 25 s validation run received
28,670 frames, lost 0, at 1129 Hz — 0 FIFO overruns, 0 resyncs, 0 outlier
frames. CPU load dropped from ~51% (busy-poll) to ~35% active.

**Surviving the real world.** Bows get carried out of range mid-session, so
shots are buffered on-device and persisted to RRAM (Zephyr Settings/ZMS):
shot counts, trace windows, and a stored-shot queue survive deep-sleep power
loss and upload on reconnect. The RRAM write is deferred while a live BLE
frame was just delivered, so streaming doesn't pay a flash-write tax per shot.
An on-board Madgwick filter makes quaternions the canonical orientation
(goodbye gimbal lock in the 3D bow view), and the PDM microphone captures a
release/impact envelope that the app uses to estimate target distance from
time-of-flight.

**The browser is the app.** The dashboard is plain ES modules — no build step,
no npm — using Web Bluetooth, with IndexedDB for local-first storage and a PWA
service worker for offline use. It renders a live 3D bow, a bubble level, and
phase-colored shot replays with a versioned Float Score. A demo with real
captured shots loads without any hardware.

Everything is MIT (firmware carries Apache-2.0 SPDX headers): firmware, web
app, tools, and docs. v0.1.0 ships a CI-built `merged.hex`, so a first flash
is ~10 minutes instead of an hour of toolchain setup.

- Repo: https://github.com/DevanMetz/Open-Float-Archery
- Live demo (no hardware): https://openfloatarchery.com
- Release: https://github.com/DevanMetz/Open-Float-Archery/releases/tag/v0.1.0

## Tip line (tips@hackaday.com)

Subject: Open-source bow telemetry: beating a 1 MHz I2C ceiling for 1110 Hz
zero-loss BLE streaming

Body: OpenFloat is an open-source archery sensor (XIAO nRF54L15 + Zephyr)
with a fun constraint story: the IMU's 6664 Hz mode silently corrupted one
sample per second because the I2C bus couldn't drain the FIFO, so the fix was
an interrupt-driven watermark at 3332 Hz — validated at 28,670 BLE frames /
0 lost / 0 overruns. Shots persist to RRAM through power loss and upload on
reconnect, and the whole dashboard is a buildless Web Bluetooth PWA.
Project: https://github.com/DevanMetz/Open-Float-Archery — live demo at
https://openfloatarchery.com.
