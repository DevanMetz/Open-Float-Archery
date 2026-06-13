# Quick Start

Build an OpenFloat sensor, flash the firmware, and stream live telemetry to this
web app. Budget about an hour for a first build; most of that is installing the
firmware toolchain once.

---

## 1. What you need

**Hardware**

- **Seeed Studio XIAO nRF54L15 Sense** — the microcontroller + BLE + onboard
  IMU (`LSM6DS3TR-C`) and PDM microphone. This is the whole brain of the device.
- **3.7 V LiPo battery**, ~70 mAh, with a protection circuit, for untethered
  range use. (You can also run from USB power during bring-up.)
- **Mounting putty** — a small ball of removable adhesive putty is enough to
  stick the board to the bow. Mount repeatability affects data quality.
- **USB-C cable** to connect the XIAO to your computer for flashing.

**Software**

- A **Chromium browser** (Chrome or Edge) — Web Bluetooth is required and is not
  available in Firefox or Safari.
- The **nRF Connect SDK (NCS) v3.3.0** toolchain, to build the firmware. The
  XIAO nRF54L15 board is built in to NCS v3.3.0 — no external board package
  needed.
- **OpenOCD** to flash the build over the board's CMSIS-DAP debug interface.

> You only install the firmware toolchain once. After that, reflashing is a
> two-command loop.

---

## 2. Assemble the hardware

1. Solder the battery leads (or a JST connector) to the XIAO's `BAT+` / `BAT-`
   pads, observing polarity. Skip this if you only plan to run from USB.
2. Press a small ball of mounting putty onto the bow and firmly seat the board
   on it so it sits rigidly — any flex or wobble shows up as noise in the trace.
   Make sure it is stuck securely enough that it **cannot become a projectile**
   or interfere with the bow under release shock.
3. Note the board's orientation on the bow. You will square it up later with the
   in-app axis mapping and the **Zero Calibration** button — it does not have to
   be perfectly aligned mechanically.

> **Safety:** OpenFloat is an experimental hobby/educational project, not a
> safety device. Always follow normal range safety rules.

---

## 3. Build the firmware

> **Skip this step entirely** by downloading the prebuilt `merged.hex` from the
> [latest GitHub release](https://github.com/DevanMetz/Open-Float-Archery/releases/latest)
> — CI builds it from the tagged source. You still need OpenOCD to flash
> (step 4), but not the NCS toolchain.

The firmware lives in `firmware/` and targets
`xiao_nrf54l15/nrf54l15/cpuapp`. Build it with the NCS v3.3.0 toolchain. On a
typical Windows install the tested command is:

```powershell
& "C:\ncs\toolchains\b8b84efebd\nrfutil\bin\nrfutil.exe" toolchain-manager launch `
  --ncs-version v3.3.0 `
  --chdir "C:\ncs\v3.3.0" `
  -- west build `
  -p always `
  -b xiao_nrf54l15/nrf54l15/cpuapp `
  -d "firmware\build-v3.3.0" `
  "firmware"
```

A successful build produces:

```text
firmware/build-v3.3.0/merged.hex
```

The default config is **battery-safe**: it disables the USB UART console so the
board can boot from LiPo power. If you want serial logs on the bench, add the
USB overlay:

```powershell
-DOVERLAY_CONFIG=prj_uart.conf
```

> These two warnings are expected and harmless:
> `SB_CONFIG_PARTITION_MANAGER ... deprecated` and
> `BT_HCI_TX_STACK_SIZE was assigned 2048 but got 1536`.

For the complete build, flash, and verification guide — including the USB
serial overlay and tuning knobs — see [firmware/BUILDING.md](../firmware/BUILDING.md).

---

## 4. Flash the firmware

Connect the XIAO over USB and flash `merged.hex` with OpenOCD over the board's
CMSIS-DAP probe:

```powershell
openocd `
  -s "<seeed-support>/boards/arm/xiao_nrf54l15/support" `
  -s "C:/Program Files/OpenOCD/share/openocd/scripts" `
  -c "adapter serial <YOUR_PROBE_SERIAL>" `
  -f "<seeed-support>/boards/arm/xiao_nrf54l15/support/openocd.cfg" `
  -c "init" `
  -c "reset init" `
  -c "nrf54l-load firmware/build-v3.3.0/merged.hex" `
  -c "verify_image firmware/build-v3.3.0/merged.hex" `
  -c "reset run" `
  -c "shutdown"
```

Replace `<YOUR_PROBE_SERIAL>` with your probe's CMSIS-DAP serial and
`<seeed-support>` with the path to the Seeed support files. When it finishes,
the board resets and the new firmware runs immediately.

---

## 5. Verify it is running

After flashing, the firmware advertises over BLE as **`OpenFloat-XXXX`** and
blinks the user LED. You are ready for the web app.

If you built with the USB UART overlay, you can also confirm boot over serial at
**115200 baud**. Open the port with DTR/RTS asserted, then reset the board; you
should see:

```text
*** Booting nRF Connect SDK v3.3.0 ***
# OPENFLOAT_PROTO,1
# target: Seeed XIAO nRF54L15 Sense
# imu_odr_hz: 3332
# IMU ready: ... accel+gyro ODR 3332 Hz ...
OFRAW,1,0,77728,900, ...
```

A healthy device streams ~1110 averaged frames/s with zero FIFO overruns.

---

## 6. Open the web app

Serve the repo root over localhost (Web Bluetooth and native ES modules require
an `http://` origin, not a `file://` path):

```powershell
python -m http.server 4178
```

Then open **http://localhost:4178/** in Chrome or Edge. The app also runs fully
offline once loaded, and the hosted build lives at `openfloatarchery.com`.

---

## 7. Connect over Bluetooth

1. Power the sensor (battery or USB) and move it so it is awake.
2. In the app header, click the **Disconnected** status badge (top-left).
3. In the browser's Bluetooth picker, choose your **`OpenFloat-XXXX`** device
   and pair.
4. The badge turns green and the Dashboard begins streaming: the bow orientation
   visualizer moves, the Shot Sequence Trace fills, and the live rate shows
   ~1110 Hz.

If the link drops, the app retries automatically (up to 6 times with backoff)
and the firmware resumes advertising — usually it reconnects on its own.

![The dashboard streaming: bubble level, 3D bow visualizer, and live trace](images/dashboard-live.png)

> No sensor yet? The **▶ Demo** button in the header streams synthetic motion
> so you can explore the whole dashboard first.

---

## 8. First calibration

1. Hold the bow in your normal level shooting position.
2. On the Dashboard, click **Zero Calibration** to capture the current roll and
   pitch as your level reference. The bubble level and 3D bow should now read
   level.
3. If the on-screen bow is rotated relative to your real mount, open
   **Settings → Sensor & 3D Alignment** and adjust the mount axis mapping until
   the model matches reality.

That's it — take a shot and it appears in **Recent Shots** with an OpenFloat
Float Score. From here, explore **Steady Aim** for hold drills and **Saved
Shots** for session review.
