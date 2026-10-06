# OpenFloat tests

This repository uses Node's built-in test runner with no npm dependencies.

Run the pure-function unit suite from the repository root:

```powershell
node --test test/
```

Run the Python bench-parser checks without Bluetooth hardware or Bleak:

```powershell
python -m unittest discover -s test -p "*_test.py"
```

These standard-library checks cover every two- and three-fragment boundary for
both live binary formats, bytewise text and UTF-8 banners, printable binary
payloads, payload markers/newlines, mixed records and notification batch sizes,
unsupported frames, noise before split magic, and bounded incomplete text.
Oversized lines are skipped; a binary header can resume the stream before a
newline. CI runs these alongside the existing Python tools.

The JavaScript tests import the browser app's ES modules directly. Keep fixtures
small and focused so the suite stays useful for a buildless static app.

The optional cloud schema has executable PostgreSQL checks in
`test/cloud-schema.sql`. Set the usual `PGHOST`, `PGPORT`, `PGUSER`, and
`PGPASSWORD` connection variables for a disposable plain PostgreSQL database,
then run:

```powershell
psql -X -q -d openfloat_schema_test -v legacy=false -f test/cloud-schema.sql
psql -X -q -d openfloat_schema_test -v legacy=true -f test/cloud-schema.sql
```

The database must be named `openfloat_schema_test` and contain no `auth` schema.
The bootstrap uses a privileged test connection, creates an auth shim and a
restricted client role, and rolls back every object and row. Checks cover fresh
and repeated installation, upgrades from the signed integer column/global
unique index, preserved metadata/replays, JSON IDs from zero through
4,294,967,295, later captures reusing an ID, UUID upsert retries, and another
user's matching sensor ID. RLS checks reject cross-user reads, writes, deletes,
upserts, and ownership changes. CI runs both fixtures on PostgreSQL 15 and 17.
Trace checks also reject attachment to a foreign or missing parent capture,
moving a replay to another user's capture, and both insert/update upsert paths.
Owned replay retries, edits, and deletion still succeed. Reapplying the policy
retains older mismatched rows, blocks their updates, and permits their owner's
cleanup while preserving other replays.
Capture-type checks retain custom-named arrows/holds through JSON storage, UUID
retries, and schema reapplication. Existing untyped records stay null when
upgrading from a schema without the field.
These checks do not connect to Supabase or certify its Auth/REST configuration.

