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
  LSM6DS3TR-C native ODR closest to the 400 Hz target). The current experiment
  requests the sensor's **6664 Hz** ODR and averages raw reads into a target
  **1000 Hz** BLE output stream.
- On-device orientation: a Madgwick filter produces a quaternion and Euler
  angles (cant/roll, pitch, yaw) **on the device**, not in the browser.
- Shot detection: a 12 g (117.72 m/s^2) acceleration-magnitude threshold with
  an 800 ms refractory window, surfaced as an `OFSHOT` serial event and a user
  LED pulse.
- Two telemetry transports carrying the same data:
  - **USB / Web Serial**: human-readable `OFRAW` text lines at ~52 Hz
    (every 8th sample) plus `#` comment/banner lines and `OFSHOT` events.
  - **BLE**: a custom GATT service notifying batches of compact 20-byte binary
    frames. The current high-rate experiment batches ten averaged frames into a
    200-byte notification.
- Button-triggered zeroing of cant and pitch offsets.

Verified test clients: `tools/openfloat_ble_client.py` (BLE + serial decoder)
and the Web Serial dashboard in `index.html`.

**Measured high-rate caveat:** on Windows/Bleak with 2M PHY and 217-byte data
length, the raw-register high-rate firmware produced `frames=7500 lost=0
elapsed=8.6s rate=873.0 Hz notifications=750 notify_rate=87.3 Hz bytes=150000
bytes_per_s=17461`. BLE carried 200-byte notifications without loss, but the
current raw I2C polling path still did not reach the 1000 Hz averaged output
target. Hitting 1000 Hz likely requires using the IMU FIFO/data-ready path so
multiple raw samples can be drained per I2C transaction.

**Not yet implemented** (still design targets below): CRC-footed live packets,
validated 800-1000 Hz capture, the on-device rolling shot buffer and shot
replay/transfer, the device-info / shot-event / shot-data / config
characteristics, and cloud sync. Where a section below describes one of these,
treat it as the intended direction rather than current behavior.

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
| IMU | Integrated 6-axis accelerometer and gyroscope (LSM6DS3TR-C) | Running accel + gyro at 416 Hz; range still to be pushed to target 16g+. |
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

**Implemented v1 / current experiment:** the stable baseline sampled accel +
gyro at **416 Hz** (nearest LSM6DS3TR-C ODR to 400 Hz). The current firmware
configures **6664 Hz** accel + gyro ODR through raw LSM6DSL registers, averages
however many raw reads are available in each 1 ms window, and emits averaged
fixed-point frames over BLE. The latest Windows/Bleak run measured about
**873 averaged frames/s** with 200-byte notifications and no sequence loss,
short of the 1000 Hz target with the current I2C polling implementation.

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
ships a simpler **fixed 20-byte, single-sample** frame. BLE notifications
currently batch ten averaged frames into a **200-byte payload** in the
high-rate experiment; text serial emits `OFRAW` lines at a lower diagnostic
rate instead:

```text
offset 0  magic[2]      "OF"
offset 2  proto u8       1
offset 3  type u8        1 (live raw sample)
offset 4  sequence u16   little-endian, wraps at 65536
offset 6  dt_us u16      microseconds since previous sample
offset 8  accel_mg int16[3]   milli-g, scale 1 mg/LSB
offset 14 gyro int16[3]       deg/s in Q4 fixed point (LSB = 1/16 deg/s)
```

There is **no CRC and no flags field** in the v1 frame; sequence is `u16`, not
`u32`. The serial `OFRAW` text line carries the same accel/gyro plus the
on-device Euler angles, quaternion, and shot count. Scale factors are fixed in
firmware for now rather than announced over a device-info characteristic.

`tools/openfloat_ble_client.py` and the browser BLE adapter decode these
batched v1 frames.

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
detected shot increments a shot counter, pulses the user LED, and emits a serial
event:

```text
OFSHOT,proto,shot_id,uptime_us,ax_mg,ay_mg,az_mg,shot_count
```

The high-pass filtering, post-trigger vibration verification, and the structured
shot-event payload above are still to do; there is no BLE shot-event
characteristic yet (shots are observable via serial and the LED).

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

**Implemented v1 GATT** (advertised as `OpenFloat-463D`):

```text
Service  8f3f3b10-0f5a-4f4c-9a2d-000000000001
Live     8f3f3b10-0f5a-4f4c-9a2d-000000000002  notify  (20-byte live frame)
Control  8f3f3b10-0f5a-4f4c-9a2d-000000000003  write   (ASCII commands)
```

