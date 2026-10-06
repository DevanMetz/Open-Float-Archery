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
- On-device orientation: a Madgwick filter produces the canonical quaternion
  **on the device**, not in the browser. Euler angles (cant/roll, pitch, yaw)
  are derived compatibility/readout values for the dashboard, scoring, and
  stored traces.
- Shot detection: a 12 g (117.72 m/s^2) acceleration-magnitude threshold with
  an 800 ms refractory window, surfaced as an `OFSHOT` serial event, a user LED
  pulse, and a BLE shot-event notification. The lifetime shot count is persisted
  to RRAM (Zephyr Settings/ZMS) and restored on boot.
- Two telemetry transports carrying the same data:
  - **USB / Web Serial**: human-readable `OFRAW` text lines at ~11 Hz
    (every 100th output frame) plus `#` comment/banner lines and `OFSHOT` events.
  - **BLE**: a custom GATT service notifying compact binary frames, including 20-byte live quaternion frames.
    Live-sample frames are batched six per 120-byte notification; shot-event and
    count-sync frames are sent as standalone notifications.
- Browser dashboard: `index.html` connects over Web Bluetooth (BLE) from the
  header status badge. (The serial `OFRAW` decoder and demo adapter remain in
  `app/device` but are no longer surfaced in the dashboard UI; the serial
  decoder still backs `tools/openfloat_ble_client.py`.) BLE live frames carry
  the firmware Madgwick quaternion as the canonical orientation value, and the
  browser derives roll, pitch, and yaw from that on-device 3D estimate for
  readouts, bubble-level rendering, and legacy trace/scoring surfaces. If a
  custom or legacy transport omits those derived angles, the browser falls back
  to local gyro/accelerometer tracking.
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

### Implemented v2 Live Frame

The CRC-footed packet above is the longer-term target. The current firmware
   ships a compact **20-byte** live frame carrying 8-bit accel, on-board
   quaternions, and a raw audio envelope. Live-sample frames (type 1) are batched
   six per BLE notification (a **120-byte payload**); text serial emits `OFRAW`
   lines instead:

```text
offset 0  magic[2]      "OF"
offset 2  proto u8       2
offset 3  type u8        1 (live raw sample)
offset 4  sequence u16   little-endian, wraps at 65536
offset 6  dt_us u16      group window (~900 us = SAMPLES_PER_OUTPUT / ODR)
offset 8  accel_deci_g int8[3] signed deci-g, scale 0.1 g/LSB
offset 11 quat int16[4]        quaternion (qw, qx, qy, qz) scaled by 10000 (LSB = 1/10000)
offset 19 mic_amp u8           noise-gated peak envelope, scale 1/3.0f (0..255)
```

Each type-1 frame is the average of `SAMPLES_PER_OUTPUT` (3) raw IMU samples, so
`dt_us` is the fixed group window rather than a per-sample delta. There is **no
CRC, no flags field, and no gyro vector** in the frame; sequence is `u16`, not
`u32`. Browser scoring derives angular-rate magnitude from successive
quaternions when gyro data is absent.

The legacy 29-byte live-frame decoder remains in the browser and Python client
for older firmware, but shipped BLE live telemetry uses the 20-byte v2 frame.
The 29-byte envelope still carries other frame types, demultiplexed by the type
byte (see section 8): **type 2** live shot events and **type 3** count sync use
protocol 2, with the low count/ID halves at offsets 4/6 and the high ID/count
halves at 22/24. Motion and orientation fields remain at offsets 8-21, and
release sequence stays at 26 for Type 2. **Type 4** stored-shot uploads retain
protocol 1, with the full ID at 6/26 and the historical 16-bit count at 4. See
"Shot metadata counters" for the full layout and browser compatibility notes.

### Microphone Peak Envelope Follower

To support bow-mounted acoustic events (such as clicker drops and bow releases) without exceeding BLE transmission bandwidth limits or causing excessive CPU load, the firmware implements a time-invariant, on-chip envelope follower:
- **PDM Sampling**: The microphone captures raw audio via a PDM interface at 16 kHz. A dedicated audio thread reads **14-sample blocks** (~0.875 ms, ~1143 blocks/s). Exact 1110 Hz would need a non-integer block size at 16 kHz PCM; 14 samples is the closest integer match to the ~1110 Hz IMU/BLE stream. Early 14/16-sample experiments failed on the nrfx PDM path with the default shallow driver queue; the current build uses a deeper PDM queue (`queue-size = 48` in `app.overlay`) and a larger mem-slab pool (`AUDIO_BLOCK_COUNT = 64`) so high block rates stay healthy (0 read failures in steady-state testing).
- **Block Peak Extraction**: For each audio block, the audio thread computes the block mean and then uses the peak absolute deviation from that mean. This removes DC/bias from the PDM stream before envelope tracking. Shorter blocks report lower peaks than the original 160-sample tuning reference, so the firmware multiplies by $\sqrt{160 / N}$ before gating and decay.
- **Noise-Floor Subtraction**: An adaptive baseline tracks the steady acoustic/PDM noise floor (2.0 s attack, 0.15 s release). The published envelope subtracts that floor plus a block-scaled margin (`AUDIO_NOISE_MARGIN_BASE = 128` referenced to 160 samples) so idle noise does not pin the dashboard meter high.
- **Time-Invariant RC Decay**: The audio thread updates the shared volatile float `audio_peak_raw` as a software peak-follower model:
  $$smooth\_mic_{t} = \max(peak\_raw, smooth\_mic_{t-dt} \cdot e^{-dt_s / \tau})$$
  where $dt_s$ is the audio block duration in seconds, and $\tau$ is the decay time constant set to **5 ms** (`AUDIO_ENVELOPE_TAU_S = 0.005`). Attack is instant; release is exponential, so clicker and release transients separate cleanly instead of smearing into a long tail.
- **Continuous Tracking**: The telemetry builder does not clear the audio value or perform additional smoothing. The audio thread updates the envelope at ~1143 Hz; each ~1110 Hz live BLE frame samples the latest `audio_peak_raw` into `mic_amp`. The browser dashboard displays that byte directly (no extra client-side smoothing).
- **Serialization**: The tracked `smooth_mic` float is scaled by $1/3$ (`AUDIO_BLE_SCALE_DIVISOR`) to fit in a single byte (0–255) and packed at byte offset 19 of the v2 live binary frame.

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

BLE shot frames also carry `shot_sequence` at bytes 26-27, matching the live
sample sequence from the detection loop. The browser uses that sequence, or the
serial `uptime_us` field when available, to anchor connected shot traces to the
device-side release sample instead of to browser notification receipt time.

The lifetime shot count is **persisted to RRAM** via the Zephyr Settings
subsystem (ZMS backend, key `openfloat/shots`) on each increment — written off
the IMU loop on the system workqueue so the high-rate FIFO loop never stalls on
the RRAM write — and restored on boot. On BLE subscribe the device sends a
type-3 count-sync frame so the browser shows the persisted count immediately.
The count can be corrected over BLE with `shotset:<n>` or cleared with
`shotreset`.

The lifetime count and capture ID are independent unsigned 32-bit values.
`shotset` changes only the count; `shotreset` clears the count and backlog while
preserving the last capture ID. Later releases receive new IDs even when the
displayed count repeats. The lifetime count saturates at `4294967295`; capture
IDs retain their unsigned 32-bit wrap behavior. Counter access uses a dedicated
mutex, released before storage I/O, so BLE corrections and IMU releases cannot
split the persisted snapshot.

`openfloat/shots` now saves one eight-byte Settings value: the lifetime count at
offset 0 and the last capture ID at offset 4, both native little-endian `uint32_t`
on this board. The four-byte legacy value is accepted, initializing both fields
from its count; complete reads are required before changing runtime state. Future
saves write both fields together, preserving independent IDs through reboot.
The pair, compact queue, and traces are separate Settings commits. If a queue
or trace reaches storage before its counter, trusting the counter alone can
reuse a retained ID on the next release. After validated startup restoration,
`firmware/src/shot_recovery.c` advances the RAM capture ID to the newest retained
full-width ID, including complete older-format 32-bit traces. A missing counter
can seed its ID from those records. The saved lifetime count stays authoritative:
recovery does not infer it from truncated historical counts or undo a correction.
For example, count 0/ID 70000 with a complete trace 70003 resumes at count 1/ID
70004 on the next release. Once every startup read/restore succeeds, a changed
ID must persist in the existing count/ID value before BLE or acquisition starts.
Replay acknowledgments can then remove the queue/traces that supplied the ID
without losing it on the next reboot. A failed repair retries within the same
three-pass startup policy and keeps startup closed on exhaustion. Unchanged
counters and fresh defaults need no application saves.