Event-bus checks verify awaited notification delivery, independent synchronous
and asynchronous failures, pending reads, listener snapshots, and unchanged
synchronous telemetry delivery.
Backup UI checks cover pending file reads, writes, refreshes, and downloads;
duplicate actions, failed-operation retries, file selection reset, keyboard
focus, and committed imports with synchronous or asynchronous sync failures.
They verify refresh warnings preserve the saved outcome and download object
URLs remain usable while the browser starts reading the JSON file.
Shared JSON download checks cover payload/filename preservation, UTC and undated
file stamps, serialization failures before URL allocation, and link/URL cleanup
after creation, insertion, or click failures.
Offline checks verify that all precache files exist, the app's static module
graph and the renderer's full module graph resolve locally and are precached,
and the bow GLB has no external image
or buffer URLs.
Service-worker checks simulate offline fetches and HTTP server errors, isolate
fallback reads and upgrade cleanup to OpenFloat's cache, and verify that runtime
cache writes extend the worker lifetime without blocking network responses or
failing on storage limits. Missing cached files retain the server error; deleted
assets retain their 404 response.
Installing a new worker bypasses stale HTTP copies when populating the app and
Guide caches.
Guide checks cover document-relative images/files, in-app and section links,
literal code, safe URL/attribute rendering, reordered page responses, cached
switches, anchors selected during loading, and retry after failed index/page
requests. They also render the shipped Markdown pages.
Browser-support checks distinguish unavailable Bluetooth, insecure pages, iOS
guidance, and policy restrictions without requesting a device. A refused sensor
connection keeps an existing demo intact. Native notice checks verify dismissal
and reopened help focus, descriptive status text, and repeated section-link
activation. They simulate unavailable APIs in Chrome; they do not certify
sensor pairing on other browsers or platforms.
Native training checks use a controlled monotonic clock, delayed callbacks,
synthetic sensor frames, and the run's temporary database. They cover elapsed
preparation, missing/invalid data, interior gaps, deadline clipping, retry,
page/view suspension, retained results, keyboard focus, reload protection,
static result redraws, listener cleanup, and saved timing/zero acceleration.
Save recovery checks abort each of the metadata, trace, and upload stores;
verify a retained result and atomic retry; reject synchronous/asynchronous
notifications; and keep committed holds saved across pending refreshes, view
changes, unmounting, and logging failures. They also verify focus preservation,
inline feedback, duplicate prevention, and reload warnings ending after commit.
Controlled wall-clock checks verify recorded hold times through delayed Save,
late preparation/completion callbacks, clock corrections, failed-write retries,
discard/cancel, session grouping, upload payloads, and exports.
Late-score checks run the actual browser trace writer against initially unscored
metadata and verify the new coach baseline without changing a chosen drill,
duration, or focus. Scores arriving during a hold update the next recommendation
while retaining the current drill, target, result, and saved label. A held older
metadata read cannot overwrite newer trace scores. Existing unmount checks cover
cleanup of the added trace subscription.
The one-second continuity guard still needs validation with actual telemetry.
Saved-data notification checks cover store-only notices, self-echo prevention,
invalid messages, hidden-tab deferral, focus fallback without messaging,
serialized refreshes, read failures, page-cache suspension/resumption, and
cleanup during a pending read. Messaging failures cannot fail a committed save.
Replay tests use a controlled animation clock and gapped recordings to verify
real-time speed, pause/resume, scrubbing, capture switches, and shared motion/
microphone timing. Canvas checks cover timed pin positions, audio-band bounds,
and release/hit marker alignment in both chart views.
Interactive marker checks verify immediate position/range updates using the
review's speed, capture and trace switches ending old gestures, touch
cancellation, and hold-only captures retaining no release markers. Range checks
cover invalid measurements, speed provenance labels, the existing flight/sound
model, measured microphone onset timing, and malformed or missing audio.
Native browser reviews cover assigned vs. active bow speeds, missing profiles,
invalid speed fallback, full-rate audio, and late microphone trace refreshes.
Bow-profile checks cover delayed selection and draft loads, list refreshes,
duplicate saves/deletes, retained failed drafts, numeric validation, missing
profiles, and preference/sync errors after a committed save. Native IndexedDB
checks verify exact upload payloads, preserved metadata, atomic rollback from
either store, missing/duplicate ids, and historical references after deletion.
The real profile form runs save/delete failure and retry checks using only the
browser test page's temporary database and in-memory preferences.
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
Connection checks simulate canceled pickers, delayed GATT/notification/battery
setup, failed and canceled reconnects, stale queued writes and retries, and
overlapping transport switches. Optional battery notifications may fail while
telemetry continues. These checks do not use a physical Bluetooth device.
Reconnect checks also retain acknowledged trace IDs through a failed subscription
attempt, serialize resumed transfers, cancel a pending recovery decision on
manual disconnect, and distinguish last-chunk receipt from a committed replay.
They also retry after temporary lookup errors or a transfer timeout that precedes
the reported radio disconnect.
Same-link retry checks advance the actual inactivity timer, restart the transfer,
and feed a changed timed header through the adapter and telemetry listeners.
Fresh chunks replace the abandoned assembly without clearing its metadata
association or another shot's buffer.

The firmware ring, persistence migration, and frame encoder have a host C check.
With a C11 compiler on PATH, run from the repository root (PowerShell shown):

