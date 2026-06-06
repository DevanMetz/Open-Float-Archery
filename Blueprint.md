# OpenFloat Archery Telemetry System: Technical Architecture

This document defines the open-source hardware, firmware, browser, telemetry, and cloud architecture for the OpenFloat archery performance monitor.

OpenFloat is designed as a local-first, browser-native telemetry system for archers, coaches, and makers. The core experience should work without a native mobile app and without requiring cloud access. Cloud sync adds account-based history and coaching workflows, but it should not be required for device use at the range.

Production site:

https://openfloatarchery.com

## Implementation Status

This blueprint mixes shipped reality with forward-looking design. As of the
NCS v3.3.0 firmware (see `firmware/`), the following is **built and verified on
hardware** (Seeed XIAO nRF54L15 Sense, IMU `lsm6ds3tr_c`):

- IMU accelerometer + gyroscope previously verified at **416 Hz** (the
  LSM6DS3TR-C native ODR closest to the 400 Hz target). The current firmware runs
  the IMU at **3332 Hz** ODR through raw registers, read with an
  **interrupt-driven FIFO watermark** (INT1 on P0.02), and averages each group of
  3 raw samples into one distinct frame for a **~1110 Hz** BLE output stream. An
  earlier experiment used the sensor's 6664 Hz max ODR, but the 1 MHz I2C bus
  could not drain it without ~1/s FIFO overruns; 3332 Hz removed the overruns
  (see caveat below).
- On-device orientation: a Madgwick filter produces a quaternion and Euler
  angles (cant/roll, pitch, yaw) **on the device**, not in the browser.
- Shot detection: a 12 g (117.72 m/s^2) acceleration-magnitude threshold with
  an 800 ms refractory window, surfaced as an `OFSHOT` serial event, a user LED
  pulse, and a BLE shot-event notification. The lifetime shot count is persisted
  to RRAM (Zephyr Settings/ZMS) and restored on boot.
- Two telemetry transports carrying the same data:
  - **USB / Web Serial**: human-readable `OFRAW` text lines at ~11 Hz
    (every 100th output frame) plus `#` comment/banner lines and `OFSHOT` events.
  - **BLE**: a custom GATT service notifying compact 29-byte binary frames (including on-device quaternions).
    Live-sample frames are batched six per 174-byte notification; shot-event and
    count-sync frames are sent as standalone notifications.
- Browser dashboard: `index.html` connects over Web Bluetooth (BLE) from the
  header status badge. (The serial `OFRAW` decoder and demo adapter remain in
  `app/device` but are no longer surfaced in the dashboard UI; the serial
  decoder still backs `tools/openfloat_ble_client.py`.) BLE live frames carry
  the firmware Madgwick quaternion, so the browser derives roll, pitch, and yaw
  directly from the on-device 3D orientation estimate. If a transport omits
  those angles, the browser falls back to local gyro/accelerometer tracking.
- Dashboard calibration/review views include a calibrated digital bubble level,
  a Three.js bow orientation visualizer, and phase-colored Pin Float trace
  replay centered on the shot-detection point, with a 1-sigma float ellipse,
  release reticle, and a full-width scrubber in its own section below the target
  (circular play/pause button, phase-colored timeline, 0.25x-4x replay speed,
  and scroll-wheel / pinch zoom on the trace).
- Button-triggered zeroing of cant and pitch offsets.
- On-chip PDM microphone envelope follower packed into each live BLE frame for
  bow-mounted acoustic events (clicker drops, release transients).
- Browser dashboard acoustic envelope meter in the live metrics header.

Verified test clients: `tools/openfloat_ble_client.py` (BLE + serial decoder)
and the Web Serial dashboard in `index.html`.

**Measured high-rate caveat:** the 6664 Hz experiment streamed continuous 1 ms
BLE frames with zero *sequence* loss (a 40 s run received `frames=40080 lost=0
rate=991.9 Hz`), but the 1 MHz I2C bus could not sustain ~80 KB/s of IMU data, so
the FIFO overran about once per second and emitted a corrupted sample around each
overrun (`|a|=0.41 g` with a single ~111 dps gyro axis). The fix has two parts:
(1) lower the IMU ODR to **3332 Hz** so the bus has headroom, and (2) read the
FIFO with an **interrupt-driven watermark** (INT1 on P0.02) that drains a batch
per interrupt in one I2C burst and splits it into distinct 3-sample averaged
frames. A 25 s Windows/Bleak run received `frames=28670 lost=0 rate=1129 Hz`
(warm-up-excluded) with **0 FIFO overruns, 0 resyncs, 0 outlier frames, and 100%
distinct frames** (`|a|` held 0.814-1.179 g). The on-device decode also uses a
linear word counter validated against the FIFO pattern register, so a desync
discards a partial sample rather than splicing two periods into one frame. The
IMU is I2C-only on this board, so 1 MHz I2C is the transport ceiling; genuinely
higher sustained rates would need SPI (different hardware).

