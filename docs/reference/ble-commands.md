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
  offsets in RRAM.

## Shot detection

- `thresh:<g>` — Release detection threshold in g, clamped to `2.0`–`30.0`.
- `shotreset` — Reset the persisted lifetime shot count to 0.
- `shotset:<n>` — Set the persisted shot count to `n` (e.g. correct a miscount).
- `shotack:<n>` — Confirm a shot was saved by the browser; frees its stored slot.
- `shotdump` — Request upload of any stored-shot backlog plus a storage-status
  frame.
- `tracereq:<n>` — Request chunked upload of a stored trace.

## Power management

- `wakesens:<g>` — Wake-up accelerometer threshold, clamped to `0.5`–`8.0` g.
- `sleeptime:<s>` — Deep sleep timeout in seconds, clamped to `5`–`600`.
  Fresh firmware defaults to 300 s.
- `sleepsens:<g>` — Idle movement threshold to stay awake, `0.05`–`0.50` g.
- `autosleep:<0|1>` — Enable or disable inactivity-triggered deep sleep.

## Trace buffer

- `bufrate:<hz>` — Trace buffer rate: `0`, `52`, `104`, or `208` Hz.
- `bufnvs:<0|1>` — Toggle RRAM persistence for buffered traces.
- `followms:<ms>` — Post-release trace freeze delay, clamped to `0`–`3000` ms.

---

> Settings sent from the app are cached locally and persisted on the device when
> the firmware supports the command. If an older device still has a short
> persisted sleep timeout, send `sleeptime:300` once to migrate it.