```powershell
New-Item -ItemType Directory -Force firmware/build-host-test | Out-Null
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src firmware/src/trace_buffer.c firmware/tests/trace_buffer_test.c -o firmware/build-host-test/trace_buffer_test.exe
./firmware/build-host-test/trace_buffer_test.exe firmware/build-host-test/timed-trace.bin
node tools/verify_trace_timing.mjs firmware/build-host-test/timed-trace.bin
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src firmware/src/trace_store.c firmware/tests/trace_store_test.c -o firmware/build-host-test/trace_store_test.exe
./firmware/build-host-test/trace_store_test.exe
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/metadata_frame_test.c -o firmware/build-host-test/metadata_frame_test.obj
clang firmware/build-host-test/metadata_frame_test.obj -o firmware/build-host-test/metadata_frame_test.exe
./firmware/build-host-test/metadata_frame_test.exe firmware/build-host-test/metadata-frames.bin
node tools/verify_metadata_frames.mjs firmware/build-host-test/metadata-frames.bin
python tools/verify_metadata_frames.py firmware/build-host-test/metadata-frames.bin
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/shot_control_test.c -o firmware/build-host-test/shot_control_test.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/trace_buffer.c -o firmware/build-host-test/shot_control_trace.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/shot_recovery.c -o firmware/build-host-test/shot_recovery.obj
clang firmware/build-host-test/shot_control_test.obj firmware/build-host-test/shot_control_trace.obj firmware/build-host-test/shot_recovery.obj -o firmware/build-host-test/shot_control_test.exe
./firmware/build-host-test/shot_control_test.exe firmware/build-host-test/shot-controls.bin
node tools/verify_shot_controls.mjs firmware/build-host-test/shot-controls.bin
python tools/verify_shot_controls.py firmware/build-host-test/shot-controls.bin
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/control_values_test.c -o firmware/build-host-test/control_values_test.obj
clang firmware/build-host-test/control_values_test.obj -o firmware/build-host-test/control_values_test.exe
./firmware/build-host-test/control_values_test.exe
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/shot_log.c -o firmware/build-host-test/shot_log.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/shot_log_test.c -o firmware/build-host-test/shot_log_test.obj
clang firmware/build-host-test/shot_log.obj firmware/build-host-test/shot_log_test.obj -o firmware/build-host-test/shot_log_test.exe
./firmware/build-host-test/shot_log_test.exe firmware/build-host-test/shot-log-frames.bin
node tools/verify_shot_log.mjs firmware/build-host-test/shot-log-frames.bin
python tools/verify_shot_log.py firmware/build-host-test/shot-log-frames.bin
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/settings_retry.c -o firmware/build-host-test/settings_retry.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/settings_retry_test.c -o firmware/build-host-test/settings_retry_test.obj
clang firmware/build-host-test/settings_retry.obj firmware/build-host-test/shot_log.obj firmware/build-host-test/settings_retry_test.obj -o firmware/build-host-test/settings_retry_test.exe
./firmware/build-host-test/settings_retry_test.exe
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/sleep_flush.c -o firmware/build-host-test/sleep_flush.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/trace_store.c -o firmware/build-host-test/trace_store.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/sleep_flush_test.c -o firmware/build-host-test/sleep_flush_test.obj
clang firmware/build-host-test/sleep_flush.obj firmware/build-host-test/settings_retry.obj firmware/build-host-test/shot_log.obj firmware/build-host-test/trace_store.obj firmware/build-host-test/sleep_flush_test.obj -o firmware/build-host-test/sleep_flush_test.exe
./firmware/build-host-test/sleep_flush_test.exe
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/src/boot_restore.c -o firmware/build-host-test/boot_restore.obj
clang -std=c11 -Wall -Wextra -Werror -Ifirmware/src -c firmware/tests/boot_restore_test.c -o firmware/build-host-test/boot_restore_test.obj
clang firmware/build-host-test/boot_restore.obj firmware/build-host-test/boot_restore_test.obj -o firmware/build-host-test/boot_restore_test.exe
./firmware/build-host-test/boot_restore_test.exe
```

`verify_trace_timing.mjs` decodes bytes emitted by the actual C encoder with the actual
browser parser and compares every point/timestamp with the shared fixture.
It covers 1,000 points, 535 chunks, mixed intervals, signed angles, full shot ID,
release origin, and CRC. C checks also cover clock wrap, ring wrap, long gaps,
legacy limits, and old RRAM migration. These host checks do not measure sensor
timing, BLE throughput, RRAM retention, or scheduler interleavings on hardware.

