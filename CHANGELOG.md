# Changelog

Notable user-facing changes to OpenFloat Archery are recorded here.

## 2026-11-07

### Added

- Added Dashboard controls to increase, decrease, or set the connected sensor's
  lifetime shot count to zero. The controls use `shotset:<n>` and preserve shots
  waiting in the device's upload queue.
- Added language selection under **Settings → Language**, with English (US) and
  Brazilian Portuguese translation files registered in `locales/index.json`.
  The selected language is saved on the current device.

### Documentation

- Documented shot-count adjustment and language selection in the README,
  quick-start, and feature-status guides.
