# OpenFloat JavaScript tests

This repository uses Node's built-in test runner with no npm dependencies.

Run the pure-function unit suite from the repository root:

```powershell
node --test test/
```

The tests import the browser app's ES modules directly. Keep fixtures small and
focused so the suite stays useful for a buildless static app.
Offline checks verify that all precache files exist, the renderer's full module
graph resolves locally and is precached, and the bow GLB has no external image
or buffer URLs.
Replay tests use a controlled animation clock and gapped recordings to verify
real-time speed, pause/resume, scrubbing, capture switches, and shared motion/
microphone timing. Canvas checks cover timed pin positions, audio-band bounds,
and release/hit marker alignment in both chart views.
Saved-score checks distinguish missing measurements from zero, normalize numeric
strings, exclude invalid values from averages and coaching, and retain gaps in
session trend plots. Legacy stability fallback applies only to unversioned shots.
Release-phase checks cover hold and firmware provenance, recorded event timing,
capture thresholds, gaps and edge samples, narrow impulses in thumbnails, and
angle-only Motion rendering. Native history checks verify comparison provenance
and refresh release markers when a late browser trace arrives.
BLE trace checks cover all 1,000 points across 467 extended chunks, full 32-bit
shot IDs, out-of-order and duplicate chunks, malformed envelopes, queued writes,
legacy fallback, and stale replies/disconnects. Native storage checks run the
same wire fixture through the adapter and telemetry assembler to verify every
saved point and reject inconsistent or incomplete records. These are simulated
notifications; firmware still needs an on-device recovery test.
Timed recovery adds metadata/CRC rejection, measured intervals, migrated untimed
records, fallback negotiation, exact release markers between samples, and
protection against losing timing to a legacy upload.

The firmware ring, persistence migration, and frame encoder have a host C check.
With a C11 compiler on PATH, run from the repository root (PowerShell shown):

```powershell
New-Item -ItemType Directory -Force firmware/build-host-test | Out-Null
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src firmware/src/trace_buffer.c firmware/tests/trace_buffer_test.c -o firmware/build-host-test/trace_buffer_test.exe
./firmware/build-host-test/trace_buffer_test.exe firmware/build-host-test/timed-trace.bin
node tools/verify_trace_timing.mjs firmware/build-host-test/timed-trace.bin
```

The final command decodes bytes emitted by the actual C encoder with the actual
browser parser and compares every point/timestamp with the shared fixture.
It covers 1,000 points, 535 chunks, mixed intervals, signed angles, full shot ID,
release origin, and CRC. C checks also cover clock wrap, ring wrap, long gaps,
legacy limits, and old RRAM migration. These host checks do not measure sensor
timing, BLE throughput, RRAM retention, or scheduler interleavings on hardware.

For native IndexedDB regression checks, serve the repository and open
`http://localhost:4178/test/browser.html` in Chrome or Edge. Click **Run storage
checks**. The page creates a uniquely named temporary database, redirects only
its own storage calls to that database, and removes it after the run. It never
opens the app's database or changes practice records.

These browser checks exercise commit timing, aborted writes and deletes,
sync-status rollback, atomic full and single-shot imports, backup round trips,
retry after a failed database open, and import queue isolation.
Selected-export checks cover linked-record filtering, partial session anchors,
missing selections, restore compatibility, and snapshot consistency during a
concurrent capture save.
Outcome-edit checks cover committed upload payloads, score/impact rollback,
preserving telemetry, missing captures, and local-only demo results.
Capture checks cover matching metadata/trace ids, atomic replay and upload
saves, demo exclusion from the queue, disconnect recovery, retry after a failed
manual save, and duplicate submission.
Late-trace checks cover score/outcome races, deleted records, atomic rollback,
and demo provenance.
Firmware recovery checks preserve fuller browser traces and their active
replays, even when writes race, while recovering absent or empty recordings.
Simulated device events exercise acknowledgement after commit, concurrent
repeats, metadata arriving before trace, reused device ids,
and delayed saves across reconnection.
Device-score checks keep unrelated live metrics out of metadata, queued
uploads, and angle-only firmware recovery; the capture's own browser trace
fills its measured score, stability, and packet loss.
Deletion checks cover full rollback, unrelated queue rows, session anchor
changes and split groups. A hidden copy of
the real history markup verifies single and bulk deletion refresh scorecards,
review state and recent captures, using only this page's temporary database.
History checks cover older uploads arriving after newer shots, late scores,
undated records, session drafts and focus, unsaved arrow results, and a delayed
refresh completing after capture deletion. They also verify score availability
and numeric imports in session headers, recent cards, and active review.
Simulated cloud
responses exercise interrupted uploads, new work arriving during an upload,
failed-upload retries, canceled queue entries, and shared Web Locks. No real cloud client is created and
no data is uploaded. These checks complement the dependency-free Node suite;
Node does not provide a native IndexedDB implementation.