The portable trace persistence queue also checks oldest-first selection across
generation wrap, retained failures after three ordinary attempts, explicit sleep
retries, saturated counters, and slot reuse while writes finish. An old success
or failure must leave the newer slot's pending state and attempt count untouched.

The metadata checks feed the actual C counter writer's bytes through both the
browser decoder and Python bench-client parsers. Cases include zero, 65,535,
65,536, signed-32-bit maximum, and the full unsigned wire range, while preserving
motion, release sequence, and queue fields. Legacy metadata stays readable and
unsupported versions are rejected. Native browser checks also cover live/stored
deduplication, full-ID acknowledgments and replay recovery, and current counts
surviving historical uploads after an explicit correction.
Unknown binary versions and types cannot enter live metrics or finish a replay.
The Python parser rejects unsupported headers without guessing their length and
recovers a following valid frame. The actual C metadata also passes bytewise and
batched Python parsing without becoming live samples. CI compiles that fixture
and runs both client verifiers. A native IndexedDB check saves capture ID zero
after unsigned wrap, deduplicates its stored repeat, retains the current maximum
count, ignores unsupported frames, and saves its timed replay under the same ID.
Adapter checks also retain the next queued replay and report an active retry for
ID zero only when the sensor has a pending upload.
Sensor identity checks use two mock BLE devices with the same name and capture
ID zero through real IndexedDB saves, timed replays, and reconnect. Each keeps
its own local capture, replay length, and upload key. Known devices cannot adopt
generic legacy captures, and delayed metadata/manual/training saves retain the
original device key. Adapter tests also reject another device's acknowledgement.
The browser-provided IDs are scoped to its origin/permissions; these simulations
do not establish physical or cross-browser identity continuity.

Shot-control checks cover strict unsigned decimal parsing, failed conversions
leaving values untouched, values above the signed limit, saturation, and legacy
four-byte/eight-byte counter settings. Count corrections and resets preserve the
independent capture ID through a simulated reboot. The actual C state transitions
and frame encoders feed both JavaScript and Python clients, including extended
trace chunks with full IDs. Native browser checks verify the later releases save
as separate captures and old uploads preserve the corrected count. CI runs the
host and client checks. Settings callback timing and physical reboot behavior
still require hardware verification.

The same C fixture now checks `shot_recovery.c`: an older/missing counter cannot
reuse a retained full ID from the queue or nonempty traces. The saved lifetime
count survives corrections/resets unchanged; historical 16-bit counts are not
used to infer it. A maximum 100-shot queue crosses unsigned wrap, all cyclic
trace-slot orders find the same latest ID, and empty traces/legacy 16-bit queues
are excluded. Exact half-range ambiguities reject without mutating the pair.
Sequence ordering assumes retained IDs span less than half the 32-bit range.
Eight resulting capture frames pass both JavaScript and Python decoders, including
IDs zero and one after wrap. Existing Settings byte layouts stay unchanged.

Tuning-value checks use the production parsers and persisted-value validators.
They cover malformed disable commands, signed 32-bit boundaries, numeric
suffixes, whitespace, hexadecimal values, finite decimal fractions/exponents,
NaN/infinity, conversion overflow/underflow, supported rate options, and stored
limits in milli-g/milliseconds. Failed parsing leaves values unchanged. These
checks run in CI; actual GATT error responses and Settings read callbacks still
require on-device validation.

Shot-log checks use frozen bytes for the current padded ARM32 layout and both
older 16-bit-ID layouts. They cover every short-read length, zero/oversized read
results, unknown sizes, invalid counts, full capacity, unaligned input, staged
in-place migration, cleared unused slots/padding, preserved signed fields, and
full current IDs including zero and `UINT32_MAX`. Rejection leaves the prior
queue unchanged. Seven frames from the actual restore and stored encoder feed
both JavaScript and Python decoders in CI. These host fixtures model Settings
read counts; physical storage, callbacks, and reboot behavior remain pending.

The same production module checks ordered acknowledgment removal, full-ID
matching (including zero and `UINT32_MAX`), capacity eviction, aliased append,
padding normalization, and complete reset. Across 1,000 append/ack cycles the
entire empty log must return to identical zero bytes, including unused slots.