**Measured CPU load:** with Zephyr `CONFIG_CPU_LOAD=y`, the firmware prints
`# CPU_LOAD,...` once per second on serial (including running `fifo_overruns` /
`fifo_resyncs` counters). The interrupt-driven loop measures about **35% active**
(~65% idle), down from ~51% with the earlier busy-polling approach, because each
watermark interrupt drains one large I2C burst and the loop sleeps in between.

Shot detection persists a lifetime shot count to RRAM (Zephyr Settings/ZMS) and
notifies it to the browser on each increment (and on connect). The firmware now
keeps compact stored-shot records and chunked trace windows for reconnect
upload; the browser stores shots/traces in IndexedDB and can optionally queue
them to Supabase when the user supplies project credentials. **Not yet
implemented** (still design targets below): CRC-footed live packets, dedicated
device-info / shot-data / config characteristics, polished account/coaching
cloud workflows, and broad field validation across bows, mounts, and browsers.
Where a section below describes one of these, treat it as the intended direction
rather than current behavior.

The sections that follow keep the original target design and call out the
**Implemented v1** behavior inline where firmware already differs.

## 1. Architecture Goals

- Open-source and contributor-friendly.
- Zero-install browser dashboard.
- Full-rate live telemetry for aiming, release, and follow-through analysis.
- Local-first storage for range use without reliable internet.
- Optional cloud sync for history, coaching, and multi-device access.
- Hardware small enough to mount on a riser, stabilizer, or accessory rail without changing bow balance.
- Firmware simple enough to validate with real shooting data before adding advanced analytics.

## 2. System Architecture

```text
Bow Sensor Module
  |
  | IMU sampling, calibration, shot detection, local rolling buffer
  v
Firmware Data Pipeline
  |
  | Full-rate BLE telemetry, shot events, config commands, USB/Web Serial flashing
  v
Browser Client
  |
  | live dashboard, shot review, calibration, IndexedDB local storage
  v
Optional Cloud Sync
  |
  | account, bow profiles, sessions, shot history, coaching analytics
  v
Coach / Archer Dashboard
```

The browser client is the main user interface. The hardware streams full-rate telemetry live to the browser whenever the connection can support it. The device also maintains a local rolling shot buffer so release data can be recovered if live transfer drops packets or the browser temporarily falls behind.

## 3. Reference Hardware

The first hardware target is a tiny pre-certified BLE microcontroller module with an integrated IMU.

| Component | Specification | Notes |
| --- | --- | --- |
| Microcontroller / BLE | Seeed Studio XIAO nRF54L15 Sense | Validated: boots NCS v3.3.0, advertises BLE, streams IMU telemetry. |
| IMU | Integrated 6-axis accelerometer and gyroscope (LSM6DS3TR-C) | Stable baseline at 416 Hz; current raw-register FIFO path runs 3332 Hz ODR, +/-16 g accel, +/-2000 dps gyro (6664 Hz overran the 1 MHz I2C bus). |
| Battery | 3.7V LiPo, approximately 70 mAh, with protection circuit | Runtime must be measured under full-rate streaming. |
| Enclosure | SLA resin, printed nylon, or injection-molded housing | Should isolate electronics from direct riser shock. |
| Mounting | Rubber-damped strap, 5/16-24 stabilizer mount, or rail adapter | Mount repeatability affects data quality. |
| Damping | TPU or similar semi-rigid interface layer | Must reduce shock damage without hiding useful vibration data. |

### Cost Model

The initial bill of materials should be treated as a target COGS, not a validated production cost.

| Component | Target Cost |
| --- | ---: |
| Microcontroller / BLE module | $6.50 |
| Battery | $1.20 |
| Enclosure | $1.50 |
| Mounting hardware | $1.00 |
| Packaging and assembly | $1.80 |
| Target hardware COGS | ~$12.00 |

Prototype cost will likely be higher. Production cost depends on volume, assembly method, enclosure process, test fixtures, certification scope, and battery sourcing.

## 4. Firmware Architecture

Firmware should be organized into small modules that can be tested independently.

```text
imu_driver
  - configures accel and gyro ranges
  - samples at fixed rate
  - timestamps samples

calibration
  - estimates idle orientation
  - applies axis mapping
  - stores per-device offsets

signal_pipeline
  - filters samples
  - computes acceleration magnitude
  - detects shot impulse
  - computes basic live metrics

shot_buffer
  - maintains rolling pre-shot samples
  - captures post-shot follow-through
  - stores last N shot windows for retry

transport
  - BLE GATT service
  - optional USB serial protocol
  - command/config handling
  - packet chunking and checksums

power_manager
  - battery reporting
  - sleep/idle behavior
  - streaming power profile
```

### Operating Modes

| Mode | Purpose |
| --- | --- |
| Idle | Low-power standby while advertising BLE. |
| Full-Rate Live Stream | Streams raw or fixed-point IMU samples to the browser at the configured sample rate. |
| Shot Capture | Maintains rolling pre-shot and post-shot buffers while streaming. |
| Shot Transfer / Replay | Sends a complete buffered shot window, useful after packet loss or for saved shots. |
| Config | Updates thresholds, sample rate, orientation, calibration, and device name. |
| Bootloader / Flashing | Allows firmware installation or updates through the board-supported USB/Web Serial path. |