The control characteristic currently accepts the ASCII commands `start` and
`stop` (toggle live notifications), `zero` (acknowledged; live zeroing is still
owned by the user button), and `thresh:<g>` (sets the shot detection threshold,
clamped to 2-30 g). The device-info, shot-event, shot-data, and config
characteristics are not implemented yet.

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
  - live dashboard
  - shot review
  - calibration
  - device setup
  - cloud account and sync status
```

The current repository uses a single `index.html`. That is acceptable for the first public prototype. If the app grows, split JavaScript into modules before introducing a framework.

**Implemented v1:** the shipped `index.html` is a **Web Serial** dashboard, not
Web Bluetooth — it opens the device's USB VCOM, asserts DTR/RTS, and decodes
`OFRAW` text (and is meant to decode the binary frame; see the §6 compatibility
note). Orientation is computed **on the device** (Madgwick) and streamed, so the
AnalyticsEngine consumes ready-made cant/pitch/roll/quaternion rather than
deriving them. Web Bluetooth in the browser is still to do; BLE is exercised
today via `tools/openfloat_ble_client.py`.

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

Cloud is optional and should enhance the product rather than gate it.

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
  timestamp
  peak_g
  cant_angle_deg
  pitch_angle_deg
  roll_angle_deg
  stability_score
  packet_loss_count
  raw_trace_ref

shot_traces
  shot_id
  encoding
  sample_rate_hz
  payload
```

If using Firestore, avoid placing large raw traces inside user profile documents. Store shot metadata and raw traces separately. If using Supabase/PostgreSQL, normalize sessions, shots, and trace payload references.

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

- Implement packed binary live packets. (20-byte v1 frames; current high-rate
  experiment batches 10 averaged frames into 200-byte notifications.)
- Tune BLE connection interval and MTU. (212-byte L2CAP TX MTU, 217-byte ACL
  TX/RX buffers, and 7.5 ms preferred interval are in use; 200-byte BLE
  payloads verified on Windows/Bleak at 87.3 notifications/s with zero loss.)
- Detect packet loss in the browser. (Done in `openfloat_ble_client.py` via the
  sequence field; `index.html` binary decode still needs the v1 layout.)

### Phase 4: Shot Detection and Rolling Buffer  [partial]

- Implement impulse detection. (12 g threshold + 800 ms refractory, `OFSHOT`
  serial events + LED pulse.)
- Capture pre-shot and post-shot windows. (Rolling buffer not yet implemented.)
- Allow browser replay requests. (Not yet.)

### Phase 5: Calibration and Config  [partial]

- Add axis orientation mapping. (Fixed mount rotation + button-zeroed cant/pitch
  offsets in firmware.)
- Add threshold configuration. (Runtime BLE command `thresh:<g>` implemented.)
- Add sample-rate and range configuration. (Not yet runtime-configurable.)

### Phase 6: Local-First Persistence  [todo]

- Save shots and sessions to IndexedDB.
- Add import/export for open-source data portability.

### Phase 7: Optional Cloud Sync  [todo]

- Add account login.
- Sync local shots after successful local save.
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
| BLE throughput test | Confirm 400 Hz and 800 Hz live streaming on target browsers. |
| Packet loss test | Verify sequence tracking and shot-buffer recovery. |
| Shock/vibration test | Determine clipping, mount stability, and damping effects. |
| False trigger test | Reject normal handling, let-downs, and transport movement. |
| Live shooting test | Validate release detection and metrics against real arrows. |
| Battery test | Measure runtime during advertising, streaming, and idle. |
| Browser compatibility test | Confirm Chrome/Chromium behavior for Web Bluetooth and Web Serial. |
| Cloud sync test | Confirm offline capture, later upload, and conflict handling. |

## 17. Open Questions

- Can the selected integrated IMU capture release shock without clipping?
- Is the current ~873 Hz / 87 notifications/s raw-register BLE mode stable
  enough across target devices?
- Should the next high-rate firmware step use the IMU FIFO/data-ready path to
  close the remaining gap to 1000 Hz?
- Should USB/Web Serial be the recommended mode for lab-grade full-rate capture?
- What mounting position gives the best signal-to-noise ratio?
- How much damping protects electronics without hiding useful shot dynamics?
- Which metrics are most valuable to archers and coaches in the first release?
- What data should be public/exportable for the open-source community?