Storage checks inject errors before, after, and partway through all 34 writes
of a full record, then reload and retry. They verify that previous complete
records survive, incomplete/corrupt pieces cannot mix captures, short records
discard stale tails, and reused IDs restore in commit order. The portable C
checks and C-to-JavaScript fixture run in CI alongside the Node suite.

Ordinary-save checks use the production twelve-key mapping and retry queue.
They cover independent deadlines from write completion, three-attempt budgets,
coalesced updates, fair progress during a busy key, stale write results,
clock/token wrap, and 108 pre-commit/torn/commit-then-error cases. Other keys must
progress during backoff; exhausted failures remain marked without a retry loop.
A new request resets its budget. Frozen scalar bytes and actual counter/log
decoders verify the final values.

Sleep-flush checks use the production twelve-value writer and trace storage.
They inject transient, permanent, commit-then-error, and torn faults at every
Settings value and every full-trace write. A failed key must not skip later
values or traces. Retries are bounded to three passes/two one-second delays;
only an entirely successful pass returns zero. Reboot reads verify scalar bytes,
signed offsets, count/ID, ordered queue, and the full trace after recovery.
Mixed errors and traces that exhausted prior retries are covered. The tests do
not run the Zephyr shutdown gate, actual workqueue cancellation, or hardware.

`boot_restore_test.c` exercises the production startup coordinator across all
twelve ordinary and ten legacy keys. Initialization/read/trace errors retry in
three passes, including recovery after an exhausted batch. Each attempt resets
partial RAM. Malformed tunings/legacy traces retain defaults; malformed counters
and queues prevent startup. The final repair callback runs only after every
read/restore succeeds; commit faults use the same bounded retries. Every key and
trace failure must suppress that callback.

To exercise capacity and garbage collection with the actual installed SDK ZMS
source (no SDK files are modified), run:

```powershell
python tools/verify_trace_storage.py --zephyr C:/ncs/v3.3.0/zephyr --cc clang
```