## 5. Sampling and Shot Buffer

OpenFloat should support full-rate live telemetry and a local rolling buffer at the same time.

### Target Sampling

| Setting | Target |
| --- | --- |
| Initial sample rate | 400 Hz |
| Stretch sample rate | 800 Hz |
| Channels | 3-axis accelerometer, 3-axis gyroscope |
| Accel range | Highest available practical range, minimum target 16g |
| Gyro range | Highest available practical range |
| Timestamp | Monotonic device timestamp or sample counter |

**Implemented v1 / current firmware:** the stable baseline sampled accel +
gyro at **416 Hz** (nearest LSM6DS3TR-C ODR to 400 Hz). The current firmware
configures **3332 Hz** accel + gyro ODR through raw LSM6DSL registers and reads
the FIFO via an INT1 watermark interrupt, averaging each group of 3 raw samples
into one distinct fixed-point frame (`dt_us=900`) over BLE. The latest
Windows/Bleak run received a continuous frame sequence with **0 lost frames
across 28,670 frames** (warm-up-excluded host delivery **1129 Hz** with 174-byte
notifications), and **0 FIFO overruns / 0 resyncs / 0 outlier frames / 100%
distinct frames**. An earlier 6664 Hz experiment hit similar throughput but
overran the 1 MHz I2C bus ~1/s, corrupting a sample around each overrun. The IMU
is I2C-only on this board, so capture above 3332 Hz would need SPI (different
hardware).

### Local Rolling Buffer

The rolling buffer protects the product experience when wireless delivery is imperfect.

| Window | Target |
| --- | --- |
| Total shot window | 5 seconds |
| Pre-shot | 3.5 seconds |
| Post-shot | 1.5 seconds |
| Stored shots | At least latest shot; more if RAM/flash allows |

Memory depends on sample format. A compact fixed-point sample can be much smaller than `float32`.

Example fixed-point sample:

```text
sample_counter: uint32
accel_x: int16
accel_y: int16
accel_z: int16
gyro_x: int16
gyro_y: int16
gyro_z: int16
```

This is 16 bytes per sample before packet headers. At 400 Hz, 5 seconds is approximately 32 KB. At 800 Hz, 5 seconds is approximately 64 KB.

## 6. Full-Rate Live Telemetry

Full-rate live streaming is a core requirement. The device should stream raw or fixed-point IMU samples continuously while connected.

### Transport Implications

BLE can support this only if packets are compact and connection parameters are tuned. The firmware should use packed binary samples, batch multiple samples per notification, and avoid `float32` for the primary transport format.

Approximate payload rates before BLE overhead:

| Format | 400 Hz | 800 Hz |
| --- | ---: | ---: |
| 16-byte fixed-point sample | 6.4 KB/s | 12.8 KB/s |
| 28-byte float32 sample | 11.2 KB/s | 22.4 KB/s |

Preferred live format:

```text
packet_header:
  protocol_version: uint8
  packet_type: uint8
  flags: uint8
  sample_count: uint8
  sequence: uint32
  timestamp_base_us: uint32

sample:
  dt_us: uint16
  accel_x: int16
  accel_y: int16
  accel_z: int16
  gyro_x: int16
  gyro_y: int16
  gyro_z: int16

packet_footer:
  crc16: uint16
```

The browser converts fixed-point values into physical units using scale factors announced by the device.

### Implemented v1 Live Frame

The CRC-footed packet above is the longer-term target. The current firmware
   ships a **fixed 29-byte** frame (carrying on-board quaternions and raw audio envelope) whose meaning is selected
   by the type byte. Live-sample frames (type 1) are batched six per BLE notification
   (a **174-byte payload**); text serial emits `OFRAW` lines instead:

```text
offset 0  magic[2]      "OF"
offset 2  proto u8       1
offset 3  type u8        1 (live raw sample)
offset 4  sequence u16   little-endian, wraps at 65536
offset 6  dt_us u16      group window (~900 us = SAMPLES_PER_OUTPUT / ODR)
offset 8  accel_mg int16[3]   milli-g, scale 1 mg/LSB
offset 14 gyro int16[3]       deg/s in Q4 fixed point (LSB = 1/16 deg/s)
offset 20 quat int16[4]       quaternion (qw, qx, qy, qz) scaled by 10000 (LSB = 1/10000)
offset 28 mic_amp u8          noise-gated peak envelope, scale 1/3.0f (0..255)
```

Each type-1 frame is the average of `SAMPLES_PER_OUTPUT` (3) raw IMU samples, so
`dt_us` is the fixed group window rather than a per-sample delta. There is **no
CRC and no flags field** in the frame; sequence is `u16`, not `u32`.

The same 29-byte envelope carries other frame types, demultiplexed by the type
byte (see section 8): **type 2** live shot events (shot_count u16 @4, shot_id
u16 @6, accel_mg int16[3] @8, threshold_cg u16 @14, roll/pitch/yaw cdeg @16/@18/@20, clicker_dt_ms u16 @22 (unused/0), impact_dt_ms u16 @24 (unused/0), padded to 29 bytes)
sent on each detected shot, **type 3** count-sync (same shot_count/shot_id
fields) sent on subscribe, and **type 4** stored-shot upload frames with the
same payload as type 2.

