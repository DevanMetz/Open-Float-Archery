# OpenFloat JavaScript tests

This repository uses Node's built-in test runner with no npm dependencies.

Run the pure-function unit suite from the repository root:

```powershell
node --test test/
```

The tests import the browser app's ES modules directly. Keep fixtures small and
focused so the suite stays useful for a buildless static app.
