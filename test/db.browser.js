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
          const abortStore = abortNextWrite;
          abortNextWrite = false;
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            if (abortStore !== true && name !== abortStore) return store;
            for (const method of ["put", "delete", "add"]) {
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

    await check("import cannot overwrite this browser's queue or replay foreign deletes", async () => {
      const localTask = { table: "shots", action: "CREATE", targetId: "local-only", payload: { id: "local-only" }, status: "pending" };
      const id = await api.put("sync_queue", localTask);
      const counts = await api.importAllData(envelope({
        shots: [{ id: "imported", arrow_score: 8 }],
        sync_queue: [{ id, table: "shots", action: "DELETE", targetId: "foreign", status: "pending" }],
      }), { queueForSync: true });
      assert(counts.sync_queue === 1, "Import did not create one fresh upload");
      assert((await api.get("sync_queue", id)).targetId === "local-only", "Local queue task was overwritten");
      const tasks = await api.getAll("sync_queue");
      assert(!tasks.some((task) => task.targetId === "foreign"), "Foreign delete was replayed");
      assert(tasks.some((task) => task.targetId === "imported" && task.id > id), "Fresh upload did not follow existing work");
    });

    await check("an imported correction follows older queued data for the same shot", async () => {
      const olderId = await api.put("sync_queue", {
        table: "shots", action: "CREATE", targetId: "corrected", payload: { id: "corrected", arrow_score: 3 }, status: "pending",
      });
      await api.importAllData(envelope({ shots: [{ id: "corrected", arrow_score: 10 }] }), { queueForSync: true });
      const tasks = (await api.getAll("sync_queue")).filter((task) => task.targetId === "corrected");
      assert(tasks.length === 2 && tasks[1].id > olderId, "New correction was hidden by an older task");
      assert(tasks[1].payload.arrow_score === 10, "The queued correction has stale data");
    });

    await check("upload-queue failure rolls back imported records too", async () => {
      abortNextWrite = "sync_queue";
      await rejects(() => api.importAllData(envelope({ shots: [{ id: "queue-abort" }] }), { queueForSync: true }));
      assert(!await api.get("shots", "queue-abort"), "Imported shot committed without its upload task");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === "queue-abort"), "Aborted upload task survived");
    });

    const { CloudSyncAdapter } = await import("../app/telemetry/sync.js?v=shot-store-134");
    const adapter = Object.create(CloudSyncAdapter.prototype);
    adapter.user = { id: "browser-test-user" };
    adapter.reportedSchemaSkips = new Set();
    adapter.bus = { emit() {} };
    const taskFor = (id, status = "pending") => ({
      table: "shots", action: "CREATE", targetId: id, payload: { id }, status,
    });

    await check("sync recovers interrupted work and drains tasks added during upload", async () => {
      await api.put("sync_queue", taskFor("interrupted", "syncing"));
      const uploaded = [];
      let appended = false;
      const fakeCloud = {
        from() { return { async upsert(payload) {
          uploaded.push(payload.id);
          if (!appended) {
            appended = true;
            await api.put("sync_queue", taskFor("arrived-during-upload"));
          }
          return { error: null };
        } }; },
      };
      await adapter.processQueue(fakeCloud);
      assert(uploaded.includes("interrupted"), "Interrupted upload was stranded");
      assert(uploaded.includes("arrived-during-upload"), "New work was left waiting for another trigger");
      assert((await api.getPendingSyncTasks()).length === 0, "Pending work remains");
    });

    await check("failed cloud work remains pending and can be retried", async () => {
      const id = await api.put("sync_queue", taskFor("retry-upload"));
      await rejects(() => adapter.processQueue({ from() { return { async upsert() {
        return { error: { message: "Simulated offline failure" } };
      } }; } }));
      assert((await api.get("sync_queue", id)).status === "pending", "Failed task cannot be retried");
      await adapter.processQueue({ from() { return { async upsert() { return { error: null }; } }; } });
      assert(!await api.get("sync_queue", id), "Successful retry did not clear the task");
    });

    await check("two queue consumers share one browser lock", async () => {
      assert(!!navigator.locks?.request, "This check requires Web Locks (Chrome or Edge)");
      await api.put("sync_queue", taskFor("one-upload"));
      let uploads = 0;
      const fakeCloud = { from() { return { async upsert() { uploads += 1; return { error: null }; } }; } };
      const second = Object.create(CloudSyncAdapter.prototype);
      Object.assign(second, { user: adapter.user, reportedSchemaSkips: new Set(), bus: adapter.bus });
      await Promise.all([adapter.processQueue(fakeCloud), second.processQueue(fakeCloud)]);
      assert(uploads === 1, `The same task uploaded ${uploads} times`);
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