### Microphone Peak Envelope Follower

To support bow-mounted acoustic events (such as clicker drops and bow releases) without exceeding BLE transmission bandwidth limits or causing excessive CPU load, the firmware implements a time-invariant, on-chip envelope follower:
- **PDM Sampling**: The microphone captures raw audio via a PDM interface at 16 kHz. A dedicated audio thread reads **14-sample blocks** (~0.875 ms, ~1143 blocks/s). Exact 1110 Hz would need a non-integer block size at 16 kHz PCM; 14 samples is the closest integer match to the ~1110 Hz IMU/BLE stream. Early 14/16-sample experiments failed on the nrfx PDM path with the default shallow driver queue; the current build uses a deeper PDM queue (`queue-size = 48` in `app.overlay`) and a larger mem-slab pool (`AUDIO_BLOCK_COUNT = 64`) so high block rates stay healthy (0 read failures in steady-state testing).
- **Block Peak Extraction**: For each audio block, the audio thread computes the block mean and then uses the peak absolute deviation from that mean. This removes DC/bias from the PDM stream before envelope tracking. Shorter blocks report lower peaks than the original 160-sample tuning reference, so the firmware multiplies by $\sqrt{160 / N}$ before gating and decay.
- **Noise-Floor Subtraction**: An adaptive baseline tracks the steady acoustic/PDM noise floor (2.0 s attack, 0.15 s release). The published envelope subtracts that floor plus a block-scaled margin (`AUDIO_NOISE_MARGIN_BASE = 128` referenced to 160 samples) so idle noise does not pin the dashboard meter high.
- **Time-Invariant RC Decay**: The audio thread updates the shared volatile float `audio_peak_raw` as a software peak-follower model:
  $$smooth\_mic_{t} = \max(peak\_raw, smooth\_mic_{t-dt} \cdot e^{-dt_s / \tau})$$
  where $dt_s$ is the audio block duration in seconds, and $\tau$ is the decay time constant set to **5 ms** (`AUDIO_ENVELOPE_TAU_S = 0.005`). Attack is instant; release is exponential, so clicker and release transients separate cleanly instead of smearing into a long tail.
- **Continuous Tracking**: The telemetry builder does not clear the audio value or perform additional smoothing. The audio thread updates the envelope at ~1143 Hz; each ~1110 Hz live BLE frame samples the latest `audio_peak_raw` into `mic_amp`. The browser dashboard displays that byte directly (no extra client-side smoothing).
- **Serialization**: The tracked `smooth_mic` float is scaled by $1/3$ (`AUDIO_BLE_SCALE_DIVISOR`) to fit in a single byte (0–255) and packed at byte offset 28 of the live binary frame.

The serial `OFRAW` text line carries the same accel/gyro plus the on-device
Euler angles, quaternion, and shot count; `OFSHOT` lines carry shot events.
Scale factors are fixed in firmware for now rather than announced over a
device-info characteristic.

`tools/openfloat_ble_client.py` and the browser BLE adapter decode these typed
frames.

### Reliability Strategy

Full-rate live telemetry should be treated as the live source of truth when the connection is healthy. The local shot buffer remains the recovery source.

- Each live packet includes a sequence number.
- The browser detects dropped packets.
- On shot detection, the browser can request the authoritative shot window from the device buffer.
- If BLE throughput is insufficient on a given browser/device pair, the app should offer a lower sample rate or USB/Web Serial capture mode.

## 7. Shot Detection

A bow release is a high-energy impulse followed by riser vibration and follow-through motion. Detection must reject normal handling, setting the bow down, sight adjustments, and manual let-downs.

Initial algorithm:

1. Apply a high-pass filter to reduce gravity and slow drift.
2. Compute acceleration magnitude from the filtered accelerometer vector.
3. Trigger when magnitude crosses a configurable impulse threshold.
4. Verify with a short post-trigger vibration signature.
5. Apply a cooldown window to prevent duplicate shot events.

The `>12g` threshold from early design notes is a hypothesis. It must be tuned with real bows, mount positions, arrow weights, stabilizer setups, and shooter styles.

Shot event payload:

```text
shot_id: uint32
shot_timestamp_us: uint64
peak_g: uint16 fixed-point
sample_rate_hz: uint16
pre_samples: uint16
post_samples: uint16
flags: uint16
```

**Implemented v1:** detection runs on the raw acceleration magnitude against an
initial **12 g** threshold with an **800 ms** refractory window. The threshold is
runtime-configurable over BLE with `thresh:<g>` and is clamped to 2-30 g. A
detected shot increments a shot counter, pulses the user LED, emits a serial
event, and notifies a 29-byte BLE shot-event frame (type 2) to the browser:

```text
OFSHOT,proto,shot_id,uptime_us,ax_mg,ay_mg,az_mg,shot_count
```

