# BLE Control Commands

The firmware exposes a BLE **control characteristic**
(`8f3f3b10-0f5a-4f4c-9a2d-000000000003`) that accepts ASCII commands. The web
app sends these for you from the Dashboard and Settings, but you can also send
them directly from a BLE tool such as `tools/openfloat_ble_client.py` for
bring-up and debugging.

---

## Stream control

- `start` — Enable live notifications (also triggers a count-sync frame).
- `stop` — Disable live notifications.
- `streamrate:<n>` — Set the BLE live stream divider: `1`, `2`, `5`, `10`, or
  `20` (about 1110, 555, 222, 111, or 55 Hz).

## Calibration

- `zero` — Capture the current roll and pitch and save them as permanent level
  offsets in RRAM. Yaw is still display-only in the browser and is not persisted
  by firmware.

## Shot detection

- `thresh:<g>` — Release detection threshold in g, clamped to `2.0`–`30.0`.
- `shottrigger` — Generate a synthetic shot event for bench testing the
  detection, stored-shot upload, trace freeze, and ack path.
- `shotreset` - Reset the persisted lifetime shot count to 0 and clear the
  stored-shot backlog. Capture IDs keep advancing, so the next release has a
  different ID from earlier saved shots.
- `shotset:<n>` - Correct the persisted lifetime count without changing the
  capture ID. Use decimal digits from `0` through `4294967295`.
- `shotack:<n>` — Confirm shot ID `n` was saved by the browser; frees its stored
  slot. The ID is the 32-bit device shot ID from the stored-shot frame.
- `shotdump` — Request upload of any stored-shot backlog plus a storage-status
  frame.

Shot values (`shotset`, `shotack`, and the three trace request commands) must be
unsigned decimal digits. Empty values, signs, whitespace, suffixes, and values
above `4294967295` are rejected without changing a count or starting a transfer.
Embedded NUL bytes are rejected in all control commands. Valid count corrections
and resets preserve capture IDs across reboot. The lifetime count stops increasing
at its maximum; the independent 32-bit capture ID continues its normal wrap.
Use the device shot ID from event metadata for acknowledgments and trace requests,
which can differ from the displayed lifetime count.

## Power management

- `wakesens:<g>` — Wake-up accelerometer threshold, clamped to `0.5`–`8.0` g.
- `sleeptime:<s>` — Deep sleep timeout in seconds, clamped to `5`–`600`.
  Fresh firmware defaults to 300 s.
- `sleepsens:<g>` — Idle movement threshold to stay awake, `0.05`–`0.50` g.
- `autosleep:<0|1>` — Enable or disable inactivity-triggered deep sleep.

Before automatic sleep, firmware finishes follow-through and saves pending
settings, queued shots, and requested traces. During this brief final save,
the control callback rejects new commands with ATT Write Request Rejected
(`0xfc`) when a response is requested. Failed saves get up to three passes;
continued errors keep the sensor awake and retry sleep after thirty seconds.
Controls reopen when sleep is deferred. Physical sleep/wake and callback timing
still need hardware verification.

## Trace buffer

- `tracetimed:<shot_id>` - Request the complete stored trace with recorded
  timing, release reference, and checksum validation. Supports all 1,000 points.
- `tracereq2:<shot_id>` - Request an untimed compatibility trace using 32-bit
  shot IDs and 16-bit chunk indexes. Supports all 1,000 buffered points.
- `tracereq:<shot_id>` - Older transfer format, limited to 692 current points.
  Updated firmware returns status 2 for larger traces. The browser tries the
  timed command first and falls back through extended and legacy formats. All
  commands return trace status 0 when the requested slot is unavailable.
- `bufrate:<hz>` — Trace buffer rate: `0`, `52`, `104`, or `208` Hz.
- `bufnvs:<0|1>` — Toggle RRAM persistence for buffered traces.
- `followms:<ms>` — Post-release trace freeze delay, clamped to `0`–`3000` ms.

Tuning commands require complete values. Toggles and rates use unsigned decimal
digits and must match the listed options. `sleeptime` and `followms` accept signed
32-bit decimal integers; valid numbers outside their stated limits are clamped.
`thresh`, `wakesens`, and `sleepsens` accept finite decimal numbers, including
exponents, and keep their stated clamps. Empty values, whitespace, suffixes,
hexadecimal notation, NaN, infinity, and conversion overflow are rejected with
ATT "Value Not Allowed" (`0x13`), leaving device settings unchanged.

On boot, persisted tuning values must have a complete four-byte record and fit
their supported limits. Invalid values retain the firmware defaults, including
a valid, nonzero stream divider.

---

> Settings sent from the app are cached locally and persisted on the device when
> the firmware supports the command. If an older device still has a short
> persisted sleep timeout, send `sleeptime:300` once to migrate it.