ID ordering uses unsigned sequence distance across wrap, assuming the retained
IDs span less than half the 32-bit range. An exactly half-range comparison is
ambiguous and keeps startup closed without changing the pair. Empty traces do
not participate. Legacy compact queues have only 16-bit IDs and cannot establish
missing high bits, so they remain readable without advancing this full-ID fence.
Portable checks cover a 100-shot queue crossing wrap, all cyclic trace-slot
orders, stale/missing counters, count corrections/resets, saturation, and
ambiguous-ID rejection. Actual C frames pass both browser and Python decoders.
The real SDK Settings model verifies remount recovery, repaired-pair persistence,
legacy queues, nine pre-commit/torn/commit-then-error repair cases, no repair after
failed reads or ambiguous ordering, and durability after all retained evidence
is removed. Physical
reboot/power-loss behavior remains unverified; this is not a multi-key transaction.

Older firmware cannot read the eight-byte value on downgrade. To migrate back,
record the displayed count before downgrading and set it again using that older
firmware's `shotset` command; older ID-reset behavior then applies.

Shot-value commands accept only decimal digits in the unsigned 32-bit range.
Malformed values return ATT "Value Not Allowed" without changing state, and all
control writes reject embedded NUL bytes before dispatch. The offline queue
bench client requests extended traces and matches complete IDs; a count reset
does not force its next capture ID back to one.

The firmware also keeps the newest 100 compact shot records in
`openfloat/shotlog`. On BLE subscribe it uploads stored shots one at a time as
type-4 frames. The web app writes each shot to IndexedDB and only then sends
`shotack:<shot_id>`, at which point firmware removes that shot from
RRAM-backed storage. `shotreset` also clears the stored-shot queue.

The shot-log Settings layout stays compatible with the current 2,804-byte value:
a two-byte count, two padding bytes, and 100 padded 28-byte records. Each record
has a 16-bit historical count at offset 0, a 32-bit capture ID at 4, acceleration
at 8/10/12, threshold at 14, angles at 16/18/20, and reserved timing words at
22/24. Both older layouts also load: 2,202 bytes with 22-byte records and
1,802 bytes with 18-byte records, each starting after a two-byte count and using
16-bit IDs. The oldest layout has no timing words, which restore as zero.

The Settings callback checks the declared size before reading, then passes the
actual read count into the portable decoder. Zero, short, or oversized reads,
unknown layouts, and queue counts above 100 are rejected before changing the
RAM queue. A short current read cannot be interpreted as a complete smaller
legacy record. Backend errors propagate. Complete records decode into a staged
queue, preserving order and fields, zero-extending legacy IDs, and clearing
unused slots and padding. Current IDs retain their full range, including zero.
Writes keep the existing layout, and stored uploads keep protocol-1 Type 4.

Append normalizes record padding; acknowledgment removes the matching full ID,
preserves queue order, and zeroes the vacated last slot. Reset clears the entire
log. Snapshots use a byte copy, so every drained queue has the same 2,804 zero
bytes. `CONFIG_ZMS_NO_DOUBLE_WRITE=y` compares existing values before writing:
once the empty log is stored, live acknowledgments that leave it empty add no
shot-log RRAM writes. This costs storage reads on the system workqueue. New or
changed backlogs, their removal, and the initial empty value still need writes;
counter and enabled trace persistence are independent.

The portable module (`firmware/src/shot_log.c`) also builds the actual stored
frame. Host C checks cover all short read lengths, all three layouts, capacity,
unaligned input, rejection without mutation, and staged in-place migration.
Its output passes the browser and Python decoders. The NCS build removes 4,000
bytes of static migration buffers; an ARM compiler stack check reports 2,848
bytes for the staged decoder, plus the caller's read buffer on the configured
16 KB main stack during boot. Physical Settings and power-cycle tests remain
pending.

Queue-mutation host checks cover full IDs, ordered removal, capacity eviction,
padding, reset, and 1,000 append/ack cycles returning to identical empty bytes.
The actual SDK ZMS host model counts flash calls: 100 empty live-ack saves add
zero writes or erases, while a persisted backlog and its acknowledgment survive
remounts. The model does not exercise physical RRAM or the complete Settings
linked-list backend.

Ordinary count/ID, queue, tuning, and calibration saves share one delayable
worker instead of eleven separate jobs. `firmware/src/settings_retry.c` tracks
the twelve existing keys with independent budgets and deadlines. A failed save
gets at most three attempts, waiting one second from each failed write's
completion. Ready keys rotate so one busy setting cannot starve the others,
and an unrelated update cannot accelerate a failed key's retry. New values
coalesce and get fresh tokens/budgets; an obsolete write result cannot clear or
retry their replacement. Exhausted failures remain marked until a new update
or the final sleep batch retries their latest values.

The worker snapshots scalar values under the control/counter locks and copies
the compact log under its lock, then releases all RAM locks before Settings
I/O. Calibration updates publish both offsets under the control lock. The
ordinary and final sleep writers share the same twelve-key layout mapping;
there is no storage-schema change. Portable tests cover deadlines, round-robin
progress, coalescing, clock/token wrap, and 108 callback write faults. The real
SDK Settings/ZMS model covers the same 108 failures with remounts, new-update
and sleep recovery after exhaustion, and newer counters during older successful
or failed writes. Torn-value cases commit a half-length value through Settings;
they do not simulate a physical power cut or Zephyr worker scheduling.

Before automatic System OFF, the main loop waits for any follow-through window
and rechecks inactivity, pending calibration/shot commands, and auto-sleep.
It seals control dispatch under `control_mutex`; further commands return ATT
Write Request Rejected (`0xfc`) when a response is requested. Existing control
callbacks finish before sealing, and new BLE connections are declined during
the flush. The main loop pauses acquisition, synchronously cancels delayed
reconcile/freeze/trace writers, and cancels the shared settings worker, waiting
for any current write to finish before taking the final snapshot.
No RAM mutex is held while waiting for those jobs or writing storage.

The final snapshot covers twelve existing Settings values: count/ID, compact
queue, eight tuning keys, and both calibration offsets. The portable
`firmware/src/sleep_flush.c` attempts every value and all requested unsaved
traces on each pass, even if another key fails. It allows three passes with
one-second retry delays. Only a completely successful pass reaches PDM/BLE/IMU
shutdown or the IMU-setup failure's reboot fallback. A failed flush keeps the
sensor awake, reopens control dispatch, resumes paused work, and waits thirty
seconds before another sleep attempt. Partial averaging groups and queued BLE
frames from before the pause are discarded on resume. Unchanged values use ZMS
duplicate suppression; initial missing defaults may be stored during this flush.

Host faults cover every setting and all 34 full-trace writes, before commit,
after commit, and with torn data. Successful retries restore the complete
snapshot through the actual counter, queue, and trace decoders. The SDK ZMS
model also restores a flushed counter, backlog, and full trace after capacity/GC
stress; an unchanged second flush adds zero writes/erases. Zephyr workqueue
interleavings, physical sleep/wake, control errors, and battery impact remain
unverified. Abrupt power loss is still outside this orderly shutdown barrier.

Startup now waits for storage recovery before BLE, acquisition, or application
persistence. `firmware/src/boot_restore.c` restores twelve ordinary values, ten
legacy trace keys, then chunked traces in up to three passes with one-second
delays. Each pass resets existing RAM to defaults before applying values.
Missing keys are normal for fresh devices. Malformed tunings/legacy traces retain
defaults; malformed counters/shot queues and read errors keep startup closed to
avoid replacing unread IDs/backlog with zeros. Exhaustion waits thirty seconds
before another batch, with a double-pulsing user LED until recovery succeeds.

NCS v3.3.0's Settings bulk loader discards backend errors; its single-key name
lookup also treats negative ZMS reads as missing names. The boot-only
`firmware/src/settings_read.c` uses the mounted filesystem from
`settings_storage_get()`, the SDK hash, and existing Settings/ZMS ID macros to
preserve those errors. It searches all collision positions, compares complete
names, checks lengths, and rejects an existing name without a value as malformed.
CMake includes the pinned SDK's internal Settings/ZMS header; changing SDK,
backend, or layout requires rechecking compatibility. Existing keys/layouts and
`settings_save_one()` writes are unchanged. SDK mount/list repair can write its
own metadata. Application restoration stays read-only until every read and ID
validation passes; only a recovered capture-ID change is then saved before startup.