The lifetime shot count is **persisted to RRAM** via the Zephyr Settings
subsystem (ZMS backend, key `openfloat/shots`) on each increment — written off
the IMU loop on the system workqueue so the high-rate FIFO loop never stalls on
the RRAM write — and restored on boot. On BLE subscribe the device sends a
type-3 count-sync frame so the browser shows the persisted count immediately.
The count can be corrected over BLE with `shotset:<n>` or cleared with
`shotreset`.

The firmware also keeps the newest 100 compact shot records in
`openfloat/shotlog`. On BLE subscribe it uploads stored shots one at a time as
type-4 frames. The web app writes each shot to IndexedDB and only then sends
`shotack:<shot_id>`, at which point firmware removes that shot from
RRAM-backed storage. `shotreset` also clears the stored-shot queue.
Buffered traces freeze after a configurable post-release follow-through delay
(default 1.5 s, stored as `openfloat/followms`) so the saved window contains
both the pre-shot hold and the recovery after the release impulse. Each
firmware trace point is a 7-byte record (`roll/pitch/yaw` in centi-degrees plus
`mic_amp` u8). The browser stores the same motion trace in IndexedDB
`shot_traces.payload` and, for connected shots, a full-rate `mic_series`
window (`[{ tUs, micAmp }]`, microseconds relative to the shot) for acoustic
timing work in the web app.

The high-pass filtering, post-trigger vibration verification, and the structured
multi-field shot-event payload (peak_g, timestamps, sample windows) are still to
do; shot events currently ride the live characteristic by type byte rather than
a dedicated shot-event characteristic.

## 8. BLE GATT Protocol

OpenFloat should expose one custom BLE service with versioned characteristics.

```text
OpenFloat Service UUID

Device Info Characteristic
  read
  firmware version, hardware version, protocol version, battery, capabilities

Live Telemetry Characteristic
  notify
  full-rate packed IMU packets

Shot Event Characteristic
  notify
  shot detected, shot id, timestamp, summary metrics

Shot Data Characteristic
  notify/read
  chunked replay of buffered shot windows

Config Characteristic
  read/write
  sample rate, ranges, orientation, thresholds, calibration

Command Characteristic
  write
  start stream, stop stream, request shot, erase saved shot, calibrate
```

**Implemented v1 GATT** (advertised as `OpenFloat-463F` to force Windows cache clear):

```text
Service          8f3f3b10-0f5a-4f4c-9a2d-000000000001 (Custom OpenFloat Service)
Live             8f3f3b10-0f5a-4f4c-9a2d-000000000002  notify  (29-byte frames, typed)
Control          8f3f3b10-0f5a-4f4c-9a2d-000000000003  write   (ASCII commands)
Battery Service  0000180f-0000-1000-8000-00805f9b34fb (Standard BLE BAS)
  Level Char     00002a19-0000-1000-8000-00805f9b34fb  read/notify (0-100%)
```

The live characteristic carries six 29-byte frame types, demultiplexed by the
type byte: type 1 live sample (batched 6/notification), type 2 shot event (sent
on each detected shot), type 3 count sync (sent on subscribe so the persisted
lifetime count displays immediately without logging a shot), type 4 stored
shot upload (sent one at a time until the web app acknowledges each save), type 5
storage status (sent on connect/request to sync queue counts), and type 6 trace
chunk (sent sequentially to stream buffered shot traces with pre-shot hold and
post-release follow-through).

The control characteristic accepts the ASCII commands:
* `start`/`stop`: Toggle live telemetry stream notifications.
* `shotdump`: Request the stored-shot backlog and a fresh storage-status frame.
* `zero`: Capture the current gravitational vector, compute pitch/roll offsets, store them in RRAM (`"cant_offset"`, `"pitch_offset"`), and apply them dynamically so live roll reads exactly 0.0°.
* `thresh:<g>`: Set shot detection accelerometer threshold, clamped to 2-30 g.
* `wakesens:<g>`: Set wake-up trigger accelerometer threshold, clamped to 0.5-8.0 g.
* `sleeptime:<s>`: Set deep sleep timeout in seconds, clamped to 5-600 s. Fresh firmware defaults to 300 s unless an older persisted setting overrides it.
* `sleepsens:<g>`: Set active sleep accelerometer sensitivity movement threshold, clamped to 0.05-0.50 g.
* `bufrate:<hz>`: Set on-device trace buffering rate. Values: `0` (Off), `52` (52 Hz), `104` (104 Hz), `208` (208 Hz). Saves to RRAM (`"openfloat/bufrate"`).
* `bufnvs:<val>`: Toggle whether trace buffer is persisted to non-volatile RRAM. Values: `0` (Off/SRAM only), `1` (On/RRAM). Saves to RRAM (`"openfloat/bufnvs"`).
* `followms:<ms>`: Set the post-release follow-through delay before freezing a shot trace, clamped to 0-3000 ms. Saves to RRAM (`"openfloat/followms"`).
* `streamrate:<n>`: Set the BLE live stream divider. Values: `1`, `2`, `5`, `10`, or `20` (about 1110, 555, 222, 111, or 55 Hz).
* `autosleep:<0|1>`: Enable or disable inactivity-triggered deep sleep. Saves to RRAM (`"openfloat/autosleep"`).
* `tracereq:<shot_id>`: Request a chunked upload of the trace of the shot with ID `shot_id` as Type 6 notifications.
* `shotack:<shot_id>`: Acknowledge a saved type-2/type-4 shot so firmware can free the queued copy from RRAM.
* `shotreset`: Clear the persisted shot count and shot queue.
* `shotset:<n>`: Set the persisted shot count.

