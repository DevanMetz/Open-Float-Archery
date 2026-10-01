# Contributing to OpenFloat

OpenFloat has a browser dashboard, Zephyr firmware, and build documentation. Focused pull requests in any of those areas are welcome.

## Get oriented

- Read the [Quick Start](docs/quick-start.md) and [repository layout](README.md#repository-layout).
- The browser app is served from the repository root. Run `python -m http.server 4178`, then open `http://localhost:4178/` in Chrome or Edge. Demo mode lets you explore it without hardware.
- Firmware setup and verification are in [firmware/BUILDING.md](firmware/BUILDING.md). A browser-only change does not require a firmware build.

## Check your change

Run `npm test` for browser logic changes. For follow-through trace changes, also run `python tools/verify_follow_through_trace.py`. For firmware changes, follow the build and verification steps in `firmware/BUILDING.md` and state which hardware you tested.

Keep pull requests focused. Explain the user-facing effect, the checks you ran, and any hardware or browser limitations. For UI changes, include a screenshot. Do not commit credentials, private shot captures, or generated build output.

Code is under the [MIT license](LICENSE); preserve attribution for third-party assets and firmware components.