Portable startup tests cover all 22 keys, initialization/trace faults, bounded
retries, malformed-value policy, and reset of partial RAM. The extended host
model compiles the unchanged SDK Settings/ZMS backend, ZMS, and Murmur3 hash
with the production reader/coordinator. It passes 752 transient and 752 persistent
public-read faults, restoring counters/backlog/full traces without application
writes. A separate flash-read error demonstrates the SDK's missing-name behavior
and strict reader's error propagation. Legacy counters, collision holes/final
positions, incomplete values, and destination bounds are covered. Physical
startup delay, LED signaling, and read-error behavior remain unverified; the
single-threaded host model does not run Zephyr startup or Settings locking.

Every detected shot is queued in this log regardless of connection state, so a
dropped live shot-event notification (e.g. the release impulse glitching the BLE
link without a full disconnect) is still recoverable. The browser acks live
shots too, so on the happy path the shot leaves the queue almost immediately. To
avoid a shot-log RRAM write on every shot while connected, the log persist is deferred
~3 s: if the shot is still unacked when the timer fires, the firmware persists
the log and sends a storage-status frame, prompting the browser to drain the
backlog via `shotdump`. Acknowledgments still schedule a save to remove any
durable backlog; unchanged empty queues are suppressed by ZMS. The in-RAM queue
and the ack/retry path can recover a lost live frame without a reconnect.
Buffered traces freeze after a configurable post-release follow-through delay
(default 1.5 s, stored as `openfloat/followms`) so the saved window contains
both the pre-shot hold and the recovery after the release impulse. Each
firmware trace point is an 8-byte record (`roll/pitch/yaw` in centi-degrees,
`mic_amp` u8, and elapsed milliseconds u8). The browser stores the same motion trace in IndexedDB
`shot_traces.payload` and, for connected shots, a full-rate `mic_series`
window (`[{ tUs, micAmp }]`, microseconds relative to the shot) for acoustic
timing work in the web app.

The high-pass filtering, post-trigger vibration verification, and the structured
multi-field shot-event payload (peak_g, timestamps, sample windows) are still to
do; shot events currently ride the live characteristic by type byte rather than
a dedicated shot-event characteristic.

## 8. BLE GATT Protocol

OpenFloat should expose one custom BLE service with versioned characteristics.
To handle transient connection drops and guarantee robust link recovery:
- **Firmware advertising retry**: Upon disconnection, the firmware schedules BLE advertising using a delayable work queue (`adv_start_work`) after 250 ms. If the BLE stack is busy or not ready, it retries starting advertising every 1000 ms, canceling the scheduled retries only when a client successfully connects.
- **Stale connection cleanup**: If a central disables live notifications but leaves the BLE link open, the firmware disconnects that idle central after a short grace period and returns to advertising. This prevents the sensor from being trapped in a connected-but-not-streaming state.
- **Browser auto-reconnect**: If the link drops unexpectedly, the web client updates the status badge to `"BLE reconnecting..."` and triggers up to 6 reconnection attempts using exponential backoff (`Math.min(1000 * 2^attempts, 8000)` ms: 1s, 2s, 4s, 8s, 8s, 8s). If successful, the live stream resumes. If all 6 attempts fail, the status returns to `"Disconnected"`, indicating that the user needs to manually initiate device selection by clicking the status badge.

Browser connection attempts and control writes are scoped to a connection
generation. Disconnect invalidates pending setup, removes notification handlers,
and releases the control queue immediately. A late picker/GATT result or retry
cannot start an abandoned connection or write to the replacement link. The app
also checks the selected transport before applying settings or handling setup
errors. Battery notifications and reads are optional; their failure does not
prevent live telemetry. Automated checks simulate these races without hardware.

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
Live             8f3f3b10-0f5a-4f4c-9a2d-000000000002  notify  (20-byte live frames, 29-byte non-live frames, typed)
Control          8f3f3b10-0f5a-4f4c-9a2d-000000000003  write   (ASCII commands)
Battery Service  0000180f-0000-1000-8000-00805f9b34fb (Standard BLE BAS)
  Level Char     00002a19-0000-1000-8000-00805f9b34fb  read/notify (0-100%)