The standard Battery Service (BAS) periodically reads the battery voltage from pin `P1.14/AIN7_VBAT` using the regulator switch `vbat_pwr` (`P1.15`), scales the measurement using a $2.0$ divider multiplier, and publishes the percentage value. The dedicated device-info, shot-data, and config characteristics are not implemented yet; shot events ride the live characteristic rather than a separate shot-event characteristic.

### Shot Data Chunking

Buffered shot transfer should be chunked and checksummed.

```text
shot_id: uint32
chunk_index: uint16
total_chunks: uint16
payload_length: uint16
payload: bytes
crc16: uint16
```

The browser should reassemble chunks, validate sequence and checksum, then store the shot in IndexedDB.

## 9. USB / Web Serial Path

USB/Web Serial serves two purposes:

- Firmware installation or update, depending on the board bootloader.
- Optional high-reliability full-rate capture for development, validation, and coaching setups.

The flashing path is hardware-specific and must be validated against the selected board. The blueprint should not assume universal browser-based OTA flashing until the bootloader and browser workflow are proven.

## 10. Browser Application Architecture

The browser app should stay local-first and hardware-aware.

```text
DeviceAdapter
  - connect()
  - disconnect()
  - startLiveStream()
  - stopLiveStream()
  - requestShotData()
  - writeConfig()

TelemetryStore
  - stores live packet state
  - detects packet loss
  - writes shots to IndexedDB

AnalyticsEngine
  - converts fixed-point samples to units
  - computes cant, pitch, roll, stability, float, peak impulse, follow-through

CloudSyncAdapter
  - optional account sync
  - uploads sessions and shots after local save
  - never required for live telemetry

UI
  - live dashboard (inline stream rate & shot counter metrics, live acoustic
    envelope meter, dynamic target trace, inline Record button, and a
    stored-shot "Uploading N" indicator)
  - shot review (aiming hold, release, follow-through phases)
  - Steady Aim training tab (countdown, configurable hold drill, live target
    trace, steadiness scoring, coaching feedback, save to IndexedDB)
  - Bow Shop 3D customization tab that loads named materials from
    `Blender/BowModel.glb`, generates color controls for the compound bow
    materials, and applies those colors to every 3D bow preview
  - settings workspace: full-width Power Management and Telemetry & Buffer
    cards, plus a combined collapsible Sensor & 3D Alignment section (sensor
    mount axis mapping and 3D model display) sharing one 3D preview with axis
    labels for the model/mount rotation controls
  - calibrated glassmorphic spirit bubble level (custom range & tolerance sweet-spot sliders)
  - low-pass filtered (EMA) bubble visualizer for smooth and responsive tracking
  - real-time recent shots grid list (syncing with device shot events & manual recordings)
  - phase-colored trace replay with a below-target scrubber (play/pause, replay
    speed, scroll/pinch zoom) and optional **Compare with** shot overlay
  - saved-shots history auto-grouped into practice sessions by timestamp
    (30-minute gap), with per-session editable name and bow
  - device setup & hardware configuration
  - cloud account and sync status
```

**Implemented v1:** `index.html` loads ES modules split under `app/` (core,
device, protocol, telemetry, ui) and connects over **Web Bluetooth (BLE)** from
the header status badge. (The serial `OFRAW` decoder and demo adapter remain in
`app/device` but are no longer surfaced in the dashboard UI; the serial decoder
still backs `tools/openfloat_ble_client.py`.) Web Bluetooth
decodes the 29-byte binary frames (live samples batched in 174-byte
notifications, plus shot-event, count-sync, storage-status, stored-shot, and
trace-chunk frames); those BLE frames carry the on-board Madgwick filter
quaternion, allowing the browser to extract and convert it to Euler angles
directly, aligning it with the serial stream. The app also includes local bow
profiles, timestamp-derived practice sessions, manual trace recording, saved
shot review/compare, Steady Aim hold training (`app/ui/training.js`), Bow Shop
3D customization, and an optional Supabase-backed sync queue configured from the
Cloud modal. Additionally, a Progressive Web App (PWA) service worker
(`service-worker.js`) is registered to cache all core markup, styling, modules,
and the 3D bow model, ensuring the application is usable offline at remote
archery ranges after it has been loaded once.

### 3D Model Asset Contract

`Blender/BowModel.glb` is the browser model library for the current web app.
The exporter may flatten Blender collections, so browser code relies on stable
object and material names rather than collection membership alone.

Current compound-bow objects:

- `String`
- `Top_Cam`
- `Bottom_Cam`
- `Riser`
- `Top_Text`
- `BOW_PIVOT`

Current compound-bow materials exposed in Bow Shop:

- `string`
- `cam`
- `riser`
- `grip`
- `text`

Attachment/electronics objects remain separate from compound-bow material
customization. `Sight_Arm` and `Sight_Pin` currently keep their own sight
materials. A named `MCU` object is detached from the loaded GLB and attached as
the live module preview (`bow.userData.xiaoModule`) so mount orientation,
position, and rotation controls affect the Blender MCU model instead of a
procedural placeholder. If the GLB omits `MCU`, the app falls back to the
procedural XIAO module.

### Real-time UI & Database Updates
The Recent Shots list is reactive. When a connection is active (serial or BLE) and the device detects a shot, the adapter parses and relays the event onto the global `EventBus` as a `"shot"` event. The `TelemetryStore` listens to this event, deduplicates against the set of device shot IDs already handled **this connection** (the device's `shot_id` restarts at 0 after a `shotreset`/reflash, so all-time deduplication by ID is unsafe), writes the shot to IndexedDB with `session_id: null`, and emits a `"shot-saved"` event. The dashboard UI listens to `"shot-saved"` and instantly updates the Recent Shots grid. Practice sessions are no longer tracked live — they are derived from shot timestamps when the Saved Shots history is rendered (any gap over 30 minutes starts a new session), and the user can rename a session and assign its bow, stored as a per-group override.

While the device is connected it does **not** persist a trace for each shot; the browser captures the trace from the live stream and saves it to IndexedDB shortly after the configurable follow-through window, then emits `"shot-trace-saved"`. (Shots taken while disconnected are stored on-device and their traces upload on reconnect.) Because a just-detected shot becomes clickable before its browser trace is persisted, opening a recent shot polls briefly for the trace before reporting it unavailable. Manual captures also trigger `"shot-saved"` upon save.

## 11. Browser Data Parsing

The browser should parse packed binary with `DataView`.

```js
function parseLiveTelemetryPacket(value, scales) {
  const protocolVersion = value.getUint8(0);
  const packetType = value.getUint8(1);
  const flags = value.getUint8(2);
  const sampleCount = value.getUint8(3);
  const sequence = value.getUint32(4, true);
  const timestampBaseUs = value.getUint32(8, true);

  const samples = [];
  let offset = 12;

  for (let i = 0; i < sampleCount; i += 1) {
    const dtUs = value.getUint16(offset, true);
    const ax = value.getInt16(offset + 2, true) * scales.accel;
    const ay = value.getInt16(offset + 4, true) * scales.accel;
    const az = value.getInt16(offset + 6, true) * scales.accel;
    const gx = value.getInt16(offset + 8, true) * scales.gyro;
    const gy = value.getInt16(offset + 10, true) * scales.gyro;
    const gz = value.getInt16(offset + 12, true) * scales.gyro;

    samples.push({
      timestampUs: timestampBaseUs + dtUs,
      accel: [ax, ay, az],
      gyro: [gx, gy, gz],
    });

    offset += 14;
  }

  return { protocolVersion, packetType, flags, sequence, samples };
}
```

## 12. Local-First Storage

IndexedDB should be the local source of truth for field use.

Local storage responsibilities:

- Device profiles.
- Bow setups.
- Calibration records.
- Sessions.
- Shot metadata.
- Raw or compressed shot traces.
- Sync queue.

Cloud sync should upload after local persistence succeeds, not before.

## 13. Cloud Architecture

Cloud is optional and should enhance the product rather than gate it. The
current browser app has an optional Supabase adapter: users can enter a Supabase
URL and anon key in the Cloud modal, the app signs in anonymously when allowed,
and local IndexedDB mutations are queued before upload. This is a contributor
prototype for self-hosted sync, not a hosted OpenFloat account service.

Recommended model:

```text
users
  id
  display_name
  created_at

bow_profiles
  id
  user_id
  bow_model
  stabilizer_setup
  notes

sessions
  id
  user_id
  bow_profile_id
  started_at
  location_label

shots
  id
  session_id
  device_id
  device_shot_id
  timestamp
  peak_g
  cant_angle_deg
  pitch_angle_deg
  roll_angle_deg
  stability_score
  shot_score
  hold_stability
  release_quality
  follow_through
  stored_upload
  packet_loss_count
  raw_trace_ref

shot_traces
  shot_id
  encoding
  sample_rate_hz
  payload
```

**Client session model (current implementation):** the local IndexedDB no longer
tracks live `sessions`. Shots are saved with `session_id: null`, and practice
sessions are derived from shot timestamps at display time (any gap over 30
minutes starts a new session). A `session_overrides` object store keyed by each
group's earliest shot id holds the user-edited `name` and `bow_profile_id`. The
cloud `sessions` table above remains the recommended server model for future
sync; the local schema favors timestamp-derived grouping so no manual
start/stop is required.

If using Firestore, avoid placing large raw traces inside user profile
documents. Store shot metadata and raw traces separately. If using
Supabase/PostgreSQL, normalize sessions, shots, and trace payload references.
The browser currently stores `device_shot_id` so reconnect uploads can be
deduplicated, `shot_score` for the derived form score, and `stored_upload` to
mark shots recovered from firmware nonvolatile storage.

For existing Supabase projects, add the newer shot fields with:

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

## 14. Analytics Roadmap

Initial metrics:

- Peak acceleration.
- Cant angle at release.
- Pitch and roll at release.
- Pre-shot float radius.
- Hold stability score.
- Follow-through movement.
- Packet loss during live stream.

Later metrics:

- Shooter consistency across sessions.
- Bow setup comparison.
- Release timing signatures.
- Stabilizer tuning comparison.
- Coach/team review workflows.

## 15. Phased Build Plan

Status legend: **[done]** verified on hardware, **[partial]** started, **[todo]**
not begun. See the Implementation Status section near the top for detail.

### Phase 1: Browser Prototype  [partial]

- Keep the current dashboard working at `openfloatarchery.com`.
- Add realistic simulation data.
- Store mock sessions and shots in IndexedDB.

### Phase 2: Firmware IMU Sampler  [done]

- Read IMU at 400 Hz. (Shipped at 416 Hz, the nearest LSM6DS3TR-C ODR.)
- Timestamp samples.
- Log raw data over USB serial for validation. (`OFRAW` text lines.)

### Phase 3: Full-Rate BLE Live Stream  [partial]

- Implement packed binary live packets. (29-byte v1 frames containing quaternions; firmware batches 6
  distinct averaged frames into 174-byte notifications, read via INT1 watermark.)
- Tune BLE connection interval and MTU. (212-byte L2CAP TX MTU, 217-byte ACL
  TX/RX buffers, and 7.5 ms preferred interval are in use; 174-byte BLE
  payloads verified on Windows/Bleak at about 161 notifications/s with zero
  sequence loss.)
- Detect packet loss in the browser and Python client. (Both use the sequence
  field from the v1 binary frame.)

### Phase 4: Shot Detection and Rolling Buffer  [partial]

- Implement impulse detection. (12 g threshold + 800 ms refractory, `OFSHOT`
  serial events + LED pulse.)
- Capture pre-shot and post-shot windows. (Rolling buffer and configurable
  delayed trace freeze are implemented.)
- Allow browser replay requests. (Trace upload and browser review are
  implemented for stored shots.)

### Phase 5: Calibration and Config  [partial]

- Add axis orientation mapping. (Fixed mount rotation + button-zeroed cant/pitch
  offsets in firmware.)
- Add threshold configuration. (Runtime BLE command `thresh:<g>` implemented.)
- Add sample-rate and range configuration. (Not yet runtime-configurable.)

### Phase 6: Local-First Persistence  [done]

- Save shots, traces, bow profiles, timestamp-derived session overrides, and
  sync queue tasks to IndexedDB.
- Add import/export for open-source data portability. (Settings → Data Backup &
  Restore exports every object store to a single JSON file and imports one back,
  merging by key. Fully local, no account required.)

### Phase 7: Optional Cloud Sync  [partial]

- Add account login. (Prototype uses optional Supabase credentials and anonymous
  auth where enabled.)
- Sync local shots after successful local save. (Queued Supabase upserts are
  implemented for shots/traces/profiles; production account UX and conflict
  handling are still future work.)
- Keep offline use fully functional.

### Phase 8: Field Validation  [todo]

- Test multiple bows, mounts, shooters, and stabilizer setups.
- Measure false positives.
- Measure battery runtime.
- Measure BLE packet loss at the range.

## 16. Validation Plan

| Test | Goal |
| --- | --- |
| IMU bench test | Confirm sample rate, timestamps, scale factors, and noise floor. |
| BLE throughput test | Confirm 400 Hz, 800 Hz, and experimental 1000 Hz live streaming on target browsers. |
| Packet loss test | Verify sequence tracking and shot-buffer recovery. |
| Shock/vibration test | Determine clipping, mount stability, and damping effects. |
| False trigger test | Reject normal handling, let-downs, and transport movement. |
| Live shooting test | Validate release detection and metrics against real arrows. |
| Battery test | Measure runtime during advertising, streaming, and idle. |
| Browser compatibility test | Confirm Chrome/Chromium behavior for Web Bluetooth and Web Serial. |
| Cloud sync test | Confirm offline capture, later upload, and conflict handling. |

## 17. Open Questions

- Can the selected integrated IMU capture release shock without clipping?
- The high-rate path now uses interrupt-driven FIFO draining at a 3332 Hz ODR
  (overrun/pattern artifacts resolved). The IMU is I2C-only on this board, so is
  it worth moving to SPI hardware to push validated capture above 3332 Hz?
- Should USB/Web Serial be the recommended mode for lab-grade full-rate capture?
- What mounting position gives the best signal-to-noise ratio?
- How much damping protects electronics without hiding useful shot dynamics?
- Which metrics are most valuable to archers and coaches in the first release?
- What data should be public/exportable for the open-source community?
