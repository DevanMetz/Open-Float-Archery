# OpenFloat JavaScript tests

This repository uses Node's built-in test runner with no npm dependencies.

Run the pure-function unit suite from the repository root:

```powershell
node --test test/
```

The tests import the browser app's ES modules directly. Keep fixtures small and
focused so the suite stays useful for a buildless static app.

For native IndexedDB regression checks, serve the repository and open
`http://localhost:4178/test/browser.html` in Chrome or Edge. Click **Run storage
checks**. The page creates a uniquely named temporary database, redirects only
its own storage calls to that database, and removes it after the run. It never
opens the app's database or changes practice records.

These browser checks exercise commit timing, aborted writes and deletes,
sync-status rollback, atomic full and single-shot imports, backup round trips,
and retry after a failed database open. They complement the dependency-free
Node suite; Node does not provide a native IndexedDB implementation.