```

Firmware UUID encoders use 64-bit literals for the final 48-bit field, including
the advertised service, to avoid undefined shifts in Zephyr's initializer.
The application build rejects oversized shifts. `tools/verify_ble_uuids.py`
reads the compiled GATT objects and advertising payload from the unstripped
ARM32 ELF and compares them with the browser and both Python clients. Firmware
CI runs this check before uploading the image. The UUID values above are
unchanged; compiled-byte checks do not prove radio discovery on hardware.

The live characteristic carries typed binary frames, demultiplexed by the
type byte: type 1 live sample (batched 6/notification), type 2 shot event (sent
on each detected shot), type 3 count sync (sent on subscribe so the persisted
lifetime count displays immediately without logging a shot), type 4 stored
shot upload (sent one at a time until the web app acknowledges each save), type 5
storage status (sent on connect/request to sync queue counts), and type 6 trace
chunk (sent sequentially to stream buffered shot traces with pre-shot hold and
post-release follow-through).

### Shot metadata counters

Protocol-2 shot events (Type 2) and count syncs (Type 3) keep the 29-byte envelope
and transmit 32-bit counters as two little-endian 16-bit halves:

| Offset | Field |
| --- | --- |
| 4 | Lifetime count, low half |
| 6 | Shot ID, low half |
| 22 | Shot ID, high half |
| 24 | Lifetime count, high half |
| 26 | Release sequence for Type 2; zero for Type 3 |

The motion, threshold, and orientation fields at offsets 8-21 are unchanged.
Offsets 22 and 24 previously held reserved clicker/impact timing words; their
decoded values are now `null` for protocol 2. Protocol-1 shot events retain their
original layout. Protocol-2 storage status (Type 5) carries the count's high half
at offset 18; its queue and upload-ID fields are unchanged.

Stored-shot uploads (Type 4) remain protocol 1: the full shot ID uses offsets 6
and 26, while the historical count remains 16 bits. Once a live event, count
sync, or storage status establishes the current device count, historical uploads
do not replace it. Explicit count corrections, including zero, still apply.
This runtime precedence resets on disconnect and needs no storage migration.

Full live IDs prevent truncated acknowledgments and duplicate stored captures
above 65,535 shots. Update the browser before flashing this firmware: older
dashboards cannot decode the upper halves. The updated browser also reads older
firmware; unsupported metadata versions are rejected instead of acknowledging a
guessed ID. Host C, browser, and Python checks cover counter boundaries, and the
NCS build passes. Physical rollover and reconnect checks remain pending.

Binary decoding accepts only defined version/type pairs. Live samples use
protocol-1 Type 1 (29 bytes) or protocol-2 Type 1 (20 bytes); trace status uses
Type 7 in protocols 1 and 2. Unknown versions or types cannot become live
samples, acknowledge captures, or end a pending replay. The Python bench client
also rejects those headers instead of assuming a frame length, then scans for
the next supported frame. Native browser checks verify that capture ID zero
after wrap saves once, keeps the current count through a historical upload, and
receives its replay and acknowledgments under the same ID.

The Python bench parser assembles complete binary records and text lines across
notification boundaries before decoding. It retains split magic/header bytes,
keeps printable characters and newlines inside a known binary payload, and can
process mixed records in one notification. Pending text is limited to 4 KiB;
oversized lines are skipped until their newline or a binary header. Host checks
exercise both live formats at every two- and three-fragment split and feed
fragmented metadata from the actual C encoder. Physical BLE checks remain
separate from these stream fixtures.

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
* `tracetimed:<shot_id>`: Request recorded millisecond timing, the release reference, and a CRC-protected trace through protocol-2 Type 6 notifications.
* `tracereq2:<shot_id>`: Request an untimed compatibility trace as protocol-2 Type 6 notifications, with 32-bit shot IDs and 16-bit chunk indexes/counts.
* `tracereq:<shot_id>`: Legacy protocol-1 Type 6 transfer. Limited to 255 chunks (692 current 7-byte points); updated firmware returns status 2 for larger traces instead of wrapping the count.
* `shotack:<shot_id>`: Acknowledge a saved type-2/type-4 shot so firmware can free the queued copy from RRAM.
* `shotreset`: Clear the persisted shot count and shot queue, preserving the capture ID.
* `shotset:<n>`: Set the persisted lifetime count from `0` through `4294967295`, preserving the capture ID.

Numeric tuning writes validate the complete argument before mutation or deferred
persistence. Toggle/rate values require unsigned decimal digits and the supported
options. `sleeptime` and `followms` parse signed 32-bit decimal integers, then keep
their documented clamps. Threshold and sensitivity commands parse finite decimal
floats (including exponents) before clamping. Whitespace, suffixes, hexadecimal
notation, non-finite values, and conversion range errors return ATT Value Not
Allowed (`0x13`). Thus `autosleep:oops` cannot disable sleep, and `thresh:nan`
cannot disable release detection.

The eight persisted tuning keys (`wakesens`, `sleeptime`, `sleepsens`, `bufrate`,
`bufnvs`, `autosleep`, `streamrate`, and `followms`) require complete four-byte
reads and supported values on boot. Sensitivities use milli-g and the timeout uses
milliseconds. Invalid records leave their initialized defaults in effect;
`streamrate:0` cannot reach the live-loop modulo operation. Calibration offsets
also require complete reads. Host checks cover syntax, finite values, overflow,
and persisted ranges; physical GATT rejection and reboot checks remain pending.

The default firmware configuration disables the UART console for battery-safe
boot on XIAO nRF54L15 hardware. Use `firmware/prj_uart.conf` as an overlay for
USB bench debugging when serial logs are needed.

The standard Battery Service (BAS) periodically reads the battery voltage from pin `P1.14/AIN7_VBAT` using the regulator switch `vbat_pwr` (`P1.15`), scales the measurement using a $2.0$ divider multiplier, and publishes the percentage value. The dedicated device-info, shot-data, and config characteristics are not implemented yet; shot events ride the live characteristic rather than a separate shot-event characteristic.

### Shot Data Chunking

The implemented extended transfer uses 29-byte little-endian Type 6 frames:

```text
offset  size  field
0       2     "OF"
2       1     protocol = 2
3       1     type = 6
4       4     shot_id (uint32)
8       2     chunk_index (uint16, zero-based)
10      2     total_chunks (uint16)
12      1     payload_length (1-15 bytes; 15 except the final chunk)
13      1     format (7 = untimed angle/mic; 0x88 = timed stream below)
14      15    payload, unused final bytes zero-filled
```

Concatenate payloads in chunk-index order before decoding points; point boundaries
can cross chunks. An untimed 1,000-point buffer is 7,000 bytes in 467 chunks. The browser
validates envelope bounds, consistent counts/stride, duplicate contents, and whole
points before committing. Identical duplicates and out-of-order delivery are
accepted. Only the actively requested shot/protocol enters reassembly, and stale
status messages cannot finish a newer request. Untimed compatibility transfers
rely on BLE link integrity. Format `0x88` adds an end-to-end CRC.
Every trace request, including a retry on the same link or a fallback format,
emits a synchronous runtime `trace-start` event before its control write.
Telemetry clears that shot's previous assembly while preserving metadata
associations and other shots' buffers. A superseded complete assembly still
waiting for metadata cannot enter a local write after the new attempt begins.

The browser requests `tracetimed` first, then `tracereq2`, then `tracereq` after
1.5 seconds without a response at each step. It keeps the supported request mode
for the rest of that connection. Timers start after the queued control write
completes; a running transfer has an 8-second inactivity timeout. On reconnect
it probes timing support again. An automatic reconnect to the same selected
device retries interrupted acknowledged traces with fresh chunk buffers. Their
exact local capture IDs remain pending until the replay commits, including a
drop after the final chunk but before the local save. A transfer timeout also
retains its ID because the OS may report the radio drop later; an explicit
unavailable reply or a changed chunk count ends that recovery attempt. Captures
already completed, deleted, or changed to a different device shot are skipped.
This recovery context is kept in memory by the adapter; a manual disconnect,
transport change, or page reload discards it. Recovery still depends on the
sensor retaining the trace.
Legacy Type 6 has a 16-bit shot ID, 8-bit index/count, length at byte 8, up to 19
payload bytes at 9-27, and chunk-zero stride at byte 28. The active request maps
its truncated ID to the full saved ID. Existing firmware needs this update for
reliable recovery above 692 points. Type 7 status carries the full shot ID at
bytes 4-7 and status at byte 8: 0 means unavailable, 2 means a legacy transfer
cannot represent the trace.

The `tracetimed` payload has this little-endian structure before chunking:

```text
version u8 = 1
flags u8 (bit 0 = timing available; other bits reserved)
point_count u16
first_time_ms i32 (relative to recorded release)
points[point_count]: roll i16, pitch i16, yaw i16, mic u8, dt_ms u8
crc32 u32 (CRC-32/ISO-HDLC over all preceding payload bytes)
```

The first point's delta is zero. Subsequent deltas accumulate from
`first_time_ms`. A full trace is 8,012 bytes in 535 chunks. The browser validates
the version, flags, count, exact length, first delta, and checksum before saving.
It preserves timestamps as release-relative `tUs`, estimates a descriptive
sample rate from the recorded span, and marks the source `firmware-timed`.
Motion and microphone envelopes share those timestamps; replay and release
markers use them directly. Angle-only captures still cannot supply a full
Float Score.

Firmware timestamps are the monotonic device uptime at trace sampling and shot
detection, rounded down to milliseconds. They describe processing time at FIFO
drain, not a new per-sample hardware timestamp. Rate changes and ordinary jitter
remain in the deltas. Gaps above 255 ms start a new trace window instead of
wrapping into a false short interval. The millisecond clock's 32-bit wrap is
handled by unsigned subtraction. Release markers stay hidden when the retained
window does not span the event.

The in-memory trace is a versioned 8,012-byte struct at full capacity. Boot can
restore previous 7,008-byte single-value records into this format with timing
unavailable; `tracetimed` sends these with flags zero, so the browser retains the
legacy 52 Hz assumption and `firmware` source. The default 4,096-byte ZMS sector
limit rejected those old oversized single-value writes; the new writer stores
only the 12-byte header and populated points in pieces of at most 512 bytes.

The 64 KB settings partition retains up to **four complete traces**, while
powered RAM retains ten. Four slots leave room for ZMS garbage collection, the
maximum 100-shot compact log, and ordinary settings. A conservative host model
running the actual SDK ZMS code passes 100 full-trace saves, shot-log updates,
and remounts. Five trace slots caused fragmented-space failures for the compact
shot log in that model, despite its reported free-byte count.

Storage keys are bounded: `openfloat/ts0/0` through `openfloat/ts3/15` hold trace
pieces; part `16` holds each slot's 20-byte little-endian manifest. The manifest
is `OFT1`, generation u32, shot ID u32, used byte count u32, and CRC-32/ISO-HDLC
over its first 16 bytes followed by the used trace bytes. Replacing the oldest
slot first invalidates its manifest and clears its pieces, preserving the other
three complete slots. All replacement pieces must succeed before publishing the
new manifest. Interrupted, missing, truncated, and checksum-invalid records are
ignored at boot. Generations are integrity checked before restoration in commit
order, so newer captures win when a shot ID or RAM slot is reused.

New traces persist one at a time off the IMU loop, with at most three attempts
per capture and a one-second delay after failure. Exhausted failures remain
marked unsaved for the sleep flush. The portable persistence queue selects
oldest pending captures across generation wrap, saturates retry counters, and
changes each slot's token when it is reused; old write completions cannot clear
or retry a newer capture. Reuse deliberately retires the old RAM slot. Empty
trace windows create no persist job. Turning buffering off stops future trace
requests; previously requested unsaved captures remain eligible for the flush.
Persistent buffering defaults
on for fresh firmware (`bufnvs:0` disables future trace writes); stored user
preferences still apply. The partition size and sector layout are unchanged,
and legacy records are read without rewriting them on boot. Older firmware
cannot read the new chunked keys after a downgrade.

Capture, persistence, and upload use short protected RAM copies. RRAM writes
and BLE notifications run against separate immutable snapshots. Request
generations prevent a finishing notification from advancing a newer upload.
The C ring, restore, encoder, and interrupted-write storage are tested on the host; an emitted full wire
transfer is decoded by the real JavaScript parser. Native IndexedDB/review tests
and an NCS build also pass. On-sensor timing, retention, and throughput remain
to be verified.

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
  - optional per-arrow target result entry and session form-to-score analysis
  - adaptive training tab (recent-shot weakness analysis, Steady Aim, Level
    Lock, and Settle & Hold drills, countdown, live target trace, drill-specific
    scoring and cues, save to IndexedDB)
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
decodes compact binary frames (20-byte live samples batched in 120-byte
notifications, plus 29-byte shot-event, count-sync, storage-status, stored-shot,
and trace-chunk frames); those BLE frames carry the on-board Madgwick filter
quaternion as the canonical orientation value. The browser derives Euler angles
only for readouts, scoring, and compatibility with older saved trace records.

Sensor connection attempts check the exposed Bluetooth picker API, the page's
secure context, and an available permissions-policy API before disconnecting an
adapter or resetting telemetry. Missing or blocked access shows a dismissible
notice, explains the cause, and focuses browser help on request. Scrolling
accounts for the wrapped sticky header so focused help remains visible.
iOS guidance accounts for iPads using a desktop user agent; an available picker still takes
precedence over browser identification. Dismissing the notice returns focus to
the sensor control, and a later attempt reopens it. The notice links to Quick
Start's browser compatibility section, including on repeated activation. Demo
and local saved-data operations remain available. The check requests no device
access and changes no browser or hosting permissions. Browser capability does
not prove that a sensor or Bluetooth radio is ready. The helper and Guide are
precached for offline use; transport and storage formats are unchanged.

The app also includes local bow
profiles, timestamp-derived practice sessions, manual trace recording, saved
shot review/compare, adaptive hold training (`app/ui/training.js`) backed by
testable recommendation and drill-scoring rules (`app/ui/training-coach.js`),
Bow Shop 3D customization, independent OpenFloat Float Score metrics, session review
summaries with score trend plots, and an optional Supabase-backed sync queue
configured from the Cloud modal. Additionally, a Progressive Web App (PWA)
service worker (`service-worker.js`) is registered to cache all core markup,
styling, modules, and the 3D bow model. It uses network-first same-origin
fetches with cached fallback for network failures and HTTP server errors, keeping
offline range use while allowing versioned app assets to update promptly.
Fallback reads and upgrade cleanup use only OpenFloat's caches. Runtime cache
writes extend the worker lifetime; a storage-limit failure leaves a successful
network response usable. An uncached server error keeps its HTTP status, and
404 responses are not replaced with obsolete cached files. Each new worker
fetches precache assets, the Guide index, and Markdown pages with `cache: reload`
so an older HTTP cache cannot seed the new deployment's offline content.

The Guide resolves links and images relative to each Markdown source, routes
indexed guide links through `#/guide/<id>` (with optional heading anchors), and
leaves other files and external links available in a new tab. Section scrolling
accounts for the sticky header's current height, including its mobile layout.
Its small renderer escapes raw HTML and attributes, preserves literal inline
code, and allows only
HTTP(S) link/image destinations. Markdown pages and the Quick Start screenshot
are precached. Page-load generations protect the selected guide from delayed
responses, including cached-page switches; reopening Guide retries failed index
or page requests. Root URLs derive from the module path so a subdirectory host
and the browser test page use the same static assets.
The 3D views use a pinned local copy of Three.js 0.164.1 and its GLTF loader,
orbit controls, and buffer geometry utility in `vendor/three/`. All four modules
are precached, so an offline reload does not rely on a third-party CDN or the
browser's HTTP cache. The upstream MIT license and archive integrity are kept
with the files. This adds static assets only; there is no build or install step.

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

