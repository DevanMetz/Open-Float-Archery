// Native IndexedDB regression checks. Run through test/browser.html, not Node.
// Redirect this page's database factory to a unique name; never open user data.
const runButton = document.getElementById("run");
const summary = document.getElementById("summary");
const results = document.getElementById("results");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejects(action) {
  let rejected = false;
  try { await action(); } catch (_) { rejected = true; }
  assert(rejected, "Expected the operation to reject");
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  results.replaceChildren();
  summary.textContent = "Running...";
  const nativeFactory = window.indexedDB;
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
  const testName = `openfloat-test-${crypto.randomUUID()}`;
  let db;
  let passed = 0;
  let failed = 0;

  async function check(name, action) {
    const item = document.createElement("li");
    try {
      await action();
      passed += 1;
      item.className = "pass";
      item.textContent = `PASS: ${name}`;
    } catch (error) {
      failed += 1;
      item.className = "fail";
      item.textContent = `FAIL: ${name} - ${error.message}`;
    }
    results.append(item);
  }

  try {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: { open: (_name, version) => nativeFactory.open(testName, version) },
    });
    const api = await import(`../app/core/db.js?browser-test=${testName}`);
    db = await api.initDb();
    const transaction = db.transaction.bind(db);
    const completed = new WeakSet();
    let latestWrite;
    let abortNextWrite = false;

    db.transaction = (...args) => {
      const tx = transaction(...args);
      if (tx.mode === "readwrite") {
        latestWrite = tx;
        tx.addEventListener("complete", () => completed.add(tx));
        if (abortNextWrite) {
          abortNextWrite = false;
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            for (const method of ["put", "delete"]) {
              const original = store[method].bind(store);
              store[method] = (...values) => {
                const request = original(...values);
                request.addEventListener("success", () => tx.abort(), { once: true });
                return request;
              };
            }
            return store;
          };
        }
      }
      return tx;
    };

    await check("put resolves only after transaction commit", async () => {
      const key = await api.put("shots", { id: "committed", label: "Original" });
      assert(key === "committed", "The saved key must be returned");
      assert(completed.has(latestWrite), "Write resolved before commit");
    });

    await check("put rejects an abort after request success", async () => {
      abortNextWrite = true;
      await rejects(() => api.put("shots", { id: "aborted" }));
      assert(!await api.get("shots", "aborted"), "Aborted data was saved");
    });

    await check("delete rejects a rollback and preserves the original shot", async () => {
      await api.put("shots", { id: "keep-on-abort" });
      abortNextWrite = true;
      await rejects(() => api.remove("shots", "keep-on-abort"));
      assert(!!await api.get("shots", "keep-on-abort"), "Rolled-back shot was lost");
    });

    await check("sync status updates wait for commit and reject rollbacks", async () => {
      const id = await api.put("sync_queue", { status: "pending" });
      await api.updateSyncTaskStatus(id, "done");
      assert(completed.has(latestWrite), "Status resolved before commit");
      abortNextWrite = true;
      await rejects(() => api.updateSyncTaskStatus(id, "failed"));
      assert((await api.get("sync_queue", id)).status === "done", "Status rollback was lost");
    });

    const envelope = (stores) => ({ format: api.EXPORT_FORMAT, version: api.EXPORT_VERSION, stores });
    await check("a bad later import row cannot leave earlier writes behind", async () => {
      await rejects(() => api.importAllData(envelope({
        shots: [{ id: "partial-import" }, { label: "Missing primary key" }],
      })));
      assert(!await api.get("shots", "partial-import"), "Import partially committed");
    });

    await check("failed replacement import preserves all existing records", async () => {
      await rejects(() => api.importAllData(envelope({
        shots: [{ id: "replacement" }, { id: "uncloneable", payload: () => {} }],
      }), { merge: false }));
      assert((await api.get("shots", "committed"))?.label === "Original", "Existing records were cleared");
      assert(!await api.get("shots", "replacement"), "Replacement partially committed");
    });

    await check("malformed store lists and unsupported versions are rejected", async () => {
      await rejects(() => api.importAllData(envelope({ shots: "invalid" })));
      await rejects(() => api.importAllData({ ...envelope({ shots: [] }), version: 999 }));
    });

    await check("single-shot import rolls back both shot and trace on a cloning failure", async () => {
      await rejects(() => api.importAllData({
        format: "openfloat-shot-export", version: 1,
        shot: { id: "single-abort" },
        trace: { shot_id: "single-abort", payload: () => {} },
      }));
      assert(!await api.get("shots", "single-abort"), "Single-shot import partially committed");
      assert(!await api.get("shot_traces", "single-abort"), "Invalid trace was saved");
    });

    await check("valid single-shot import commits linked metadata and trace", async () => {
      const counts = await api.importAllData({
        format: "openfloat-shot-export", version: 1,
        shot: { id: "single-valid" },
        trace: { shot_id: "single-valid", payload: [{ ax: 1, tUs: 0 }] },
      });
      assert(counts.shots === 1 && counts.shot_traces === 1, "Wrong single-shot import counts");
      assert((await api.get("shot_traces", "single-valid")).payload.length === 1, "Trace was lost");
    });

    await check("exports and valid merged imports preserve session scorecard settings", async () => {
      await api.put("shots", { id: "roundtrip" });
      await api.put("session_overrides", { id: "committed", name: "Practice", arrows_per_end: 6 });
      const backup = await api.exportAllData();
      assert(backup.stores.shots.some((shot) => shot.id === "roundtrip"), "Export omitted the shot");
      const counts = await api.importAllData(backup);
      assert(counts.session_overrides === 1, "Import counts are wrong");
      assert((await api.get("session_overrides", "committed")).arrows_per_end === 6, "End size was lost");
    });

    await check("database open can recover after an initial failure", async () => {
      const open = window.indexedDB.open;
      const retryApi = await import(`../app/core/db.js?retry-test=${testName}`);
      let reopened;
      try {
        // This temporary DB is already version 2, so opening at 1 must fail.
        window.indexedDB.open = () => nativeFactory.open(testName, 1);
        await rejects(() => retryApi.initDb());
        window.indexedDB.open = open;
        reopened = await retryApi.initDb();
        assert(reopened.name === testName, "Reopened the wrong database");
      } finally {
        window.indexedDB.open = open;
        reopened?.close();
      }
    });
  } catch (error) {
    failed += 1;
    const item = document.createElement("li");
    item.className = "fail";
    item.textContent = `FAIL: Test setup - ${error.message}`;
    results.append(item);
  } finally {
    if (originalDescriptor) Object.defineProperty(window, "indexedDB", originalDescriptor);
    else delete window.indexedDB;
    db?.close();
    await new Promise((resolve) => {
      const request = nativeFactory.deleteDatabase(testName);
      request.onsuccess = request.onerror = resolve;
    });
    summary.textContent = `${passed} passed, ${failed} failed. Temporary database removed.`;
    runButton.disabled = false;
  }
});
