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
saves, and demo exclusion from the queue. Simulated cloud
responses exercise interrupted uploads, new work arriving during an upload,
failed-upload retries, and shared Web Locks. No real cloud client is created and
no data is uploaded. These checks complement the dependency-free Node suite;
Node does not provide a native IndexedDB implementation.