BLE captures use `OpenFloat-BLE:<BluetoothDevice.id>` in the existing `device_id`
field. Recent stored-upload matching compares that key and the full capture ID;
replay resumption also checks the exact local capture and device key. Device
names do not identify captures. The adapter includes identity on notifications,
which can precede live status. Metadata saves snapshot it before storage waits;
manual recordings and Steady Aim holds retain their starting device through a
delayed Save. Their queued uploads preserve the same field without a new column
or IndexedDB schema change.

[Web Bluetooth device identity](https://webbluetoothcg.github.io/web-bluetooth/#bluetoothdevice)
depends on the browser's origin and permissions. Another browser/profile or
cleared permissions can produce another key; cross-browser continuity needs a
firmware-provided identifier. The existing 24-hour replay deduplication window
still limits reused counters after a firmware reset. Generic `OpenFloat-Sensor`
captures remain unchanged, and Serial retains that fallback. Known BLE devices
do not adopt unidentified legacy records; a first legacy re-upload can therefore
save a separate capture. Physical multi-sensor verification remains pending.

The Recent Shots list is reactive. When a connection is active (serial or BLE) and the device detects a shot, the adapter parses and relays the event onto the global `EventBus` as a `"shot"` event. The `TelemetryStore` listens to this event, deduplicates against device shot IDs already handled **this connection**, writes the shot to IndexedDB with `session_id: null`, and emits a `"shot-saved"` event. Current firmware preserves capture IDs across count corrections and resets; older firmware and erased device settings can still reuse IDs, so all-time deduplication by ID is unsafe. The dashboard UI listens to `"shot-saved"` and instantly updates the Recent Shots grid. Practice sessions are no longer tracked live - they are derived from shot timestamps when the Saved Shots history is rendered (any gap over 30 minutes starts a new session), and the user can rename a session and assign its bow, stored as a per-group override.

While connected, the browser captures the trace from the live stream and saves it to IndexedDB shortly after the configurable follow-through window, then emits `"shot-trace-saved"`. Firmware also freezes a RAM trace for every detected shot and persists it when `bufnvs` is enabled, regardless of connection state. Connected browser captures keep about 3.5 seconds of pre-shot hold plus the configured follow-through window; the 20-second live trace buffer is retention headroom, not the saved shot duration. (Shots taken while disconnected are stored on-device and their traces upload on reconnect.) Trace payload points carry `tUs` relative to release so motion and audio envelopes share the same review time axis. For BLE, the browser aligns that release time with the `shot_sequence` embedded in the type-2 frame; for serial it aligns with `OFSHOT.uptime_us`; older firmware falls back to the closest matching buffered release sample. Because a just-detected shot becomes clickable before its browser trace is persisted, opening a recent shot polls briefly for the trace before reporting it unavailable. Manual captures also trigger `"shot-saved"` upon save.

Saved-shot history derives practice sessions from timestamp gaps. Each session renders a review summary: average Float Score, best shot, worst shot, consistency trend, shots by drill label, biggest recurring issue, and a compact Float Score plot across the session. The score is an OpenFloat-specific v1 metric (`openfloat-float-score-v1`) derived from hold stability, release quality, follow-through control, and level consistency; it is not modeled on a commercial scoring system.

Saved scores and their components are available only when they contain a finite
number (or a nonblank numeric string from an import) in the range 0-100. A real
zero remains valid. Missing, malformed, or out-of-range scores display as `--`
and do not contribute to session averages, rankings, training recommendations,
or form-to-target correlations. Session summaries expose scored-capture counts,
and plots leave gaps for missing scores. Only unversioned legacy records can
fall back from a missing `shot_score` to `stability_score`; versioned captures
await their own saved score. These read-time rules do not rewrite saved records.

New device events save null form scores, components, stability, and packet-loss
counts until their own browser trace is committed. They never copy the current
live dashboard score. The browser trace supplies the full v1 score and uses
hold stability for the capture's displayed stability. Current firmware recovery
traces contain orientation and optional audio, without acceleration or rotation
rate; they remain reviewable but cannot supply the
full v1 score. Stored events without a recorded yaw also leave yaw unavailable
instead of borrowing the orientation at upload time. Existing saved records
are preserved.

Firmware recovery never overwrites a nonempty `source: "browser"` recording
for the same capture. This check runs inside the trace write transaction, so
browser recordings win regardless of arrival order. Skipped recovery writes
leave scores, replay, and queued uploads unchanged. If the browser recording
is missing or empty, the available firmware trace is retained normally.
Untimed firmware uploads also preserve a nonempty `firmware-timed` recording,
so compatibility fallback cannot discard previously measured timing.
Trace progress logs use isolated notifications, so a failed logger cannot strand
an assembled firmware transfer. After a successful trace transaction, view
listeners settle independently through `EventBus.emitAsync()`; failures retain
the committed trace and queued upload and explain how to refresh the views.
Both browser and firmware trace commits can start background sync without
waiting for uploads. Failed trace transactions emit no saved-view notification
or sync trigger and leave firmware transfers available for retry.
History owns review refreshes and reads the latest committed capture and trace
together. Delayed writers never copy their older samples or scores directly
into an active review. An unchanged recording keeps manual markers and playback
during ordinary trace notifications as well as restores; a changed recording
still stops playback and recalculates its time axis and release phases.

Review release phases use one shared decision for the target, thumbnail,
comparison, waveform, and scrubber. Explicit holds (including legacy manual
labels) have no release phase. Automatic browser arrow traces use the sample
nearest their recorded event time (`tUs: 0`), as do `firmware-timed` arrow traces;
the time-axis marker stays at the exact event time between samples. Other full
traces require a measured acceleration impulse above the capture threshold.
Untimed firmware traces carry no release reference. Both firmware decoders
preserve angles and audio without adding acceleration placeholders. Their Motion view plots
angles, and old firmware records with decoder placeholders are also treated as
angle-only data. No percentage-of-trace fallback invents a release. Existing
saved data is preserved; these changes affect decoding and review.

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
  user_id
  session_id
  device_id
  device_shot_id
  capture_kind      (arrow or hold; null for older untyped records)
  timestamp
  peak_g
  cant_angle_deg
  pitch_angle_deg
  yaw_angle_deg
  roll_angle_deg
  stability_score
  shot_score
  hold_stability
  release_quality
  follow_through
  level_consistency
  score_version
  stored_upload
  packet_loss_count
  label
  arrow_score
  arrow_is_x
  target_distance
  target_distance_unit
  target_face_cm
  outcome_recorded_at
  impact_x          (normalized target radius, positive right)
  impact_y          (normalized target radius, positive high)
  impact_recorded_at

shot_traces
  shot_id
  user_id
  encoding
  sample_rate_hz
  source
  has_mic
  mic_sample_rate_hz
  mic_series   (gzip+base64 text, see encoding)
  payload      (gzip+base64 text, see encoding)
```

The authoritative, idempotent schema (including the row-level security policies
that scope every table by `user_id = auth.uid()`) lives in
[`supabase/schema.sql`](supabase/schema.sql). Run that file in the Supabase SQL
editor — it matches exactly what `app/telemetry/sync.js` uploads, so no field is
silently dropped. The column list here is descriptive; the SQL file is the
source of truth.

**Client session model (current implementation):** the local IndexedDB no longer
tracks live `sessions`. Shots are saved with `session_id: null`, and practice
sessions are derived from shot timestamps at display time (any gap over 30
minutes starts a new session). A `session_overrides` object store keyed by each
group's earliest shot id holds the user-edited `name`, `bow_profile_id`, and
optional `arrows_per_end` (3 or 6, default 3). Scorecard ends group arrow captures
in chronological order; training holds are excluded and unscored arrows keep
their positions. These are display groups, not inferred hardware end events.
Changing the group size preserves session name and bow, and local backups
include the setting without an IndexedDB version change. The
cloud `sessions` table above remains the recommended server model for future
sync; the local schema favors timestamp-derived grouping so no manual
start/stop is required.

Late earlier captures can change a group's earliest id without a user edit.
History, review speed, and edits first use settings explicitly saved at the
current anchor, including cleared fields. If that record is absent, they use
the earliest member capture with saved settings. A bridging capture can merge
former groups; this rule selects one context rather than combining their names,
bows, or scorecard settings. Original context records remain available for
future splits and full backups. Reads do not migrate or write those records.

Session name, bow, and scorecard edits patch the latest override in a single
transaction with the group's surviving captures. The transaction resolves the
current group anchors from those captures, so an older capture arriving before
the save can become the new anchor. The edit targets the current group and
preserves the inherited settings unless the current anchor has explicit values.
If deleting captures splits the edited group, its surviving fragments receive
the patch together; removing the whole group cannot create an orphan override.
These overrides remain local display settings and do not create cloud-session
upload tasks. A missing historical bow remains selectable as an unavailable
profile, so a name-only edit does not clear its reference.
Pending session actions stay disabled across history refreshes. Write failures
retain the session draft, and a failed history read retains displayed rows and
drafts with a retry message. A committed edit stays saved even if its follow-up
history read fails. Backups retain the same schema and include these settings.

**Local transaction guarantees:** storage helpers resolve writes, deletes, and
sync-status changes only on IndexedDB transaction completion, so request success
alone cannot trigger a sensor acknowledgement. A full backup or single-shot
import uses one transaction across its affected stores. Synchronous key or clone
errors explicitly abort that transaction, preserving existing data even during
a replacement import. Import validation rejects unsupported format versions,
malformed record lists, and a single-shot trace whose `shot_id` does not match.
Failed database opens can retry, and connections close on version changes so
another tab can upgrade without being blocked by an idle OpenFloat tab.
Arrow outcome edits read the latest saved capture, patch the target fields, and
queue that exact record in one write transaction. A queue failure rolls back the
score and impact; an edit cannot recreate a capture deleted from another view.
Remembering target-form defaults is optional and cannot turn a committed result
into an apparent save failure.

Saved review reads collect capture metadata, the selected trace, session
settings, and bow profiles in one readonly transaction. A restore refreshes the
open capture and comparison from saved data. Changed or missing recordings
replace the old trace and stop playback; an unchanged recording retains manual
markers and playback while applying restored metrics and bow speed. Clean
target forms show the restored result; unfinished edits and keyboard focus stay
in place. A capture restored as a hold no longer exposes arrow-result controls.
After an outcome write, review reads the latest committed data, so a delayed save
callback cannot replace a newer restored result. Save & Next uses the refreshed
session order. Failed view reads or sync attempts leave the committed result
saved locally and provide a refresh warning when needed. Database schema 2 and
export format version 1 remain unchanged.

Tabs sharing this browser's database refresh after another tab commits capture,
trace, session-setting, or bow-profile changes. BroadcastChannel notices contain
only affected store names and use the actual database name, keeping temporary
test databases separate. Views read their own committed snapshots; notifications
do not carry capture contents or create device acknowledgements or upload work.
Readonly transactions, sync-queue status changes, and aborted writes send no
saved-data notice. A tab's own notices do not repeat its existing UI events.
Refreshes coalesce nearby changes, wait while the page is hidden, and serialize
reads so a notice received during a refresh gets a following read. Returning to
the tab also refreshes data, including changes from older tabs or browsers where
messaging is unavailable. Page-cache suspension closes the channel; resuming
reopens it and reads saved data. Failed refreshes can retry on focus or navigation.
The adaptive training recommendation also refreshes after restores and peer
changes, and ignores older reads that finish after a newer recommendation.
Superseded bow-profile reads are ignored without reporting a refresh failure;
current read errors still provide a retry message.

Bow profile creation, edits, and deletion also commit with their ordered upload
tasks in one transaction. Edits preserve existing metadata and cannot recreate
a deleted profile; deletion keeps historical shots and session bow assignments.
The profile form ignores outdated detail/list responses, preserves unsaved
drafts on refresh or write failure, checks its numeric bounds, and disables
conflicting actions during a save or delete. Remembering the active bow is
optional and does not change the result of a committed operation.

Device metadata and its upload task also commit together before acknowledgement.
Concurrent repeats of a device shot share the pending save. The connection keeps
the exact local capture id for each acknowledged device id; firmware traces wait
for pending metadata and never fall back to an unrelated older capture with the
same device counter. Reconnection starts a new association map and live buffers.
Before restarting an interrupted acknowledged trace, the adapter sends a
runtime `trace-resume` request with its saved local ID and device shot ID.
Telemetry verifies the exact metadata and checks for a missing or empty replay,
then restores only that association. A disconnect or newer association during
the lookup cancels the old decision. Lookup failures preserve the pending
transfer for a later automatic reconnect. A committed `shot-trace-saved` event
removes it even if the link has already dropped; receiving every chunk alone
does not establish a local commit. Neither event adds storage fields or changes
the firmware commands.
The pending metadata promise resolves after its local write, independently of
saved-view callbacks, so a busy view cannot delay firmware trace recovery.
Logging and callback failures cannot hide a committed id, stop other save
listeners, or turn a successful write into a storage error. Repeated metadata
returns the same local id and re-acknowledges without another write or upload.
Background sync failures retain the queued upload for retry.
Stored metadata repeats check the existing capture's replay before deciding
whether to request its retained firmware trace. Missing or empty recordings
request recovery under the same local id, including after a lost acknowledgement
or a live metadata save whose browser trace never arrived. Nonempty browser or
firmware recordings only re-acknowledge; duplicates already in the transfer
queue do not start another download. Deleted captures stay deleted. A trace
read failure attempts recovery without rewriting metadata, and the connection
generation is checked again after the lookup. The `traceNeeded` event flag is
runtime-only; storage schemas and firmware commands are unchanged.
BLE shot notifications carry the receiving adapter's runtime identity and
connection generation through the save notification. The adapter ignores a
notification from another adapter or an earlier connection, and stops processing
the rest of a packet if its connection changes. This identity stays on the event
bus; saved metadata, upload payloads, exports, and the wire protocol are unchanged.
Delayed browser captures retain their original motion, microphone, and loss
samples, and cannot update a different connection's live metrics.
Late trace saves read the current capture and commit replay, metric patches, and
upload tasks together. Newer arrow outcomes survive; a deleted capture is skipped
without recreating metadata, an orphan trace, or upload work. These are browser
storage guarantees verified with simulated device events; physical reconnect and
trace-transfer behavior still needs sensor testing.

**Local capture deletion:** single, bulk, and demo cleanup remove shot metadata,
traces, matching shot/trace upload tasks, and deleted session anchors in one
transaction. A failure rolls back the complete selection. When deleting an
anchor or splitting a group, each surviving session inherits the original
name, bow and end-size settings; an existing context in a surviving group takes
precedence. This also carries inherited settings when a late capture moved the
anchor and the original context's capture is deleted. Missing capture times
form separate groups, and timestamp ties use shot ids to keep anchors stable.
History, scorecards and recent captures refresh
after commit. The uploader rechecks each queued record before sending it, so a
deleted pending task is skipped even if it appeared in an earlier snapshot.
Deletion is local only: cloud copies and uploads already in flight are unchanged.

**Selected capture exports:** subset files use `openfloat-export` version 1 and
the existing Settings import path. One read transaction collects selected
`shots`, matching `shot_traces`, referenced legacy `sessions`, original
`session_overrides` whose capture is selected, and referenced bow profiles,
including profiles assigned directly to a shot.
Missing traces are allowed; missing selected shots fail the export. Other
captures and upload queue rows are excluded. Overrides retain their original
ids. A partial selection containing neither the current anchor nor a capture
with saved context carries no session name, bow assignment, or end-size override.
If a selected capture is already the
current group anchor but inherits context from an unselected member, the export
includes that context under the current anchor id. This alias exists only in
the file, so it can restore independently without including unselected captures
or changing local settings. When the original context's capture is selected,
its original id is retained without adding an alias. Grouping, inherited
settings, and dependencies are read in the same transaction as the selection.
Restored practice groups are derived from the timestamps present in that browser.

**Single capture exports:** `openfloat-shot-export` version 1 retains the capture
and its optional trace. Both records are collected in one readonly transaction,
so a concurrent save or restore cannot mix earlier metadata with a later trace.
Missing metadata fails the export; missing traces are allowed and reported in
the result. Undated or invalid capture times use an `undated` filename without
changing the saved timestamp. The file restores through Settings as before.

Single and selected exports share a pending-operation guard in Saved Shots and
review. Export/delete controls stay disabled through the snapshot read and
download preparation, including after a history refresh. Repeat events are
ignored. Selected files retain the selection made when export began, while newer
checkbox selections remain in the UI. Read or download failures report inline,
retain selections and unfinished target edits, and allow retry. An earlier
export cannot replace a different review's status or focus. Keyboard focus
returns to the initiating control, or its refreshed history row, only when the
user has not moved to another control. Exports remain readonly and create no
upload work. Backups, single shots, and selected shots share JSON download
cleanup: temporary links are removed, and URLs remain available briefly while
the browser starts reading the file. Storage schema and export versions are
unchanged.

**Backup UI outcome:** import and export share one pending-operation guard.
The Settings controls stay disabled through file reading, the storage
transaction, and the final view refresh or download preparation. Repeated
events cannot start another backup operation in this card. A failed read,
parse, transaction, or export unlocks the controls for retry; file selection is
reset so the same file can be chosen again. After import commits, sync failures
leave its uploads queued and view failures report the records as saved locally.
Refresh failures ask the user to reopen the affected views, without presenting
the committed import as a failed restore. Keyboard focus returns to the
initiating button when the user has not moved to another control. Backup results
use a live status region. Download object URLs remain available briefly for the
browser to begin reading the file before they are released.

**Import and upload ordering:** queue rows in a backup are diagnostic snapshots,
not portable work. Import ignores their numeric ids and actions, preserves this
browser's existing queue, and appends fresh upserts from imported bow profiles,
sessions, shots, and traces in that dependency order. Those tasks commit in the
same transaction as the restored records. An imported correction therefore
follows any older queued version of that record. Sample shots and traces remain
local. Queue processing drains newly added work, retries unfinished `syncing`
tasks after a reload, and uses Web Locks where available to serialize consumers
across tabs. Failed uploads remain pending until another sync trigger; browsers
without Web Locks retain the adapter's per-tab guard.

**Training provenance:** the adaptive coach selects the newest 30 captures with
usable hold or level scores, excluding `sample: true` and the `OpenFloat-Demo`
device id. Synthetic training holds and manual recordings carry both markers;
their traces also carry `sample: true` and `source: "sample"`. The source is
captured while recording, so disconnecting before Save cannot turn a demo into
personal data. The metadata, trace, and optional upload tasks commit together.
These fields reuse existing sample conventions; no database migration is needed.

The coach refreshes after committed metadata, late trace scores, restores, and
peer changes. All of these use the same history read and request guard, so an
older metadata read cannot replace a newer trace-based recommendation. A chosen
drill and duration remain selected. A hold already started retains its drill,
duration, scoring rule, and target through completion and Save; refreshed advice
applies when Training returns to idle. Unmounting removes the trace listener
along with the other saved-data listeners.

**Training timing and interruptions:** the five-second preparation and selected
hold use monotonic browser deadlines, not counts of timer callbacks. A delayed
preparation callback begins a full hold at the actual cue. Only usable, finite
calibrated orientation received within that hold is recorded; post-deadline
movement cannot change its score or saved trace. The first usable frame anchors
the live target. A gap over 1,000 ms from the hold start or previous usable frame
stops the hold, including gaps detected by a resumed frame before a delayed
timer runs. Completion checks continuity through the original deadline, so a
late completion callback does not invalidate a fully sampled hold. At least
five usable frames are required. The gap threshold is a conservative browser
guard and remains an unvalidated hardware assumption, not a certified sensor
sampling rate. Measured zero acceleration remains zero in saved traces.

A training capture's existing ISO `timestamp` records the end of its scored
window, calculated from the browser wall clock at the actual start cue plus the
selected hold duration. It stays fixed while the result awaits Save and across
failed-write retries. A late completion callback or wall-clock correction after
the cue cannot move the capture to another practice session or reorder the
adaptive coach's history. New holds take a fresh cue clock; canceled/discarded
holds leave no timestamp behind. Uploads and exports use that same saved value.
The browser clock remains the UTC reference; this does not synchronize a sensor
clock, change the storage format, or retime existing captures.

Leaving Training, hiding/suspending the page, or changing/disconnecting the
telemetry source cancels preparation and active holds without automatic resume.
Retry guidance uses the training status region. Completed and saving results
survive those transitions; reload warns while a result remains unsaved. Only
active holds animate continuously. Completed/saving canvases redraw once on
completion, visibility, resize, or theme changes. Timers, queued draws, and
delayed success tones are canceled when their work is no longer visible or
relevant, and unmounting removes the module's listeners.

**Training save outcomes:** a failed local transaction retains the completed
hold and its selected settings for Save retry or Dismiss. Feedback stays in the
training status region, and focus returns to Save if the user has not moved it.
Metadata, trace, and upload tasks roll back together. Once `saveCapture` resolves,
the result enters a separate refresh phase; it cannot be written again or
produce an unsaved-result reload warning. Controls stay guarded until the
notifications settle. The event bus's `emitAsync` snapshots listeners, delivers
to each, and settles synchronous errors and rejected promises independently.
A view listener returning `false` also reports a refresh failure. Those failures
keep the saved outcome and ask the archer to reopen the affected views, while
log failures cannot fail a save. Ordinary `emit` remains synchronous for live
telemetry. On completion, focus returns to Start (or the drill selector when
disconnected) only if the user has not moved to another control. Inline status
replaces modal save alerts. Unmounting during refresh preserves the committed
records and prevents late completion from changing detached controls.

**Manual capture timing:** live samples carry cumulative telemetry `tUs` into
manual and rolling buffers. Saved manual traces normalize the first timestamp
to zero, retain measured gaps and the final endpoint, and select points against
a 52 Hz time grid rather than rewriting time from array indices. Motion and
microphone samples keep the same timestamps. The trace's sample rate describes
the retained data; explicit timestamps control replay duration. Rolling captures
prune at 30 seconds of elapsed telemetry time. Demo `dtUs` is measured from
successive timer callbacks, so synthetic recording time follows wall-clock time.

**Replay clock:** 1x playback advances by recorded seconds. The scrubber, target
pin, orientation readouts, 3D bow, and microphone peak meter select samples on
that same time axis. A gap holds the last recorded point until the next sample;
microphone samples outside the current replay time do not appear early. Legacy
traces without usable monotonic timestamps use their saved sample rate (52 Hz
fallback). Saved review arrays are immutable snapshots, allowing the UI to cache
the time axis and use binary search without rescanning a long capture each frame.
Pause, scrubbing and a replacement replay cancel the previous animation loop.
Audio drawing and marker dragging use the union of motion and microphone time
ranges, preserving shorter microphone pre-roll and longer post-release audio.
Dragging updates marker position and range immediately using the speed loaded
for that review. Pointer movement does not query storage or pick up an unrelated
active bow. Mouse and touch gestures are scoped to their starting capture, and
touch cancellation ends the gesture.

Acoustic range review searches the saved full-rate microphone series when
available, with motion-point envelopes as the legacy fallback. It preserves
recorded release/impact times even between motion samples. The first later peak
uses the existing 200-2200 ms window, amplitude 15 peak threshold and amplitude
10 onset threshold. The assigned session bow (or a capture's imported bow
reference) takes precedence over the active profile. Missing or invalid speed
uses 280 fps and explicitly labels it as assumed; an unassigned capture using
the active profile labels it as the current bow. Automatic and dragged markers
share one finite-input-checked model. Its 1125 fps sound speed and 0.075 drag
approximation are unchanged and still require calibration against real target
distances and impact recordings. Acoustic estimates do not set recorded target
distance or arrow outcomes.

Manual recordings stop collecting on disconnect and remain in the current tab
until saved or explicitly discarded. Stopping freezes the capture time and loss
count; a failed transaction leaves it available for retry. Pending saves block
discard and duplicate submission, and unsaved recordings block transport resets.
The browser warns before leaving with an unsaved recording; it is not a durable
draft until the capture transaction commits.
After commit the browser clears the unsaved draft before notifying views through
`EventBus.emitAsync()`. Recording controls and transport resets remain locked
until every saved-view listener settles; a rejected listener or a reported
`false` result produces a local-save confirmation with a view-refresh retry.
Logging and background sync failures cannot reject or repeat the committed save.
Cloud work stays in the durable upload queue, and a late sync failure cannot
replace the next recording's status. Keyboard Save returns focus to Record,
the retained retry button, or Connect Sensor when disconnected, provided focus
has not moved to another control.
New shot records also store `capture_kind: "arrow"` for device release events or
`"hold"` for manual recordings and training. Arrow scoring uses this explicit
type before legacy label/impulse heuristics, so a custom title cannot turn a hold
into an arrow result. Older records remain readable with their existing
heuristics. The field is preserved in local backups and the supplied cloud
schema as nullable `shots.capture_kind` text. Schema upgrades leave older
records untyped rather than inferring a release from their label or peak
acceleration. Existing hosted projects should rerun `supabase/schema.sql`;
until then the cloud compatibility path can omit the field from uploads to a
schema that lacks the column.

If using Firestore, avoid placing large raw traces inside user profile
documents. Store shot metadata and raw traces separately. If using
Supabase/PostgreSQL, normalize sessions, shots, and trace payload references.
The browser currently stores `device_shot_id` so reconnect uploads can be
deduplicated, `shot_score` for the derived OpenFloat Float Score,
`score_version` for scoring-model compatibility, and `stored_upload` to mark
shots recovered from firmware nonvolatile storage. Optional arrow outcome fields
tie each release to its target score and target context without requiring a
separate cloud record. Optional normalized impact coordinates keep the browser
independent of any one target-face diameter while still allowing physical group
size when a consistent face size is known. Session review uses those points for
a centroid, maximum pairwise spread, covariance ellipse, and cautious
orientation-to-impact correlations.
Both form-to-score and direction relationships require at least six paired
arrows with a known, consistent distance and face size. Missing contexts are
never pooled with known ones. Constant scores or telemetry retain their sample
count but produce no coefficient, and scoring trends are withheld for missing
or mixed target setups. Setup comparisons use stored numeric precision rather
than rounded display labels.

For both new and existing Supabase projects, run [`supabase/schema.sql`](supabase/schema.sql).
It is idempotent (`create table if not exists` + `add column if not exists`),
adds every field the client sends — including the ones earlier drafts missed
(`yaw_angle_deg`, `label`, arrow-result/impact context, and a `user_id` on
`shots`/`shot_traces`) — widens
`shot_traces.mic_series` from `jsonb` to gzip+base64 `text`, widens
`shots.device_shot_id` from signed `integer` to `bigint` for the full unsigned
32-bit firmware ID range, and installs the RLS policies. The schema removes the
older global `(device_id, device_shot_id)` unique index. Cloud retries already
upsert the browser's saved capture UUID primary key; the browser's bounded
reconnect matching decides whether an upload belongs to that capture. An
all-time device/shot constraint rejects legitimate ID reuse and another user's
capture from the same sensor. Removing it retains metadata and replay rows,
including older generic sensor keys. Fresh installs, populated integer/index
upgrades, schema reapplication, numeric boundary values, UUID upserts, separate
replays, and RLS isolation have executable PostgreSQL coverage. The database
checks use a local auth shim; they do not certify a hosted Auth or REST setup.

Cloud trace inserts and updates also require that `shot_traces.user_id` and the
referenced capture's `shots.user_id` both match `auth.uid()`. A foreign key checks
existence while bypassing row security; it cannot establish capture ownership
([PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).
The trace policy checks the parent by its UUID primary key under the caller's
ordinary permissions. Existing rows retain their data and owner-based read/delete
access, so their owner can remove an older mismatched trace; inserting, updating,
or moving a trace requires an owned parent. SQL checks reject foreign or missing
parents on inserts, updates, and upserts, including when another trace already
exists. Valid trace retries, edits, deletion, and legacy cleanup remain covered.

Without the current schema the sync
adapter silently drops unknown columns (it retries after stripping them and only
logs once), so cloud rows can end up missing scores, yaw, or labels even though
the upload "succeeds".

## 14. Analytics Roadmap

Initial metrics:

- Peak acceleration.
- Cant angle at release.
- Pitch and roll at release.
- Pre-shot float radius.
- Hold stability score.
- Follow-through movement.
- Packet loss during live stream.
- Adaptive dry-practice prescriptions from recent hold-stability and
  level-consistency scores, with per-drill benchmarks.
- Per-arrow target result, session score totals/trends, and transparent Pearson
  correlations between target score and the four Float Score components. A
  minimum of six paired arrows gates correlation coaching, and the UI reports
  both `r` and `n` with a non-causation caveat.

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

- Implement packed binary live packets. (20-byte v2 frames containing 8-bit accel and quaternions; firmware batches 6
  distinct averaged frames into 120-byte notifications, read via INT1 watermark.)
- Tune BLE connection interval and MTU. (212-byte L2CAP TX MTU, 217-byte ACL
  TX/RX buffers, and 7.5 ms preferred interval are in use; 120-byte BLE
  payloads verified on Windows/Bleak at about 161 notifications/s with zero
  sequence loss.)
- Detect packet loss in the browser and Python client. (Both use the sequence
  field from the v2 live frame, with legacy 29-byte live decoding retained for
  older firmware.)

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
- Add single shot export. (Allows exporting individual shots with their telemetry trace to standalone JSON files from the Dashboard's Trace Review Mode or the Saved Shots list.)

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
