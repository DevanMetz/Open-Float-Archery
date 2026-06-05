# Third-Party Notices

OpenFloat Archery is released under the MIT License (see `LICENSE`). The firmware
sources additionally carry `SPDX-License-Identifier: Apache-2.0` headers. This
file lists third-party software, algorithms, and platform components the project
builds on, along with their licenses. It is provided for attribution and license
compliance; it is not legal advice.

## Firmware

### Zephyr RTOS / Nordic nRF Connect SDK (NCS)
- **Used for:** RTOS, Bluetooth LE stack, drivers, build system (the firmware in
  `firmware/` targets the Seeed XIAO nRF54L15 Sense under NCS).
- **License:** Apache-2.0 for the bulk of Zephyr and NCS. Some Nordic-authored
  components ship under the **Nordic-5-Clause** license, which restricts use to
  Nordic Semiconductor devices. This project runs on a Nordic SoC, so that
  field-of-use condition is satisfied.
- **Notes:** Upstream copyright and SPDX headers in any vendored or referenced
  Zephyr/NCS files must be preserved.

### Madgwick AHRS / IMU orientation filter
- **Used in:** `firmware/src/main.c` (`madgwick_update_imu`).
- **Origin:** Sebastian O. H. Madgwick, "An efficient orientation filter for
  inertial and inertial/magnetic sensor arrays" (2010), and the associated x-io
  Technologies reference implementation.
- **Status in this project:** The orientation update here is an independent
  reimplementation of the published Madgwick algorithm/equations, written in this
  project's own naming and style for Zephyr (it is not a copy of the x-io
  reference C source). The algorithm and equations are freely usable; this file
  attributes the originating work.
- **Reference license:** The original x-io reference implementation was
  distributed under the GNU GPL. No GPL-licensed source from that implementation
  is included or derived from here.

## Host Tools

### Bleak
- **Used in:** `tools/openfloat_ble_client.py` (BLE host validation client).
- **License:** MIT.

## Web Application

### Three.js (including GLTFLoader and OrbitControls)
- **Used in:** `app/ui/dashboard.js` (3D orientation visualizer).
- **License:** MIT.

### Supabase JavaScript client
- **Used in:** `app/telemetry/sync.js` (optional cloud sync adapter).
- **License:** MIT.

### Browser platform APIs
- **Web Bluetooth, Web Serial, IndexedDB** are browser platform features, not
  bundled dependencies, and carry no separate license obligation.

---

If you redistribute this project or build products from it, verify that the
current upstream license terms for each component above still match what is
listed here, and preserve all upstream copyright and license headers.
