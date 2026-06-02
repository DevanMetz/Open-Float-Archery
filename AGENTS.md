# AGENTS.md

Guidance for AI coding agents and maintainers working in this repository.

## Project Overview

OpenFloat Archery is an open-source archery telemetry project. The current repo contains a browser-based dashboard for bow-mounted sensor telemetry and a technical blueprint for the broader hardware, firmware, Web Bluetooth, Web Serial, and cloud-sync architecture.

The production site is auto-deployed through Cloudflare and is available at:

https://openfloatarchery.com

## Repository Shape

- `index.html` is the web app shell (markup only); it loads `styles.css` and `app/main.js` as a native ES module.
- `app/` holds the browser app as plain ES modules (no build step, no npm): `protocol/` (frame parsing), `core/` (event bus + reactive store), `device/` (Serial/BLE/Demo adapters), `telemetry/` (metrics + loss tracking), `ui/` (rendering), and `main.js` (wiring).
- `Blueprint.md` describes the intended hardware, firmware, BLE, browser, and cloud architecture.
- `firmware/` is the Zephyr/NCS firmware app for the Seeed XIAO nRF54L15 Sense (IMU loop, shot detection, serial/BLE telemetry). See `firmware/AGENTS.md` for build, flash, and verification notes.
- `tools/` holds host-side utilities, including `openfloat_ble_client.py`, the Python/Bleak BLE test client.
- `FreeCAD/` holds enclosure/mechanical CAD work.
- `README.md` is currently minimal and may need expansion as the project matures.
- `LICENSE` defines the open-source license terms.

This repo is intentionally lightweight at the moment. Prefer small, understandable changes over introducing a build system or framework unless the project clearly needs one. The `app/` modules are deliberately framework-free: native ES modules, no bundler, no npm, no transpile step.

## Running Locally

The app is static, but ES modules and the Web Serial / Web Bluetooth APIs require an `http(s)` origin (not `file://`). Serve the repo root and open it over localhost, e.g.:

```powershell
python -m http.server 4178
# then open http://localhost:4178/
```

`.claude/launch.json` defines this server for the Launch preview. Web Serial / Web Bluetooth need Chrome or Edge; the "Run Demo Stream" button works in any browser with no hardware.

## Development Guidelines

- Keep the project accessible to open-source contributors.
- Avoid adding proprietary services, closed dependencies, or vendor lock-in without documenting the reason.
- Prefer browser-native APIs where practical, especially for Web Bluetooth, Web Serial, IndexedDB, and offline-first behavior.
- Keep user-facing copy clear for archers, coaches, and makers who may not be software specialists.
- Preserve the zero-install browser experience unless there is a strong reason to change it.
- Treat hardware and firmware assumptions as hypotheses until validated with real sensor data.

## Deployment Notes

The repo is currently auto-deployed to Cloudflare Workers / Cloudflare hosting infrastructure. Before changing deployment-sensitive files, check whether the change affects:

- The root `index.html` entry point.
- Static asset paths.
- Browser compatibility.
- HTTPS-only APIs such as Web Bluetooth and Web Serial.
- Cloudflare routing for `openfloatarchery.com`.

Do not add deployment secrets, API keys, credentials, or account-specific Cloudflare configuration to the repository.

## Browser API Considerations

Web Bluetooth and Web Serial support varies by browser and operating system. When touching connection, flashing, telemetry, or device-discovery behavior:

- Expect Chrome/Chromium to be the primary supported browser.
- Preserve graceful fallback or demo behavior when hardware APIs are unavailable.
- Avoid blocking the whole app when no device is connected.
- Keep local/offline operation working where possible.

## Open-Source Contribution Expectations

Contributions should be:

- Easy to review.
- Focused on one meaningful change at a time.
- Documented when they affect hardware assumptions, telemetry formats, BLE characteristics, storage schemas, or deployment behavior.
- Tested manually in a browser when UI or browser API behavior changes.

If adding new architecture, protocol, firmware, or schema decisions, update `Blueprint.md` or add a dedicated spec document so future contributors can follow the reasoning.

## Agent Behavior

When working in this repository:

- Read the existing files before making assumptions.
- Do not overwrite user changes or untracked work.
- Keep edits scoped to the requested task.
- Prefer plain HTML/CSS/JavaScript unless a framework is explicitly introduced by the project.
- Use ASCII text by default.
- If you change UI behavior, verify the page locally when practical.
- If you make deployment-related changes, mention Cloudflare impact in your summary.