The host build keeps strict C11 and enables POSIX.1-2008 declarations so the
SDK's `strnlen` call also compiles on Linux
([Linux manual](https://man7.org/linux/man-pages/man3/strnlen.3.html)).

This uses a single-threaded 64 KB byte-alterable flash model with 4 KB sectors
and 16-byte writes. It reserves conservative settings-name/index space and
retains four complete traces through 100 full saves, 100 maximum-size shot-log
updates, and 100 remounts. It also demonstrates the original oversized-value
rejection. The model replaces flash hardware, logging, and mutexes; it does not
prove physical power-loss behavior. This capacity model reserves index space;
the separate boot model described below uses the actual Settings linked list.
It enables `ZMS_NO_DOUBLE_WRITE` like `firmware/prj.conf` and counts flash calls:
100 drained live-ack queue saves add zero writes/erases. Saving a backlog and
acknowledging it still changes storage, and both values survive remounts.
After that GC stress the production sleep writer saves a full-ID counter,
backlog, and another complete trace; remount verifies them. Repeating the
unchanged sleep flush adds zero flash writes/erases.
The command also compiles the unchanged SDK Settings/ZMS backend and Murmur3
hash with the production `settings_read.c` and `boot_restore.c`. It seeds twelve
ordinary keys and four full traces through actual Settings writes. Fresh-device
defaults, legacy counters, malformed values, final collision position, collision
holes, incomplete values, and destination bounds are checked. At each of 752
reader operations, transient and persistent errors test counter/backlog/trace
recovery with no application writes/erases. A separate flash-read error proves
SDK single-key lookup can return missing while the strict reader propagates the
error. The model stubs Settings registration/dispatch, hardware, mutexes, and
delays; it does not run Zephyr's Settings core, LED/BLE startup, or physical read
failures. Valid seeded SDK metadata needs no repair; on fresh/damaged stores
SDK mount/list recovery can write metadata. Application recovery reads first;
only a changed capture ID is saved after all reads and validation pass.
The actual SDK backend also runs 108 ordinary-save callback fault cases using
the production retry queue and shared layout writer. Remounts verify all twelve
values; an update or final sleep batch recovers exhausted failures. New counters
arriving during older successful/failed writes must survive their obsolete
results and restore after remount. Torn-value cases store half-length values
through the backend, rather than interrupting physical flash writes. The model
does not exercise Zephyr worker scheduling or Settings core locking.
Capture-ID fixtures persist counters, queues, and complete traces through the
actual backend. They verify stale/missing counter recovery, corrected count
preservation, saturation/wrap, legacy queue exclusion, the repaired eight-byte
pair after all queue/trace evidence is removed and another remount. Nine repair
faults cover pre-commit, half-length, and commit-then-error returns, exhaustion,
and later recovery; a verified reread can confirm a commit despite its error.
Failed reads or ambiguous ordering must produce zero application writes/erases.
Physical power cuts and reboot timing are not modeled.
Firmware CI runs this check against NCS v3.3.0. Use `--temp-dir` with an existing
directory (for example the ignored `firmware/build-host-test`) when the OS temp
directory is restricted. Builds use explicit objects in that temporary folder.

After building firmware with NCS, check the compiled BLE UUIDs from the
repository root:

```powershell
python tools/verify_ble_uuids.py firmware/build-v3.3.0/firmware/zephyr/zephyr.elf
```

This standard-library check reads the actual three GATT UUID objects and the
advertised service payload from the unstripped ARM32 ELF. It compares all bytes
with the browser adapter and both Python BLE clients. Firmware CI checks these
before uploading the image; the application compiler also rejects shifts that
exceed the operand width. No sensor is connected by this check, and physical
discovery, pairing, and reconnect behavior still need hardware verification.

For native IndexedDB regression checks, serve the repository and open
`http://localhost:4178/test/browser.html` in Chrome or Edge. Click **Run storage
checks**. The page creates a uniquely named temporary database, redirects only
its own storage calls to that database, and removes it after the run. It never
opens the app's database or changes practice records.

These browser checks exercise commit timing, aborted writes and deletes,
sync-status rollback, atomic full and single-shot imports, backup round trips,
retry after a failed database open, and import queue isolation.
The real backup form verifies commit and queue rollback, same-file retry,
pending action guards, accessible results, keyboard focus, and successful
imports whose sync or view refresh fails. Download callbacks use only temporary
database snapshots; no practice records are exported or uploaded by these tests.
Selected-export checks cover linked-record filtering, partial session anchors,
missing selections, restore compatibility, and snapshot consistency during a
concurrent capture save. Late-anchor context checks verify inherited settings
and direct bow assignments in subset files, standalone restore, no local writes
during export, and snapshot consistency during a concurrent session edit.
Single-export checks reproduce mixed metadata/trace versions during a concurrent
save and verify the repaired snapshot, undated-file restore, missing traces,
absent metadata, and no queue changes. Real single/selected export controls verify
pending reads/downloads, repeated actions, disabled controls across refreshes,
inline failure/retry with retained target edits, refreshed row focus, review
switches, and a selection changed after export begins. A download interceptor
reads the browser's actual blob URLs without creating files or exporting practice
data; it verifies both shot and selected-file URLs remain readable.
Outcome-edit checks cover committed upload payloads, score/impact rollback,
preserving telemetry, missing captures, and local-only demo results.
Restore-review checks exercise the real backup and history controls: coherent
metadata/trace/session/bow reads during a concurrent restore, changed or missing
recordings, microphone and range refresh, comparison retry, clean and unfinished
target forms, retained focus, unchanged manual markers and playback, and a shot
converted to a hold. Held save completions verify newer restored outcomes and
Save & Next using the current session order. Post-commit read or sync failures
remain successful local saves; aborted writes retain the draft for retry. Target
form preferences are isolated from the browser's practice settings.
Peer checks use a separate same-origin iframe realm, with its own app modules
redirected to the same temporary database. They verify committed capture notices,
queue rollback without a notice, no read/status refresh loops, restore and focus
refresh, deleted reviews/selections, preserved target/session/profile drafts and
replay markers, comparison and bow speed updates, and an adaptive recommendation
whose older read completes last. They never open the app's practice database.
Overlapping profile reads verify that an ignored older result or error cannot
report a false focus/restore failure after newer data has loaded.
Capture checks cover matching metadata/trace ids, atomic replay and upload
saves, demo exclusion from the queue, disconnect recovery, retry after a failed
manual save, and duplicate submission.
Manual save recovery also checks failing log listeners, synchronous and delayed
view failures, a reported unsuccessful refresh, and controls locked through
post-commit refresh without an unsaved warning. Write rollback remains retryable
with its stopped timestamp and loss count even when logging fails. Background
sync failures preserve queued uploads and cannot block or change the next
recording; a subscriber can start the next capture when controls unlock.
Late-trace checks cover score/outcome races, deleted records, atomic rollback,
and demo provenance.
Recovery checks add failing progress and completion logs, independent view
listeners, reported refresh failures, delayed background sync rejection, and
retried browser/firmware writes after upload-queue rollback. An actual history
fixture holds a firmware transaction's completion after commit, saves a newer
browser trace, then verifies the old completion never reinstates its samples or
resets the newer review's manual markers and playback. Score-only refreshes
retain playback, markers, target drafts and focus; changed recordings stop the
old replay. These checks use only the temporary browser database.
Firmware recovery checks preserve fuller browser traces and their active
replays, even when writes race, while recovering absent or empty recordings.
Simulated device events exercise acknowledgement after commit, concurrent
repeats, metadata arriving before trace, reused device ids,
and delayed saves across reconnection.
Device metadata checks also cover failed logs and independent save listeners,
duplicate re-acknowledgement returning the existing id, write rollback and retry,
delayed background sync rejection, and firmware recovery while a saved-view
callback remains pending. Parsed BLE frames retain their receiving connection
through the save event without persisting runtime identity in metadata, upload
payloads, or exports. The Node transport fixture verifies queued notifications
cannot acknowledge another adapter or a replacement connection, a connection
change stops a packet batch, and a failed log cannot repeat a successful control
write. These fixtures use simulated notifications and require no sensor chooser.
Stored-repeat checks recover missing and empty recordings under their original
capture id, including after a live metadata save. They feed actual decoded
firmware frames through the adapter, verify one serialized recovery request,
preserve existing metadata/uploads and complete recordings, and keep deleted
captures deleted. Failed trace reads still attempt recovery; a held lookup cannot
acknowledge or request a trace on a replacement connection. These checks do not
simulate physical radio loss or certify device retention across power loss.
Native reconnect checks use the actual adapter and telemetry status listeners
with simulated GATT notifications. After metadata acknowledgement, they drop a
partial transfer or disconnect synchronously after its final chunk, reconnect
without re-uploaded metadata, and save the fresh replay under the original local
ID. Stale notification targets cannot contribute old chunks. Completed, deleted,
and changed captures are skipped, and a held database lookup cannot restore an
association or request a trace after disconnect.
Native same-link checks restart a stalled transfer through repeated stored
metadata, then commit its changed timed replay under the original ID. A complete
assembly awaiting metadata cannot save after a newer request has superseded it.
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
Session-edit checks cover concurrent name/grouping patches, commit timing,
rollback across split groups, changed or deleted anchors, unavailable bow
assignments, and no orphan settings after every member capture is deleted.
Late earlier uploads preserve context in history and review speed. New-anchor
edits retain inherited fields, explicit cleared settings take priority, and
deleting the original context's capture rolls back completely on a write failure.
Real history controls verify pending actions surviving refresh, retained drafts
after failed writes or reads, grouping rollback/retry, and successful saves
whose following refresh fails. Held transaction completions verify that a
merged group stays locked until every overlapping save finishes. These checks
use only the temporary database.
Simulated cloud
responses exercise interrupted uploads, new work arriving during an upload,
failed-upload retries, canceled queue entries, and shared Web Locks. No real cloud client is created and
no data is uploaded. These checks complement the dependency-free Node suite;
Node does not provide a native IndexedDB implementation.
