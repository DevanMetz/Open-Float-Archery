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

function waitForDOM(node, condition, message) {
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (condition()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(message)); }, 5000);
    observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

function waitForState(store, condition, message) {
  if (condition(store.get())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error(message)); }, 5000);
    unsubscribe = store.subscribe((state) => {
      if (condition(state)) { clearTimeout(timeout); unsubscribe(); resolve(); }
    });
  });
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
      console.error(`Browser check failed: ${name}`, error.stack || error.message);
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
    const completed = new WeakSet();
    let latestWrite;
    let abortNextWrite = false;

    function observeTransactions(connection) {
      const transaction = connection.transaction.bind(connection);
      connection.transaction = (...args) => {
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
    }
    observeTransactions(db);

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

    await check("selected exports include only linked captures and session context, and restore normally", async () => {
      await api.importAllData(envelope({
        shots: [
          { id: "selected-anchor", session_id: "selected-session", sample: true, arrow_score: 9 },
          { id: "selected-later", session_id: "selected-session", sample: true },
          { id: "unrelated-shot", session_id: "unrelated-session" },
        ],
        shot_traces: [
          { shot_id: "selected-anchor", payload: [{ tUs: 0 }] },
          { shot_id: "unrelated-shot", payload: [] },
        ],
        sessions: [
          { id: "selected-session", bow_profile_id: "selected-bow" },
          { id: "unrelated-session", bow_profile_id: "unrelated-bow" },
        ],
        session_overrides: [
          { id: "selected-anchor", name: "Selected practice", bow_profile_id: "selected-bow", arrows_per_end: 6 },
          { id: "unrelated-shot", name: "Private practice" },
        ],
        bow_profiles: [{ id: "selected-bow" }, { id: "unrelated-bow" }],
      }));
      const exported = await api.exportSelectedShots(["selected-anchor", "selected-later", "selected-anchor"]);
      const { stores } = exported;
      assert(stores.shots.length === 2 && stores.shots.every((shot) => shot.sample), "Export included an unselected shot");
      assert(stores.shot_traces.length === 1 && stores.shot_traces[0].shot_id === "selected-anchor", "Export included an unrelated trace");
      assert(stores.sessions.length === 1 && stores.sessions[0].id === "selected-session", "Export leaked unrelated session metadata");
      assert(stores.bow_profiles.length === 1 && stores.bow_profiles[0].id === "selected-bow", "Export included an unrelated bow");
      assert(stores.session_overrides.length === 1 && stores.session_overrides[0].arrows_per_end === 6, "Session settings were lost");
      assert(!("sync_queue" in stores), "Browser-local upload tasks were exported");
      const partial = await api.exportSelectedShots(["selected-later"]);
      assert(partial.stores.session_overrides.length === 0, "Partial export invented a new session anchor");
      await api.remove("shots", "selected-anchor");
      const counts = await api.importAllData(exported);
      assert(counts.shots === 2 && (await api.get("shots", "selected-anchor")).arrow_score === 9, "Selected export could not restore a capture");
    });

    await check("selected exports reject empty or stale selections instead of silently dropping shots", async () => {
      await rejects(() => api.exportSelectedShots([]));
      await api.put("shot_traces", { shot_id: "orphan-selection", payload: [] });
      await rejects(() => api.exportSelectedShots(["selected-anchor", "orphan-selection"]));
    });

    await check("selected exports keep shot metadata and trace in one snapshot during a concurrent save", async () => {
      await api.saveCapture({ id: "snapshot-shot", label: "Before", sample: true }, {
        shot_id: "snapshot-shot", payload: [{ ax: 1 }],
      });
      const previousTransaction = db.transaction;
      let concurrentSave;
      db.transaction = (...args) => {
        const tx = previousTransaction(...args);
        if (tx.mode === "readonly") {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            if (name === "shots") {
              const get = store.get.bind(store);
              store.get = (...keys) => {
                const request = get(...keys);
                request.addEventListener("success", () => {
                  if (!concurrentSave) concurrentSave = api.saveCapture({ id: "snapshot-shot", label: "After", sample: true }, {
                    shot_id: "snapshot-shot", payload: [{ ax: 2 }],
                  });
                }, { once: true });
                return request;
              };
            }
            return store;
          };
        }
        return tx;
      };
      try {
        const exported = await api.exportSelectedShots(["snapshot-shot"]);
        await concurrentSave;
        assert(exported.stores.shots[0].label === "Before", "Metadata changed mid-export");
        assert(exported.stores.shot_traces[0].payload[0].ax === 1, "Trace came from a later save");
      } finally {
        db.transaction = previousTransaction;
      }
      assert((await api.get("shots", "snapshot-shot")).label === "After", "Concurrent save did not complete");
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

    await check("capture saves metadata, trace, and ordered uploads only after commit", async () => {
      await api.saveCapture({ id: "capture-real" }, { shot_id: "capture-real", payload: [] });
      assert(completed.has(latestWrite), "Capture resolved before commit");
      assert(!!await api.get("shots", "capture-real"), "Metadata is missing");
      assert(!!await api.get("shot_traces", "capture-real"), "Replay is missing");
      const tasks = (await api.getAll("sync_queue")).filter((task) => task.targetId === "capture-real");
      assert(tasks.map((task) => task.table).join() === "shots,shot_traces", "Capture upload order is wrong");
    });

    await check("demo captures remain reviewable without entering the upload queue", async () => {
      await api.saveCapture({ id: "capture-demo", sample: true }, { shot_id: "capture-demo", payload: [] });
      assert(!!await api.get("shots", "capture-demo"), "Demo metadata is missing");
      assert(!!await api.get("shot_traces", "capture-demo"), "Demo replay is missing");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === "capture-demo"), "Demo data was queued");
    });

    await check("capture trace or queue failures cannot leave partial metadata behind", async () => {
      await rejects(() => api.saveCapture({ id: "capture-bad-trace" }, { shot_id: "capture-bad-trace", payload: () => {} }));
      assert(!await api.get("shots", "capture-bad-trace"), "Capture survived a failed trace save");
      abortNextWrite = "sync_queue";
      await rejects(() => api.saveCapture({ id: "capture-bad-queue" }, { shot_id: "capture-bad-queue", payload: [] }));
      assert(!await api.get("shots", "capture-bad-queue"), "Capture survived a queue rollback");
      assert(!await api.get("shot_traces", "capture-bad-queue"), "Trace survived a queue rollback");
    });

    await check("capture rejects a trace belonging to another shot", async () => {
      await rejects(() => api.saveCapture({ id: "capture-mismatch" }, { shot_id: "another-shot", payload: [] }));
      assert(!await api.get("shots", "capture-mismatch"), "Mismatched capture was saved");
    });

    await check("arrow results commit with their upload and preserve the latest telemetry and trace", async () => {
      await api.saveCapture({ id: "outcome-edit", shot_score: 82, capture_kind: "arrow" }, {
        shot_id: "outcome-edit", payload: [{ ax: 3 }],
      });
      const saved = await api.saveShotOutcome("outcome-edit", { arrow_score: 10, arrow_is_x: true, impact_x: 0.01 });
      assert(completed.has(latestWrite), "Outcome save resolved before commit");
      assert(saved.shot_score === 82 && saved.capture_kind === "arrow", "Outcome edit overwrote telemetry");
      assert(saved.arrow_score === 10 && saved.arrow_is_x, "Outcome was not saved");
      const uploads = (await api.getAll("sync_queue")).filter((task) => task.targetId === "outcome-edit" && task.action === "UPDATE");
      assert(uploads.length === 1 && uploads[0].payload.arrow_score === 10 && uploads[0].payload.shot_score === 82, "Upload differs from the saved result");
      assert((await api.get("shot_traces", "outcome-edit")).payload[0].ax === 3, "Outcome edit changed the trace");
    });

    await check("a failed outcome upload task rolls back the score and impact together", async () => {
      abortNextWrite = "sync_queue";
      await rejects(() => api.saveShotOutcome("outcome-edit", { arrow_score: 1, arrow_is_x: false, impact_x: 0.9 }));
      const saved = await api.get("shots", "outcome-edit");
      assert(saved.arrow_score === 10 && saved.arrow_is_x && saved.impact_x === 0.01, "Failed outcome partially committed");
      const updates = (await api.getAll("sync_queue")).filter((task) => task.targetId === "outcome-edit" && task.action === "UPDATE");
      assert(updates.length === 1, "Failed outcome left an upload task behind");
    });

    await check("outcome edits cannot recreate deleted captures", async () => {
      await rejects(() => api.saveShotOutcome("deleted-outcome", { arrow_score: 9 }));
      assert(!await api.get("shots", "deleted-outcome"), "Deleted capture was recreated");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === "deleted-outcome"), "Missing capture entered the upload queue");
    });

    await check("editing and clearing demo outcomes remains local", async () => {
      await api.put("shots", { id: "outcome-demo", device_id: "OpenFloat-Demo", arrow_score: 4 });
      await api.saveShotOutcome("outcome-demo", { arrow_score: 10, arrow_is_x: true });
      const cleared = await api.saveShotOutcome("outcome-demo", { arrow_score: null, arrow_is_x: false });
      assert(cleared.arrow_score === null && !cleared.arrow_is_x, "Result was not cleared");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === "outcome-demo"), "Demo outcome entered the queue");
    });

    await check("late trace scores and arrow outcomes merge in either transaction order", async () => {
      for (const traceFirst of [true, false]) {
        const id = `trace-outcome-${traceFirst}`;
        await api.put("shots", { id, label: "Keep my label", shot_score: 40 });
        const trace = { shot_id: id, payload: [{ roll: 1 }], source: "browser" };
        const score = () => api.saveShotTrace(trace, { shot_score: 87, follow_through: 93 });
        const outcome = () => api.saveShotOutcome(id, { arrow_score: 10, arrow_is_x: true, impact_x: 0.02 });
        await Promise.all(traceFirst ? [score(), outcome()] : [outcome(), score()]);
        const saved = await api.get("shots", id);
        assert(saved.shot_score === 87 && saved.follow_through === 93, "Outcome overwrote delayed metrics");
        assert(saved.arrow_score === 10 && saved.arrow_is_x && saved.impact_x === 0.02, "Trace overwrote the entered arrow result");
        assert(saved.label === "Keep my label", "Trace replaced the capture metadata");
      }
    });

    await check("full browser traces survive firmware recovery in either transaction order", async () => {
      for (const browserFirst of [true, false]) {
        const id = `trace-priority-${browserFirst}`;
        await api.put("shots", { id, arrow_score: 9 });
        const browser = { shot_id: id, source: "browser", sample_rate_hz: 208, payload: [{ tUs: 0, az: 1 }, { tUs: 4808, az: 16 }] };
        const firmware = { shot_id: id, source: "firmware", sample_rate_hz: 52, payload: [{ roll: 8 }] };
        const full = () => api.saveShotTrace(browser, { shot_score: 87 });
        const recovery = () => api.saveShotTrace(firmware, { shot_score: 12 });
        await Promise.all(browserFirst ? [full(), recovery()] : [recovery(), full()]);
        assert(JSON.stringify(await api.get("shot_traces", id)) === JSON.stringify(browser), "Firmware replaced the full browser trace");
        const shot = await api.get("shots", id);
        assert(shot.shot_score === 87 && shot.arrow_score === 9, "Trace recovery changed the full score or target result");
        const before = (await api.getAll("sync_queue")).length;
        assert(await recovery() === null, "Skipped firmware recovery reported a write");
        assert((await api.getAll("sync_queue")).length === before, "Skipped firmware recovery queued an overwrite");
        const traceTasks = (await api.getAll("sync_queue")).filter((task) => task.table === "shot_traces" && task.targetId === id);
        assert(traceTasks.at(-1).payload.source === "browser", "Cloud queue would replace the retained browser recording");
      }
    });

    await check("firmware recovery fills missing or empty browser recordings", async () => {
      for (const empty of [true, false]) {
        const id = `trace-recover-empty-${empty}`;
        await api.put("shots", { id, shot_score: null });
        if (empty) await api.put("shot_traces", { shot_id: id, source: "browser", payload: [] });
        const firmware = { shot_id: id, source: "firmware", payload: [{ roll: 8 }] };
        assert((await api.saveShotTrace(firmware)).id === id, "Available firmware trace was discarded");
        assert((await api.get("shot_traces", id)).source === "firmware", "Missing trace was not recovered");
      }
    });

    await check("failed late trace writes roll back the trace, metrics and upload tasks", async () => {
      for (const failingStore of ["shot_traces", "sync_queue"]) {
        const id = `trace-rollback-${failingStore}`;
        await api.put("shots", { id, shot_score: 61, arrow_score: 9 });
        await api.put("shot_traces", { shot_id: id, source: "original", payload: [] });
        abortNextWrite = failingStore;
        await rejects(() => api.saveShotTrace({ shot_id: id, source: "replacement", payload: [] }, { shot_score: 99 }));
        const saved = await api.get("shots", id);
        assert(saved.shot_score === 61 && saved.arrow_score === 9, "A failed trace changed saved metrics");
        assert((await api.get("shot_traces", id)).source === "original", "Failed trace replaced the original replay");
        assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === id), "Failed trace left upload work behind");
      }
    });

    await check("late traces cannot recreate deleted captures or queue orphan uploads", async () => {
      const id = "deleted-before-trace";
      await api.put("shots", { id });
      await api.removeSavedShots([id]);
      assert(await api.saveShotTrace({ shot_id: id, payload: [] }, { shot_score: 80 }) === null, "Deleted capture accepted a trace");
      assert(!await api.get("shots", id) && !await api.get("shot_traces", id), "Late trace recreated deleted data");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === id), "Late trace queued an orphan upload");
    });

    await check("late traces preserve demo provenance and remain local", async () => {
      const id = "demo-late-trace";
      await api.put("shots", { id, device_id: "OpenFloat-Demo", shot_score: 20 });
      await api.saveShotTrace({ shot_id: id, payload: [], source: "browser" }, { shot_score: 40 });
      const trace = await api.get("shot_traces", id);
      assert(trace.sample && trace.source === "sample", "Late trace lost its demo marker");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === id), "Demo trace entered the upload queue");
    });

    await check("capture deletion commits linked records together and preserves unrelated queue rows", async () => {
      await api.put("shots", { id: "delete-local", timestamp: "2001-01-01T12:00:00Z" });
      await api.put("shot_traces", { shot_id: "delete-local", payload: [] });
      await api.put("session_overrides", { id: "delete-local", name: "Gone" });
      const queueIds = [];
      for (const task of [
        { table: "shots", targetId: "delete-local", status: "pending" },
        { table: "shot_traces", payload: { shot_id: "delete-local" }, status: "syncing" },
        { table: "shots", payload: { id: "delete-local" }, status: "pending" },
      ]) queueIds.push(await api.put("sync_queue", task));
      const unrelated = await api.put("sync_queue", { table: "bow_profiles", targetId: "delete-local", payload: { id: "delete-local" }, status: "pending" });
      const count = await api.removeSavedShots(["delete-local", "delete-local"]);
      assert(count === 1 && completed.has(latestWrite), "Deletion resolved before commit or counted duplicates");
      assert(!await api.get("shots", "delete-local") && !await api.get("shot_traces", "delete-local"), "Capture was only partially deleted");
      assert(!await api.get("session_overrides", "delete-local"), "Empty session kept its override");
      for (const id of queueIds) assert(!await api.get("sync_queue", id), "Deleted capture kept an upload task");
      assert(!!await api.get("sync_queue", unrelated), "Deletion removed unrelated bow work");
    });

    await check("bulk deletion rolls back captures, traces, queue and moved session settings on failure", async () => {
      for (const failingStore of ["shot_traces", "sync_queue", "session_overrides"]) {
        const ids = ["a", "b", "c"].map((suffix) => `rollback-${failingStore}-${suffix}`);
        for (const [index, id] of ids.entries()) {
          await api.put("shots", { id, timestamp: `2002-01-01T12:0${index}:00Z` });
          await api.put("shot_traces", { shot_id: id, payload: [] });
        }
        await api.put("session_overrides", { id: ids[0], name: "Keep practice", arrows_per_end: 6 });
        const task = await api.put("sync_queue", { table: "shots", targetId: ids[0], status: "pending" });
        abortNextWrite = failingStore;
        await rejects(() => api.removeSavedShots(ids.slice(0, 2)));
        for (const id of ids) {
          assert(!!await api.get("shots", id) && !!await api.get("shot_traces", id), `${failingStore} failure lost a capture`);
        }
        assert((await api.get("session_overrides", ids[0])).name === "Keep practice", "Original session settings were lost");
        assert(!await api.get("session_overrides", ids[2]), "Rolled-back anchor migration remained");
        assert(!!await api.get("sync_queue", task), "Rolled-back deletion lost its upload task");
      }
    });

    await check("deleting anchors and bridging shots preserves surviving session names, bows and end sizes", async () => {
      const ids = ["split-a", "split-b", "split-c", "split-d"];
      for (const [index, id] of ids.entries()) {
        await api.put("shots", { id, timestamp: new Date(Date.parse("2003-01-01T12:00:00Z") + index * 20 * 60000).toISOString() });
      }
      await api.put("session_overrides", { id: ids[0], name: "Range practice", bow_profile_id: "my-bow", arrows_per_end: 6 });
      await api.put("session_overrides", { id: ids[2], name: "Specific session name" });
      await api.removeSavedShots([ids[1]]);
      const split = await api.get("session_overrides", ids[2]);
      assert(split.name === "Specific session name" && split.arrows_per_end === 6 && split.bow_profile_id === "my-bow", "Split session lost context or overwrote its own name");
      await api.removeSavedShots([ids[0], ids[2]]);
      const remaining = await api.get("session_overrides", ids[3]);
      assert(remaining.name === split.name && remaining.arrows_per_end === 6 && remaining.bow_profile_id === "my-bow", "Anchor deletion lost session settings");
      assert(!await api.get("session_overrides", ids[0]) && !await api.get("session_overrides", ids[2]), "Deleted anchors were retained");
    });

    await check("capture deletion rejects invalid ids and safely handles empty or stale selections", async () => {
      await rejects(() => api.removeSavedShots(["committed", ""]));
      assert(!!await api.get("shots", "committed"), "Invalid selection partially deleted data");
      assert(await api.removeSavedShots([]) === 0, "Empty deletion changed records");
      assert(await api.removeSavedShots(["already-deleted"]) === 0, "Stale selection reported a deletion");
    });

    const { TelemetryStore } = await import("../app/telemetry/telemetry.js?v=shot-store-200");
    const { BleAdapter } = await import("../app/device/adapters.js?v=shot-store-200");
    const { firmwareTraceFrames, timedFirmwareTraceFrames } = await import("./fixtures/firmware-trace.js?v=shot-store-155");
    const { decodeBinaryFrame } = await import("../app/protocol/frame.js?v=shot-store-199");
    const { decodeTimedFirmwareTrace } = await import("../app/protocol/trace.js?v=shot-store-155");
    const { EventBus, createStore } = await import("../app/core/store.js?v=shot-store-180");
    const captureDb = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
    observeTransactions(captureDb);

    function deviceRecorder() {
      const recorder = Object.assign(Object.create(TelemetryStore.prototype), {
        bus: new EventBus(), store: createStore({}),
        trace: [], history30s: [], pendingTraces: new Map(),
      });
      recorder.reset();
      recorder.store.set({ connected: true, statusMode: "live", formScore: 50, yaw: 12 });
      return recorder;
    }
    const deviceShot = (shotId) => ({ shotId, shotCount: shotId, stored: true, axMg: 0, ayMg: 0, azMg: 16000 });
    const traceChunk = (shotId) => ({ shotId, chunkIndex: 0, totalChunks: 1, pointStride: 7, payload: new Uint8Array([0, 0, 0, 0, 0, 0, 12]) });

    function firmwareRecovery(recorder) {
      const adapter = new BleAdapter(recorder.bus);
      const commands = [], saves = [];
      adapter.traceProtocol = 2;
      adapter.sendControl = async (command) => { commands.push(command); return true; };
      recorder.bus.on("trace-chunk", (chunk) => saves.push(recorder.onTraceChunk(chunk)));
      return { adapter, commands, saves,
        feed(shotId) {
          for (const bytes of firmwareTraceFrames(shotId, 3).frames) {
            adapter._onValue({ target: { value: new DataView(bytes.buffer) } });
          }
        },
        close() { adapter._stopTraceDownloadTimer(); adapter.unsubscribeShotSaved(); },
      };
    }

    async function withReconnectRecovery(run, { deviceId } = {}) {
      const bus = new EventBus(), store = createStore({});
      const setInterval = window.setInterval;
      let interval, recorder;
      window.setInterval = (...args) => { interval = setInterval(...args); return interval; };
      try { recorder = new TelemetryStore(bus, store); }
      finally { window.setInterval = setInterval; }
      const marker = document.createElement("ol");
      marker.hidden = true; document.body.append(marker);
      const commands = [], saves = [], ids = [];
      const saveTrace = recorder.onTraceChunk.bind(recorder);
      recorder.onTraceChunk = (chunk) => {
        const saving = saveTrace(chunk); saves.push(saving); return saving;
      };
      let live;
      const control = { writeValue: async (bytes) => {
        commands.push(new TextDecoder().decode(bytes));
        marker.append(document.createElement("li"));
      } };
      const device = new EventTarget(); device.name = "OpenFloat-Test";
      if (deviceId !== undefined) device.id = deviceId;
      const server = {
        connected: false,
        connect: async () => {
          server.connected = true;
          live = new EventTarget(); live.startNotifications = async () => live;
          return server;
        },
        disconnect: () => {
          if (!server.connected) return;
          server.connected = false;
          device.dispatchEvent(new Event("gattserverdisconnected"));
        },
        getPrimaryService: async (uuid) => {
          if (uuid === "battery_service") return { getCharacteristic: async () => ({
            addEventListener() {}, removeEventListener() {}, startNotifications: async () => {},
            readValue: async () => new DataView(new Uint8Array([80]).buffer),
          }) };
          return { getCharacteristic: async (id) => id.endsWith("002") ? live : control };
        },
      };
      device.gatt = server;
      const adapter = new BleAdapter(bus); adapter.device = device;
      device.addEventListener("gattserverdisconnected", adapter.dropHandler);
      const fixture = {
        recorder, adapter, commands, marker,
        get live() { return live; },
        notify(bytes, target = live) {
          target.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          target.dispatchEvent(new Event("characteristicvaluechanged"));
        },
        async metadata(shotId, { protocol = 1, stored = true, shotCount = shotId } = {}) {
          const bytes = new Uint8Array(29); bytes.set([0x4f, 0x46, protocol, stored ? 4 : 2]);
          const view = new DataView(bytes.buffer);
          view.setUint16(4, shotCount, true); view.setUint16(6, shotId, true); view.setInt16(12, 16000, true);
          if (stored) view.setUint16(26, Math.floor(shotId / 65536), true);
          else if (protocol === 2) {
            view.setUint16(22, Math.floor(shotId / 65536), true);
            view.setUint16(24, Math.floor(shotCount / 65536), true);
            view.setUint16(26, 123, true);
          }
          fixture.notify(bytes);
          await waitForDOM(marker, () => commands.includes(`${stored ? "tracetimed" : "shotack"}:${shotId}`), "Saved metadata did not acknowledge its full ID or request its replay");
          const id = recorder.connectionShotIds.get(shotId); ids.push(id); return id;
        },
        drop() { server.disconnect(); adapter._stopReconnectTimer(); },
        reconnect() { return adapter._connectGatt(); },
        settleTraces() { return Promise.all(saves.splice(0)); },
      };
      try { await adapter._connectGatt(); await run(fixture); }
      finally {
        await adapter.disconnect(); clearInterval(interval); marker.remove();
        await fixture.settleTraces();
        if (ids.length) await api.removeSavedShots(ids);
      }
    }

    await check("BLE sensors with matching names and capture IDs save and replay separate captures", async () => {
      await withReconnectRecovery(async (first) => {
        const firstId = await first.metadata(0);
        first.drop();
        await withReconnectRecovery(async (second) => {
          const secondId = await second.metadata(0);
          assert(firstId !== secondId, "Another BLE sensor reused the first sensor's saved capture");
          const firstShot = await api.get("shots", firstId), secondShot = await api.get("shots", secondId);
          assert(firstShot.device_id === "OpenFloat-BLE:sensor-a" && secondShot.device_id === "OpenFloat-BLE:sensor-b",
            "Saved metadata lost its sensor identity");
          for (const bytes of timedFirmwareTraceFrames({ shotId: 0, count: 3 }).frames) second.notify(bytes);
          await second.settleTraces();
          assert((await api.get("shot_traces", secondId)).payload.length === 3 && !await api.get("shot_traces", firstId),
            "One sensor's replay attached to another sensor's capture");
          await first.reconnect();
          assert(first.adapter.currentTraceDownloadShotId === 0 && first.adapter.traceLocalShotIds.get(0) === firstId,
            "Reconnect selected another sensor's saved replay");
          for (const bytes of timedFirmwareTraceFrames({ shotId: 0, count: 4 }).frames) first.notify(bytes);
          await first.settleTraces();
          assert((await api.get("shot_traces", firstId)).payload.length === 4
            && (await api.get("shot_traces", secondId)).payload.length === 3, "Reconnect overwrote the other sensor's replay");
          for (const id of [firstId, secondId]) {
            const shot = await api.get("shots", id);
            const upload = (await api.getAll("sync_queue")).find((task) => task.table === "shots" && task.targetId === id);
            assert(upload.payload.device_id === shot.device_id, "The queued upload changed the saved sensor key");
          }
        }, { deviceId: "sensor-b" });
      }, { deviceId: "sensor-a" });
    });

    await check("known BLE devices never adopt ambiguous legacy sensor captures", async () => {
      const legacyId = "legacy-unidentified-sensor", shotId = 52001;
      await api.saveCapture({ id: legacyId, device_id: "OpenFloat-Sensor", device_shot_id: shotId, timestamp: new Date().toISOString() },
        { shot_id: legacyId, source: "original", payload: [{ roll: 7 }] });
      const recorder = deviceRecorder(); recorder.store.set({ deviceId: "OpenFloat-BLE:sensor-a" });
      const id = await recorder.onShot(deviceShot(shotId));
      assert(id !== legacyId && (await api.get("shots", id)).device_id === "OpenFloat-BLE:sensor-a",
        "A known device was assigned an unidentified legacy capture");
      assert((await api.get("shots", legacyId)).device_id === "OpenFloat-Sensor"
        && (await api.get("shot_traces", legacyId)).source === "original", "Legacy metadata or its replay was rewritten");
    });

    await check("automatic reconnect retries partial traces under their acknowledged local capture id", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { adapter, recorder, commands } = fixture;
        const shotId = 42001, id = await fixture.metadata(shotId);
        const metadata = await api.get("shots", id);
        const queued = (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length;
        const old = timedFirmwareTraceFrames({ shotId, count: 4 }).frames;
        const oldLive = fixture.live;
        fixture.notify(old[0]);
        assert(recorder.pendingTraces.get(shotId)?.chunks.size === 1, "Partial transfer did not reach reassembly");
        fixture.drop(); commands.length = 0;
        assert(recorder.pendingTraces.size === 0 && recorder.connectionShotIds.size === 0, "Drop retained partial chunks or connection mappings");
        assert(await fixture.reconnect(), "Reconnect did not finish");
        assert(commands.filter((command) => command.startsWith("tracetimed:")).join() === `tracetimed:${shotId}`
          && recorder.connectionShotIds.get(shotId) === id, "Reconnect lost the acknowledged trace's exact capture id");
        assert(JSON.stringify(await api.get("shots", id)) === JSON.stringify(metadata)
          && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === queued,
          "Reconnect repeated metadata or its upload without a new shot frame");
        fixture.notify(old[1], oldLive);
        assert(recorder.pendingTraces.size === 0, "A stale notification entered the new transfer");
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4, firstTimeMs: -2000 }).frames) fixture.notify(frame);
        await fixture.settleTraces();
        const saved = await api.get("shot_traces", id);
        assert(saved.source === "firmware-timed" && saved.payload.length === 4 && saved.payload[0].tUs === -2000000,
          "Fresh transfer reused old chunks or saved under another capture");
        assert((await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId).length === 1
          && !adapter.traceLocalShotIds.has(shotId), "Committed replay duplicated metadata or remained pending");
      });
    });

    await check("disconnect after the final chunk retries a replay that has not committed", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { adapter, recorder, commands } = fixture;
        const shotId = 42002, id = await fixture.metadata(shotId);
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4 }).frames) fixture.notify(frame);
        assert(adapter.currentTraceDownloadShotId === null, "Fixture did not receive the last chunk");
        fixture.drop(); commands.length = 0;
        await fixture.settleTraces();
        assert(!await api.get("shot_traces", id), "The disconnected assembly committed before the retry");
        await fixture.reconnect();
        assert(commands.includes(`tracetimed:${shotId}`) && recorder.connectionShotIds.get(shotId) === id,
          "Final-chunk receipt forgot the replay before its local write");
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4 }).frames) fixture.notify(frame);
        await fixture.settleTraces();
        assert((await api.get("shot_traces", id)).payload.length === 4, "The uncommitted replay could not recover");
      });
    });

    await check("reconnect skips completed, deleted and changed captures without another metadata frame", async () => {
      for (const [index, state] of ["completed", "deleted", "changed"].entries()) {
        await withReconnectRecovery(async (fixture) => {
          const { adapter, recorder, commands } = fixture;
          const shotId = 42010 + index, id = await fixture.metadata(shotId);
          fixture.drop(); commands.length = 0;
          if (state === "completed") await api.saveShotTrace({ shot_id: id, source: "browser", payload: [{ roll: 2, pitch: 1 }] });
          else if (state === "deleted") await api.removeSavedShots([id]);
          else await api.put("shots", { ...await api.get("shots", id), device_shot_id: shotId + 100 });
          const queued = (await api.getAll("sync_queue")).length;
          await fixture.reconnect();
          assert(!commands.some((command) => /^(tracetimed|tracereq|shotack):/.test(command))
            && !recorder.connectionShotIds.has(shotId) && !adapter.traceLocalShotIds.has(shotId),
            `Reconnect requested or associated a ${state} capture`);
          assert((await api.getAll("sync_queue")).length === queued, "Skipped recovery created upload work");
          if (state === "deleted") assert(!await api.get("shots", id), "Reconnect resurrected a deleted capture");
          if (state === "completed") assert((await api.get("shot_traces", id)).source === "browser", "Reconnect changed the completed replay");
        });
      }
    });

    await check("a held reconnect lookup cannot restore capture mappings after disconnect", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { recorder, commands } = fixture;
        const shotId = 42020; await fixture.metadata(shotId);
        fixture.drop(); commands.length = 0;
        const transaction = captureDb.transaction;
        let hold = true, ready, release, connecting;
        const readComplete = new Promise((resolve) => { ready = resolve; });
        captureDb.transaction = function (...args) {
          const tx = transaction.apply(this, args);
          if (hold && args[0] === "shots" && args[1] === "readonly") {
            hold = false;
            Object.defineProperty(tx, "oncomplete", { set(handler) {
              tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
            } });
          }
          return tx;
        };
        try {
          connecting = fixture.reconnect();
          const lookedUp = await Promise.race([readComplete.then(() => true), connecting.then(() => false)]);
          assert(lookedUp, "Reconnect did not check the pending capture");
          fixture.drop(); recorder.connectionShotIds.set(shotId, "replacement-capture");
          release(); release = null;
          assert(await connecting === false && !commands.some((command) => command.startsWith("tracetimed:")),
            "A canceled lookup requested a trace from the disconnected link");
          assert(recorder.connectionShotIds.get(shotId) === "replacement-capture", "The old lookup replaced the new association");
        } finally { release?.(); captureDb.transaction = transaction; await connecting; }
      });
    });

    await check("a same-link trace retry discards partial chunks and recovers the original capture", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { adapter, recorder, commands } = fixture;
        const shotId = 42030, id = await fixture.metadata(shotId);
        const metadata = await api.get("shots", id);
        fixture.notify(timedFirmwareTraceFrames({ shotId, count: 4 }).frames[0]);
        // Node advances the real inactivity timer. End the same stalled attempt
        // here so the browser check can concentrate on native storage recovery.
        adapter._completeTraceDownload(shotId, true);
        commands.length = 0;
        assert(await recorder.onShot(deviceShot(shotId)) === id, "Stored repeat lost the original capture id");
        await waitForDOM(fixture.marker, () => commands.includes(`tracetimed:${shotId}`), "Stored repeat did not restart the stalled transfer");
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4, firstTimeMs: -2000 }).frames) fixture.notify(frame);
        await fixture.settleTraces();
        const replay = await api.get("shot_traces", id);
        assert(replay?.source === "firmware-timed" && replay.payload.length === 4 && replay.payload[0].tUs === -2000000,
          "The retry mixed old chunks, discarded its fresh header, or failed to save");
        assert(JSON.stringify(await api.get("shots", id)) === JSON.stringify(metadata)
          && (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId).length === 1,
          "The retry changed or duplicated capture metadata");
      });
    });

    await check("a superseded complete assembly cannot save after another attempt starts for the same shot", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { adapter, recorder } = fixture;
        const shotId = 42031, id = await fixture.metadata(shotId);
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4 }).frames) fixture.notify(frame);
        assert(recorder.pendingTraces.get(shotId)?.saving, "Old assembly did not reach its pending save");
        adapter._enqueueTraceDownload(shotId, id);
        await fixture.settleTraces();
        assert(!await api.get("shot_traces", id), "An abandoned assembly committed after the new request started");
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4, firstTimeMs: -1000 }).frames) fixture.notify(frame);
        await fixture.settleTraces();
        const replay = await api.get("shot_traces", id);
        assert(replay?.payload[0].tUs === -1000000 && !adapter.traceLocalShotIds.has(shotId),
          "The newer attempt did not save and clear its pending recovery");
      });
    });

    await check("wide live and stored IDs share one capture and acknowledge only the full device ID", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { recorder, commands } = fixture;
        recorder.scheduleBrowserShotTraceCapture = () => {};
        const shotId = 65536 + 42040;
        const id = await fixture.metadata(shotId, { protocol: 2, stored: false });
        assert(recorder.store.get().shotCount === shotId && (await api.get("shots", id)).device_shot_id === shotId,
          "Live metadata truncated its counter or saved device ID");
        const replayId = await fixture.metadata(shotId);
        assert(replayId === id && (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId).length === 1,
          "Stored upload duplicated the live capture after 16-bit rollover");
        assert(commands.every((command) => command !== `shotack:${shotId % 65536}`), "The browser acknowledged the truncated live ID");
        for (const frame of timedFirmwareTraceFrames({ shotId, count: 4 }).frames) fixture.notify(frame);
        await fixture.settleTraces();
        assert((await api.get("shot_traces", id)).payload.length === 4, "Full-ID recovery missed the live capture");
      });
    });

    await check("wide count/status frames survive older stored uploads and explicit count corrections", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { recorder } = fixture;
        const count = new Uint8Array(29); count.set([0x4f, 0x46, 2, 3]);
        const view = new DataView(count.buffer); view.setUint16(4, 42041, true); view.setUint16(24, 1, true);
        fixture.notify(count);
        assert(recorder.store.get().shotCount === 65536 + 42041, "Count sync truncated the persisted count");
        await fixture.metadata(65536 + 42041);
        assert(recorder.store.get().shotCount === 65536 + 42041, "An older stored upload lowered the synced lifetime count");
        const status = new Uint8Array(29); status.set([0x4f, 0x46, 2, 5]);
        const statusView = new DataView(status.buffer); statusView.setUint16(4, 42042, true); statusView.setUint16(18, 1, true);
        fixture.notify(status);
        assert(recorder.store.get().shotCount === 65536 + 42042, "Queue status could not refresh the full count");
        view.setUint16(4, 0, true); view.setUint16(24, 0, true); fixture.notify(count);
        assert(recorder.store.get().shotCount === 0, "An explicit device count reset was ignored");
        await fixture.metadata(65536 + 42041);
        assert(recorder.store.get().shotCount === 0, "Historical metadata overrode the corrected device count");
      });
    });

    await check("capture ID zero saves, deduplicates, acknowledges, and replays without accepting unsupported frames", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { recorder, adapter, commands } = fixture;
        recorder.scheduleBrowserShotTraceCapture = () => {};
        const id = await fixture.metadata(0, { protocol: 2, stored: false, shotCount: 0xffffffff });
        const metadata = await api.get("shots", id);
        assert(metadata.device_shot_id === 0 && commands.includes("shotack:0"), "ID zero was dropped or acknowledged under another ID");
        assert(await fixture.metadata(0, { shotCount: 65535 }) === id && adapter.currentTraceDownloadShotId === 0,
          "A stored repeat of ID zero duplicated metadata or skipped its missing trace");
        const acknowledged = commands.filter((command) => command === "shotack:0").length;
        const samples = adapter.sampleCount;
        for (const [protocol, type] of [[3, 7], [0, 1], [1, 99]]) {
          const bytes = new Uint8Array(29); bytes.set([0x4f, 0x46, protocol, type]);
          fixture.notify(bytes);
        }
        assert(adapter.currentTraceDownloadShotId === 0 && adapter.sampleCount === samples
          && adapter.traceLocalShotIds.get(0) === id && commands.filter((command) => command === "shotack:0").length === acknowledged,
          "An unsupported frame changed telemetry or completed ID zero's replay");
        for (const frame of timedFirmwareTraceFrames({ shotId: 0, count: 4 }).frames) fixture.notify(frame);
        await fixture.settleTraces();
        const trace = await api.get("shot_traces", id);
        assert(trace.source === "firmware-timed" && trace.payload.length === 4 && !adapter.traceLocalShotIds.has(0),
          "ID zero's valid replay failed to commit or remained pending");
        assert((await api.getAll("shots")).filter((shot) => shot.device_shot_id === 0).length === 1
          && recorder.store.get().shotCount === 0xffffffff, "Replay duplicated ID zero or lowered the synced full count");
      });
    });

    await check("counter corrections and resets preserve separate new releases under advancing device IDs", async () => {
      await withReconnectRecovery(async (fixture) => {
        const { recorder, commands } = fixture;
        recorder.scheduleBrowserShotTraceCapture = () => {};
        function countSync(value) {
          const bytes = new Uint8Array(29); bytes.set([0x4f, 0x46, 2, 3]);
          const view = new DataView(bytes.buffer);
          view.setUint16(4, value, true); view.setUint16(24, Math.floor(value / 65536), true);
          fixture.notify(bytes);
        }
        const first = await fixture.metadata(70000, { protocol: 2, stored: false, shotCount: 100 });
        const original = JSON.stringify(await api.get("shots", first));
        countSync(10);
        const second = await fixture.metadata(70001, { protocol: 2, stored: false, shotCount: 11 });
        countSync(0);
        const third = await fixture.metadata(70002, { protocol: 2, stored: false, shotCount: 1 });
        assert(new Set([first, second, third]).size === 3 && recorder.store.get().shotCount === 1,
          "A count correction reused a saved capture or changed the new lifetime count");
        const saved = (await api.getAll("shots")).filter((shot) => [70000, 70001, 70002].includes(shot.device_shot_id));
        assert(saved.length === 3 && [70000, 70001, 70002].every((id) => commands.includes(`shotack:${id}`)),
          "Separate releases did not save or acknowledge their independent device IDs");
        assert(await fixture.metadata(70000, { shotCount: 100 }) === first
          && JSON.stringify(await api.get("shots", first)) === original && recorder.store.get().shotCount === 1,
          "An earlier stored upload rewrote a release or undid the reset count");
      });
    });

    await check("re-uploaded stored metadata recovers absent and empty traces under its existing capture id", async () => {
      for (const [index, empty] of [false, true].entries()) {
        const shotId = 41901 + index;
        const id = await deviceRecorder().onShot(deviceShot(shotId));
        if (empty) await api.saveShotTrace({ shot_id: id, source: "browser", payload: [] });
        const metadata = await api.get("shots", id);
        const queued = (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length;
        const recorder = deviceRecorder();
        const recovery = firmwareRecovery(recorder);
        try {
          assert(await recorder.onShot(deviceShot(shotId)) === id, "Re-upload created a different capture");
          assert(recovery.commands.includes(`shotack:${shotId}`) && recovery.commands.includes(`tracereq2:${shotId}`),
            "Duplicate acknowledgement skipped its missing replay");
          assert(JSON.stringify(await api.get("shots", id)) === JSON.stringify(metadata)
            && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === queued,
            "Duplicate metadata rewrote the capture or repeated its upload");
          recovery.feed(shotId); await Promise.all(recovery.saves);
          const trace = await api.get("shot_traces", id);
          assert(trace.source === "firmware" && trace.payload.length === 3 && trace.payload[0].roll === -5,
            "Recovered frames did not attach to the original capture");
          recovery.commands.length = 0;
          const afterRecovery = (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length;
          assert(await recorder.onShot(deviceShot(shotId)) === id, "Completed recovery lost its capture association");
          assert(recovery.commands.join() === `shotack:${shotId}`
            && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === afterRecovery,
            "A completed replay was downloaded or queued again");
        } finally { recovery.close(); await api.removeSavedShots([id]); }
      }
    });

    await check("a stored repeat after a live metadata save requests one missing firmware replay", async () => {
      const shotId = 41903;
      const recorder = deviceRecorder();
      recorder.scheduleBrowserShotTraceCapture = () => {};
      const recovery = firmwareRecovery(recorder);
      let id;
      try {
        id = await recorder.onShot({ ...deviceShot(shotId), stored: false });
        assert(!recovery.commands.some((command) => command.startsWith("tracereq")), "Live metadata requested stored recovery prematurely");
        assert(await recorder.onShot(deviceShot(shotId)) === id && await recorder.onShot(deviceShot(shotId)) === id,
          "Stored repeats did not return the live capture id");
        assert(recovery.commands.filter((command) => command === `tracereq2:${shotId}`).length === 1,
          "Missing replay was skipped or repeated while already downloading");
        assert((await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId).length === 1
          && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === 1,
          "Stored repeats duplicated metadata or its queued upload");
        recovery.feed(shotId); await Promise.all(recovery.saves);
        assert((await api.get("shot_traces", id)).payload.length === 3, "Repeated stored metadata did not recover its recording");
      } finally { recovery.close(); if (id) await api.removeSavedShots([id]); }
    });

    await check("stored metadata with a nonempty browser or firmware replay only re-acknowledges", async () => {
      for (const [index, source] of ["browser", "firmware", "firmware-timed"].entries()) {
        const shotId = 41910 + index;
        const id = await deviceRecorder().onShot(deviceShot(shotId));
        const trace = { shot_id: id, source, payload: [{ roll: 1, pitch: 2, micAmp: 14 }] };
        await api.saveShotTrace(trace);
        const queued = (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length;
        const recorder = deviceRecorder();
        const recovery = firmwareRecovery(recorder);
        try {
          assert(await recorder.onShot(deviceShot(shotId)) === id, "Complete duplicate created another capture");
          assert(recovery.commands.join() === `shotack:${shotId}` && recovery.adapter.currentTraceDownloadShotId === null,
            "Complete replay started another firmware transfer");
          assert(JSON.stringify(await api.get("shot_traces", id)) === JSON.stringify(trace)
            && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === queued,
            "Duplicate changed the replay or queued another upload");
        } finally { recovery.close(); await api.removeSavedShots([id]); }
      }
    });

    await check("a failed saved-trace read still re-acknowledges committed metadata and attempts recovery", async () => {
      const shotId = 41920;
      const id = await deviceRecorder().onShot(deviceShot(shotId));
      const recorder = deviceRecorder();
      const recovery = firmwareRecovery(recorder);
      const logs = [];
      recorder.bus.on("log", (message) => logs.push(message));
      const transaction = captureDb.transaction;
      let fail = true;
      captureDb.transaction = function (...args) {
        if (fail && args[0] === "shot_traces" && args[1] === "readonly") {
          fail = false; throw new Error("Saved trace read unavailable");
        }
        return transaction.apply(this, args);
      };
      try {
        assert(await recorder.onShot(deviceShot(shotId)) === id, "Read failure hid the committed capture");
        assert(recovery.commands.includes(`shotack:${shotId}`) && recovery.commands.includes(`tracereq2:${shotId}`),
          "Read failure prevented acknowledgement or best-effort recovery");
        assert(!logs.some((message) => message.startsWith("Offline save error"))
          && (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId).length === 1,
          "A trace read failure became a metadata write failure or duplicate");
      } finally { captureDb.transaction = transaction; recovery.close(); await api.removeSavedShots([id]); }
    });

    await check("a held duplicate trace lookup cannot acknowledge or start recovery on a replacement connection", async () => {
      const shotId = 41930;
      const id = await deviceRecorder().onShot(deviceShot(shotId));
      const recorder = deviceRecorder();
      recorder.connectionShotIds.set(shotId, id);
      const recovery = firmwareRecovery(recorder);
      const transaction = captureDb.transaction;
      let hold = true, ready, release, saving;
      const readComplete = new Promise((resolve) => { ready = resolve; });
      captureDb.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[0] === "shot_traces" && args[1] === "readonly") {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      try {
        saving = recorder.onShot(deviceShot(shotId));
        // Fail on the baseline's returned id rather than waiting for a missing read.
        const lookedUp = await Promise.race([readComplete.then(() => true), saving.then(() => false)]);
        assert(lookedUp, "Duplicate metadata did not inspect its saved replay");
        recorder.reset(); recorder.connectionShotIds.set(shotId, "replacement-capture");
        release(); release = null;
        assert(await saving === id && recovery.commands.length === 0 && recovery.adapter.currentTraceDownloadShotId === null,
          "Old lookup acknowledged or requested a trace on the replacement connection");
        assert(recorder.connectionShotIds.get(shotId) === "replacement-capture", "Old lookup replaced the new connection's capture association");
      } finally { release?.(); if (saving) await saving; captureDb.transaction = transaction; recovery.close(); await api.removeSavedShots([id]); }
    });

    await check("extended BLE recovery commits all 1000 points under the full shot ID", async () => {
      const recorder = deviceRecorder();
      const adapter = new BleAdapter(recorder.bus);
      adapter.traceProtocol = 2;
      const commands = [];
      adapter.sendControl = async (command) => { commands.push(command); return true; };
      const saves = [];
      recorder.bus.on("trace-chunk", (chunk) => saves.push(recorder.onTraceChunk(chunk)));
      try {
        const shotId = 0xfedcba98;
        const id = await recorder.onShot(deviceShot(shotId));
        const frames = firmwareTraceFrames(shotId).frames;
        const notify = (bytes) => adapter._onValue({ target: { value: new DataView(bytes.buffer) } });
        // Reordering and an identical repeat must still require every unique chunk.
        notify(frames[256]);
        for (const frame of frames.slice(1).reverse()) notify(frame);
        assert(!await api.get("shot_traces", id), "Incomplete recovery was committed");
        notify(frames[0]);
        await Promise.all(saves);
        const saved = await api.get("shot_traces", id);
        assert(commands.includes(`tracereq2:${shotId}`), "Adapter did not request extended recovery");
        assert(saved.source === "firmware" && saved.payload.length === 1000, "Full trace did not survive transfer");
        for (let i = 0; i < 1000; i++) {
          const point = saved.payload[i];
          assert(point.roll === (i - 500) / 100 && point.pitch === (1000 - i) / 100 &&
            point.yaw === (i * 3 - 1500) / 100 && point.micAmp === i % 256, `Point ${i} changed in recovery`);
        }
        assert(recorder.pendingTraces.size === 0, "Completed recovery kept its chunk buffer");
      } finally {
        adapter._stopTraceDownloadTimer();
        adapter.unsubscribeShotSaved();
      }
    });

    await check("timed firmware recovery saves measured motion and audio without downgrading richer recordings", async () => {
      const recorder = deviceRecorder();
      const shotId = 41010;
      const id = await recorder.onShot(deviceShot(shotId));
      const { frames } = timedFirmwareTraceFrames({ shotId });
      for (const frame of frames) await recorder.onTraceChunk(decodeBinaryFrame(frame).trace);
      const saved = await api.get("shot_traces", id);
      assert(saved.source === "firmware-timed" && saved.sample_rate_hz === 88, "Timed provenance or measured rate was lost");
      assert(saved.payload.length === 1000 && saved.payload[0].tUs === -11000000 &&
        saved.payload.at(-1).tUs === 322000, "Recorded duration or release reference changed");
      assert(saved.mic_series[0].tUs === saved.payload[0].tUs && saved.mic_series.at(-1).tUs === 322000,
        "Microphone envelope moved to a different time axis");
      assert((await api.get("shots", id)).shot_score === null, "Timed angles invented a full Float Score");
      await recorder.onTraceChunk(traceChunk(shotId));
      assert((await api.get("shot_traces", id)).source === "firmware-timed", "Legacy recovery discarded recorded timing");
      frames[10][14] ^= 1;
      for (const frame of frames) await recorder.onTraceChunk(decodeBinaryFrame(frame).trace);
      assert((await api.get("shot_traces", id)).payload.at(-1).tUs === 322000, "Checksum failure replaced the saved trace");
      assert(recorder.pendingTraces.size === 0, "Corrupted transfer kept a pending buffer");
      const browser = { shot_id: id, source: "browser", sample_rate_hz: 208, payload: [{ tUs: 0, az: 16 }] };
      await api.saveShotTrace(browser);
      assert(await api.saveShotTrace(saved) === null, "Timed recovery replaced full browser data");
      assert((await api.get("shot_traces", id)).source === "browser", "Richer source did not survive");
    });

    await check("inconsistent and incomplete firmware points never replace a saved trace", async () => {
      const recorder = deviceRecorder();
      const shotId = 41009;
      const id = await recorder.onShot(deviceShot(shotId));
      await api.saveShotTrace({ shot_id: id, source: "firmware", payload: [{ roll: 123 }] });
      const chunk = { ...traceChunk(shotId), totalChunks: 2 };
      await recorder.onTraceChunk(chunk);
      await recorder.onTraceChunk({ ...chunk, payload: new Uint8Array([1, 0, 0, 0, 0, 0, 12]) });
      assert(recorder.pendingTraces.size === 0, "Conflicting duplicate survived");
      await recorder.onTraceChunk(chunk);
      await recorder.onTraceChunk({ ...chunk, chunkIndex: 1, totalChunks: 3 });
      assert(recorder.pendingTraces.size === 0, "Changed chunk count survived");
      await recorder.onTraceChunk({ ...traceChunk(shotId), payload: new Uint8Array(8) });
      assert((await api.get("shot_traces", id)).payload[0].roll === 123, "Invalid bytes overwrote the saved recording");
      assert(recorder.pendingTraces.size === 0, "Failed decode kept its pending buffer");
    });

    await check("device captures wait for their own score instead of inheriting unrelated live telemetry", async () => {
      const keys = ["stability_score", "shot_score", "hold_stability", "release_quality", "follow_through", "level_consistency", "packet_loss_count"];
      for (const stored of [true, false]) {
        const recorder = deviceRecorder();
        recorder.store.set({ formScore: 99, holdStability: 98, releaseQuality: 97, followThrough: 96, levelConsistency: 95 });
        recorder.scheduleBrowserShotTraceCapture = () => {};
        const shotId = stored ? 41006 : 41007;
        const id = await recorder.onShot({ ...deviceShot(shotId), stored });
        const shot = await api.get("shots", id);
        for (const key of keys) assert(shot[key] === null, `${key} was invented from live state or missing event data`);
        assert(shot.yaw_angle_deg === (stored ? null : 12), "Stored capture inherited current live yaw");
        const queued = (await api.getAll("sync_queue")).find((task) => task.table === "shots" && task.targetId === id);
        assert(queued.payload.shot_score === null && recorder.store.get().lastShotSummary.score === null, "Unrelated score entered the queue or latest-capture summary");
        if (stored) {
          await recorder.onTraceChunk(traceChunk(shotId));
          assert((await api.get("shots", id)).shot_score === null, "Angle-only firmware trace invented a full Float Score");
        } else {
          recorder.shotTraceBuffer = Array.from({ length: 100 }, (_, index) => ({
            tUs: index * 20000, ax: 0, ay: 0, az: index === 70 ? 16 : 1, roll: 0, pitch: 0, rotDps: 0, lost: 0,
          }));
          await recorder.saveBrowserShotTrace(id, shotId, 1400000, {}, 50, 600, 0);
          const scored = await api.get("shots", id);
          assert(Number.isFinite(scored.shot_score) && scored.shot_score !== 99, "Capture did not receive its own computed score");
          assert(scored.stability_score === scored.hold_stability && scored.packet_loss_count === 0, "Trace did not fill its measured stability and loss");
        }
      }
    });

    await check("device metadata and upload commit before acknowledgement, with retry after failure", async () => {
      const recorder = deviceRecorder();
      const saved = [];
      recorder.bus.on("shot-saved", (event) => {
        assert(completed.has(latestWrite), "Device acknowledged before the write committed");
        saved.push(event);
      });
      abortNextWrite = "sync_queue";
      await recorder.onShot(deviceShot(41001));
      assert(saved.length === 0 && !recorder.connectionShotIds.has(41001), "Failed save was acknowledged or marked handled");
      assert(!(await api.getAll("shots")).some((shot) => shot.device_shot_id === 41001), "Queue failure left partial device metadata");
      await recorder.onShot(deviceShot(41001));
      assert(saved.length === 1 && saved[0].shotId === 41001, "Successful retry was not acknowledged");
      assert(recorder.connectionShotIds.get(41001) === saved[0].localShotId, "Device id did not map to its saved capture");
    });

    await check("device metadata survives failing logs and views and still reaches the BLE acknowledgement", async () => {
      const recorder = deviceRecorder();
      const shotId = 41701;
      const commands = [];
      recorder.bus.on("log", () => { throw new Error("Simulated device log failure"); });
      recorder.bus.on("shot-saved", () => { throw new Error("Simulated device view failure"); });
      const adapter = new BleAdapter(recorder.bus);
      adapter.traceProtocol = 2;
      adapter.sendControl = async (command) => { commands.push(command); return true; };
      try {
        const id = await recorder.onShot(deviceShot(shotId));
        assert(!!id && !!await api.get("shots", id), "A callback failure hid or prevented the saved metadata");
        assert(commands.includes(`shotack:${shotId}`) && commands.includes(`tracereq2:${shotId}`), "A failed listener blocked the acknowledgement or recovery request");
        assert(recorder.connectionShotIds.get(shotId) === id && recorder.pendingShotSaves.size === 0, "Committed metadata remained pending or lost its device association");
        assert((await api.getPendingSyncTasks()).some((task) => task.targetId === id), "Callback failure lost the metadata upload");
      } finally {
        adapter._stopTraceDownloadTimer();
        adapter.unsubscribeShotSaved();
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        await api.removeSavedShots(shots.map((shot) => shot.id));
      }
    });

    await check("failed device refreshes preserve the saved id and duplicate metadata re-acknowledges without another write", async () => {
      const recorder = deviceRecorder();
      const shotId = 41702;
      const events = [];
      recorder.bus.on("shot-saved", () => { throw new Error("Simulated first device view failure"); });
      recorder.bus.on("shot-saved", async () => { throw new Error("Simulated delayed device view failure"); });
      recorder.bus.on("shot-saved", (event) => events.push(event));
      try {
        const id = await recorder.onShot(deviceShot(shotId));
        assert(!!id && events.length === 1, "View failure hid the committed id or stopped a later listener");
        assert(await recorder.onShot(deviceShot(shotId)) === id, "Duplicate did not return the existing saved capture");
        assert(events.length === 2 && events[1].duplicate && events[1].shotId === shotId, "Duplicate did not re-acknowledge");
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        assert(shots.length === 1 && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === 1, "Callback failure or duplicate repeated the write");
      } finally {
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        await api.removeSavedShots(shots.map((shot) => shot.id));
      }
    });

    await check("BLE metadata keeps its receiving connection through acknowledgement without persisting runtime state", async () => {
      const recorder = deviceRecorder();
      const adapter = new BleAdapter(recorder.bus);
      const shotId = 41704;
      const commands = [];
      const saves = [];
      let received, savedEvent;
      adapter.sendControl = async (command) => {
        assert(completed.has(latestWrite), "BLE callback ran before metadata and upload committed");
        commands.push(command);
        return true;
      };
      recorder.bus.on("shot", (shot) => { received = shot; saves.push(recorder.onShot(shot)); });
      recorder.bus.on("shot-saved", (event) => { savedEvent = event; });
      try {
        const bytes = new Uint8Array(29);
        bytes.set([0x4f, 0x46, 1, 4]);
        const frame = new DataView(bytes.buffer);
        frame.setUint16(4, shotId, true);
        frame.setUint16(6, shotId, true);
        frame.setInt16(12, 16000, true);
        adapter._onValue({ target: { value: frame } });
        const [id] = await Promise.all(saves);
        assert(!!id && commands.includes(`shotack:${shotId}`), "Parsed BLE metadata was not saved and acknowledged");
        assert(received.sourceConnection.token === adapter.connectionToken
          && received.sourceConnection.epoch === adapter.connectionEpoch
          && savedEvent.sourceConnection === received.sourceConnection, "Save notification lost the receiving connection");
        const metadata = await api.get("shots", id);
        const upload = (await api.getPendingSyncTasks()).find((task) => task.targetId === id);
        const exported = await api.exportShotData(id);
        assert(!("sourceConnection" in metadata) && !("sourceConnection" in upload.payload)
          && !("sourceConnection" in exported.shot), "Runtime BLE identity leaked into storage, uploads or export");
      } finally {
        adapter._stopTraceDownloadTimer();
        adapter.unsubscribeShotSaved();
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        await api.removeSavedShots(shots.map((shot) => shot.id));
      }
    });

    await check("device write rollback stays unacknowledged and retryable even when logging fails", async () => {
      const recorder = deviceRecorder();
      const shotId = 41705;
      const events = [];
      let syncCalls = 0;
      recorder.bus.on("log", () => { throw new Error("Simulated rollback log failure"); });
      recorder.bus.on("shot-saved", (event) => events.push(event));
      recorder.syncAdapter = { triggerSync() { syncCalls += 1; } };
      try {
        abortNextWrite = "sync_queue";
        assert(await recorder.onShot(deviceShot(shotId)) === null, "Aborted metadata returned a saved id");
        assert(events.length === 0 && syncCalls === 0 && !recorder.connectionShotIds.has(shotId)
          && recorder.pendingShotSaves.size === 0, "Aborted metadata was acknowledged, uploaded or left pending");
        assert(!(await api.getAll("shots")).some((shot) => shot.device_shot_id === shotId), "Aborted queue left partial metadata");
        const id = await recorder.onShot(deviceShot(shotId));
        assert(!!id && events.length === 1 && syncCalls === 1, "Successful retry did not acknowledge and dispatch its saved capture");
        assert((await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId).length === 1
          && (await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === 1, "Retry duplicated metadata or its upload");
      } finally {
        abortNextWrite = false;
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        await api.removeSavedShots(shots.map((shot) => shot.id));
      }
    });

    await check("delayed device sync rejection preserves the committed id and its queued upload", async () => {
      const recorder = deviceRecorder();
      const shotId = 41706;
      const logs = [];
      let rejectUpload, syncCalls = 0;
      recorder.bus.on("log", (message) => logs.push(message));
      recorder.syncAdapter = { triggerSync() {
        syncCalls += 1;
        return new Promise((_, reject) => { rejectUpload = reject; });
      } };
      try {
        const id = await recorder.onShot(deviceShot(shotId));
        assert(!!id && syncCalls === 1 && !!await api.get("shots", id), "Metadata save waited for or lost its background upload");
        rejectUpload(new Error("Simulated delayed device upload failure"));
        const queued = (await api.getPendingSyncTasks()).filter((task) => task.targetId === id);
        assert(queued.length === 1 && logs.some((message) => message.includes("cloud sync will retry")), "Sync rejection lost the upload or its retry status");
        assert(!logs.some((message) => message.startsWith("Offline save error")), "Sync rejection was reported as a local write failure");
        assert(await recorder.onShot(deviceShot(shotId)) === id && syncCalls === 1, "Duplicate metadata repeated the write or sync dispatch");
      } finally {
        rejectUpload?.(new Error("End device upload fixture"));
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        await api.removeSavedShots(shots.map((shot) => shot.id));
      }
    });

    await check("slow saved-view callbacks do not delay committed metadata or firmware trace recovery", async () => {
      const recorder = deviceRecorder();
      const shotId = 41707;
      let releaseView, beginView, metadataSettled = false;
      const heldView = new Promise((resolve) => { releaseView = resolve; });
      const viewStarted = new Promise((resolve) => { beginView = resolve; });
      recorder.bus.on("shot-saved", () => { beginView(); return heldView; });
      const saving = recorder.onShot(deviceShot(shotId)).then((id) => { metadataSettled = true; return id; });
      try {
        await viewStarted;
        await api.getAll("shots");
        assert(metadataSettled && recorder.pendingShotSaves.size === 0, "A busy view kept committed metadata pending");
        const id = await saving;
        await recorder.onTraceChunk(traceChunk(shotId));
        assert((await api.get("shot_traces", id)).payload[0].micAmp === 12, "A busy view blocked firmware recovery");
      } finally {
        releaseView();
        await saving;
        const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === shotId);
        await api.removeSavedShots(shots.map((shot) => shot.id));
      }
    });

    await check("concurrent device metadata frames save one capture and trace waits for that commit", async () => {
      const recorder = deviceRecorder();
      await Promise.all([recorder.onShot(deviceShot(41002)), recorder.onShot(deviceShot(41002)), recorder.onTraceChunk(traceChunk(41002))]);
      const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === 41002);
      assert(shots.length === 1, "Concurrent frames created duplicate captures");
      assert((await api.get("shot_traces", shots[0].id)).payload[0].micAmp === 12, "Trace did not wait for its metadata");
    });

    await check("re-uploaded firmware traces preserve a saved browser recording and its active review", async () => {
      const recorder = deviceRecorder();
      const shotId = 41008;
      const id = "existing-browser-recording";
      const browser = { shot_id: id, source: "browser", sample_rate_hz: 208, payload: [{ tUs: 0, az: 1 }, { tUs: 4808, az: 16 }] };
      await api.saveCapture({ id, device_id: "OpenFloat-Sensor", device_shot_id: shotId, timestamp: new Date().toISOString(), shot_score: 87 }, browser);
      recorder.store.set({ reviewMode: true, reviewShotId: id, reviewTrace: browser.payload });
      let traceEvents = 0;
      recorder.bus.on("shot-trace-saved", () => traceEvents++);
      await recorder.onShot(deviceShot(shotId));
      await recorder.onTraceChunk(traceChunk(shotId));
      assert((await api.get("shot_traces", id)).source === "browser", "Reconnect replaced the saved browser recording");
      assert(recorder.store.get().reviewTrace === browser.payload, "Ignored firmware upload replaced the active replay");
      assert(traceEvents === 0, "Ignored firmware upload emitted a misleading save event");
    });

    await check("deleted current captures never redirect firmware traces to an older reused device id", async () => {
      const recorder = deviceRecorder();
      await api.put("shots", { id: "older-device-id", device_id: "OpenFloat-Sensor", device_shot_id: 41003, timestamp: "2000-01-01T12:00:00Z" });
      await api.put("shot_traces", { shot_id: "older-device-id", payload: [{ roll: 7 }], source: "original" });
      const id = await recorder.onShot(deviceShot(41003));
      await api.removeSavedShots([id]);
      const recovery = firmwareRecovery(recorder);
      try {
        assert(await recorder.onShot(deviceShot(41003)) === id && recovery.commands.join() === "shotack:41003",
          "Deleted capture was recreated or requested another recording");
        await recorder.onTraceChunk(traceChunk(41003));
        assert(!await api.get("shots", id) && !await api.get("shot_traces", id), "Deleted capture regained metadata or its trace");
        assert((await api.get("shot_traces", "older-device-id")).source === "original", "Trace overwrote an older capture with the same device id");
      } finally { recovery.close(); }
    });

    await check("reconnect during metadata save cannot acknowledge or attach a trace to the new connection", async () => {
      const recorder = deviceRecorder();
      recorder.store.set({ deviceId: "OpenFloat-BLE:sensor-a" });
      const saved = [];
      recorder.bus.on("shot-saved", (event) => saved.push(event));
      const writing = recorder.onShot({ ...deviceShot(41004), yawDeg: 12 });
      const tracing = recorder.onTraceChunk(traceChunk(41004));
      recorder.reset();
      recorder.store.set({ formScore: 99, yaw: 88, deviceId: "OpenFloat-BLE:sensor-b" });
      const newerPending = { chunks: new Map(), totalChunks: 2 };
      recorder.pendingTraces.set(41004, newerPending);
      const [id] = await Promise.all([writing, tracing]);
      assert(saved.length === 1 && saved[0].shotId === null, "An old save acknowledged the new connection");
      assert(recorder.connectionShotIds.size === 0 && recorder.store.get().formScore === 99, "An old save changed the new connection state");
      assert((await api.get("shots", id)).yaw_angle_deg === 12, "Metadata used orientation from the new connection");
      assert((await api.get("shots", id)).device_id === "OpenFloat-BLE:sensor-a", "A delayed save was relabeled with the new sensor");
      assert(!await api.get("shot_traces", id), "Old firmware chunks crossed the connection boundary");
      assert(recorder.pendingTraces.get(41004) === newerPending, "Old completion removed a newer pending trace");
    });

    await check("a delayed browser trace keeps its original samples and loss count across reconnect", async () => {
      const recorder = deviceRecorder();
      const id = "original-browser-trace";
      await api.put("shots", { id, arrow_score: 9 });
      recorder.shotTraceBuffer = [
        { tUs: 100000, ax: 0, ay: 0, az: 1, roll: 1, pitch: 0, micAmp: 10, lost: 3 },
        { tUs: 200000, ax: 0, ay: 0, az: 1, roll: 2, pitch: 0, micAmp: 20, lost: 4 },
      ];
      const context = { epoch: recorder.connectionEpoch, motion: recorder.shotTraceBuffer, mic: recorder.micRingBuffer };
      recorder.reset();
      recorder.lost = 100;
      recorder.store.set({ formScore: 99 });
      await recorder.saveBrowserShotTrace(id, 41005, 150000, {}, 52, 100, 2, context);
      const trace = await api.get("shot_traces", id);
      const shot = await api.get("shots", id);
      assert(trace.payload.map((point) => point.roll).join() === "1,2", "Reconnect changed the captured motion");
      assert(trace.mic_series.map((point) => point.micAmp).join() === "10,20", "Reconnect changed the captured microphone data");
      assert(shot.packet_loss_count === 2 && shot.arrow_score === 9, "Delayed save mixed loss from another connection or lost the arrow result");
      assert(recorder.store.get().formScore === 99, "Old trace replaced live metrics from the new connection");
    });

    await check("a committed browser trace survives failing logs, views and background sync", async () => {
      const recorder = deviceRecorder();
      const id = "browser-trace-notification-recovery";
      await api.put("shots", { id, arrow_score: 9 });
      recorder.shotTraceBuffer = [
        { tUs: 100000, ax: 0, ay: 0, az: 1, roll: 1, pitch: 0, micAmp: 10, lost: 3 },
        { tUs: 200000, ax: 0, ay: 0, az: 16, roll: 2, pitch: 0, micAmp: 20, lost: 4 },
      ];
      recorder.bus.on("log", () => { throw new Error("Simulated trace log failure"); });
      recorder.bus.on("shot-trace-saved", () => { throw new Error("Simulated trace view failure"); });
      let notified = 0;
      recorder.bus.on("shot-trace-saved", () => { notified += 1; });
      recorder.syncAdapter = { triggerSync() { throw new Error("Simulated trace sync failure"); } };
      await recorder.saveBrowserShotTrace(id, 41501, 150000, {}, 52, 100, 2);
      assert((await api.get("shot_traces", id)).payload.length === 2 && (await api.get("shots", id)).arrow_score === 9, "Callback failure changed the committed capture");
      assert(notified === 1, "A failing callback stopped the remaining view listeners");
      assert((await api.getPendingSyncTasks()).some((task) => task.table === "shot_traces" && task.targetId === id), "Callback failure lost the queued trace");
      await api.removeSavedShots([id]);
    });

    await check("firmware assembly cannot be stranded by a failing progress log", async () => {
      const recorder = deviceRecorder();
      const shotId = 41502;
      const id = await recorder.onShot(deviceShot(shotId));
      recorder.bus.on("log", (message) => {
        if (message.startsWith("All trace chunks received")) throw new Error("Simulated assembly log failure");
      });
      let notified = 0;
      recorder.bus.on("shot-trace-saved", () => { notified += 1; });
      await recorder.onTraceChunk(traceChunk(shotId));
      assert((await api.get("shot_traces", id)).payload[0].micAmp === 12, "Progress logging prevented recovery");
      assert(notified === 1 && recorder.pendingTraces.size === 0, "Completed transfer remained stuck or unreported");
      await api.removeSavedShots([id]);
    });

    await check("firmware commit survives failing view listeners and a delayed sync rejection", async () => {
      const recorder = deviceRecorder();
      const shotId = 41504;
      const id = await recorder.onShot(deviceShot(shotId));
      const logs = [];
      let notified = 0, syncBegan, rejectSync, syncLogged;
      const began = new Promise((resolve) => { syncBegan = resolve; });
      const logged = new Promise((resolve) => { syncLogged = resolve; });
      recorder.bus.on("log", (message) => { logs.push(message); if (message.includes("cloud sync will retry")) syncLogged(); });
      recorder.bus.on("shot-trace-saved", () => { throw new Error("Simulated firmware view failure"); });
      recorder.bus.on("shot-trace-saved", async () => { throw new Error("Simulated delayed firmware view failure"); });
      recorder.bus.on("shot-trace-saved", () => {
        assert(completed.has(latestWrite), "View notification ran before trace commit");
        notified += 1;
      });
      recorder.syncAdapter = { triggerSync() { syncBegan(); return new Promise((_resolve, reject) => { rejectSync = reject; }); } };
      const saved = await recorder.onTraceChunk(traceChunk(shotId));
      await began;
      assert(saved === id && notified === 1 && recorder.pendingTraces.size === 0, "View or pending sync hid the committed trace or kept assembly busy");
      rejectSync(new Error("Simulated delayed trace sync failure"));
      await logged;
      assert(!!await api.get("shot_traces", id) && (await api.getPendingSyncTasks()).some((task) => task.table === "shot_traces" && task.targetId === id), "Delayed callback failure lost committed data or its upload");
      assert(logs.some((message) => message.includes("Some views could not refresh")) && !logs.some((message) => message.includes("Firmware trace save failed")), "Post-commit failure was reported as a failed write");
      await api.removeSavedShots([id]);
    });

    await check("a reported trace refresh failure leaves its write committed and offers a view retry", async () => {
      const recorder = deviceRecorder();
      const shotId = 41505;
      const id = await recorder.onShot(deviceShot(shotId));
      const logs = [];
      recorder.bus.on("log", (message) => logs.push(message));
      recorder.bus.on("shot-trace-saved", async () => false);
      assert(await recorder.onTraceChunk(traceChunk(shotId)) === id, "Reported view failure hid the saved id");
      assert(!!await api.get("shot_traces", id) && recorder.pendingTraces.size === 0, "Reported view failure changed the committed trace");
      assert(logs.some((message) => /trace saved locally.*reopen saved shots/i.test(message)), "Reported refresh failure had no view retry guidance");
      await api.removeSavedShots([id]);
    });

    await check("a rolled-back firmware trace can retry without notifications or orphan upload work", async () => {
      const recorder = deviceRecorder();
      const shotId = 41506;
      const id = await recorder.onShot(deviceShot(shotId));
      let notified = 0, syncs = 0;
      recorder.bus.on("log", async () => { throw new Error("Simulated failed trace logger"); });
      recorder.bus.on("shot-trace-saved", () => { notified += 1; });
      recorder.syncAdapter = { triggerSync() { syncs += 1; } };
      abortNextWrite = "sync_queue";
      await recorder.onTraceChunk(traceChunk(shotId));
      assert(!await api.get("shot_traces", id) && recorder.pendingTraces.size === 0, "Rolled-back trace survived or prevented a transfer retry");
      assert(notified === 0 && syncs === 0 && !(await api.getAll("sync_queue")).some((task) => task.table === "shot_traces" && task.targetId === id), "A rolled-back trace notified views or queued an upload");
      assert(await recorder.onTraceChunk(traceChunk(shotId)) === id, "Repeated firmware frames could not retry");
      assert(notified === 1 && syncs === 1 && (await api.get("shot_traces", id)).payload[0].micAmp === 12, "Retry changed data or repeated callbacks");
      await api.removeSavedShots([id]);
    });

    await check("a rolled-back browser trace retains its capture's edits and retries across reconnect", async () => {
      const recorder = deviceRecorder();
      const id = "browser-trace-write-retry";
      await api.put("shots", { id, timestamp: "2001-01-01T12:00:00Z", shot_score: 61, arrow_score: 9 });
      recorder.shotTraceBuffer = [
        { tUs: 100000, ax: 0, ay: 0, az: 1, roll: 1, pitch: 0, micAmp: 10, lost: 3 },
        { tUs: 200000, ax: 0, ay: 0, az: 16, roll: 2, pitch: 0, micAmp: 20, lost: 4 },
      ];
      const context = { epoch: recorder.connectionEpoch, motion: recorder.shotTraceBuffer, mic: recorder.micRingBuffer };
      let notified = 0;
      recorder.bus.on("log", () => { throw new Error("Simulated failed browser trace logger"); });
      recorder.bus.on("shot-trace-saved", () => { notified += 1; });
      abortNextWrite = "sync_queue";
      assert(await recorder.saveBrowserShotTrace(id, 41507, 150000, {}, 52, 100, 2, context) === null, "Rolled-back browser trace was reported as saved");
      assert(!await api.get("shot_traces", id) && notified === 0 && (await api.get("shots", id)).shot_score === 61, "Failed trace changed metadata or notified views");
      recorder.reset();
      recorder.store.set({ formScore: 99 });
      assert(await recorder.saveBrowserShotTrace(id, 41507, 150000, {}, 52, 100, 2, context) === id, "Original samples could not retry after reconnect");
      const saved = await api.get("shots", id);
      const trace = await api.get("shot_traces", id);
      assert(saved.timestamp === "2001-01-01T12:00:00Z" && saved.arrow_score === 9 && saved.packet_loss_count === 2, "Retry changed the capture time, edits or recorded loss");
      assert(trace.payload.map((point) => point.tUs).join() === "-50000,50000" && notified === 1 && recorder.store.get().formScore === 99, "Retry changed sample timing or the new connection's metrics");
      await api.removeSavedShots([id]);
    });

    await check("manual recordings and rolling captures retain demo origin after disconnect", async () => {
      for (const method of ["saveManualRecording", "saveManual30sCapture"]) {
        let savedId;
        const recorder = Object.create(TelemetryStore.prototype);
        const points = Array.from({ length: 12 }, (_, index) => ({
          sample: true, ax: 0, ay: 0, az: 1, roll: 0, pitch: 0, lost: 0,
          tUs: 4000000 + index * 33000, micAmp: index,
        }));
        const bus = new EventBus();
        bus.on("shot-saved", (event) => { savedId = event.localShotId; });
        Object.assign(recorder, {
          bus,
          store: { get() { return { connected: false, statusMode: "" }; }, set() {} },
          manualRecordingBuffer: points, manualRecordingDurationUs: 396000,
          manualRecordingLabel: "Demo provenance check", history30s: points,
          lost: 0, shotTraceRateHz: 52,
        });
        await recorder[method]();
        assert(!!savedId, `${method} did not report a saved capture`);
        const shot = await api.get("shots", savedId);
        const trace = await api.get("shot_traces", savedId);
        assert(shot.sample === true && shot.device_id === "OpenFloat-Demo", `${method} mislabeled synthetic data`);
        assert(shot.capture_kind === "hold", `${method} did not preserve the capture type`);
        assert(trace.sample === true && trace.source === "sample", `${method} lost trace provenance`);
        assert(trace.payload[0].tUs === 0 && trace.payload.at(-1).tUs === 363000, `${method} changed the capture duration`);
        assert(trace.mic_series.at(-1).tUs === 363000, `${method} shifted the microphone timing`);
        assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === savedId), `${method} queued a demo upload`);
      }
    });

    await check("manual recordings and recent holds preserve their original BLE device identity", async () => {
      for (const method of ["saveManualRecording", "saveManual30sCapture"]) {
        const recorder = deviceRecorder(); recorder.store.set({ deviceId: "OpenFloat-BLE:sensor-a" });
        assert(recorder.startManualRecording("Sensor identity"), "Manual recording did not start");
        const points = Array.from({ length: 12 }, (_, index) => ({
          ax: 0, ay: 0, az: 1, roll: 0, pitch: 0, lost: 0,
          tUs: index * 33000, micAmp: index,
        }));
        recorder.manualRecordingBuffer = points; recorder.history30s = points;
        recorder.manualRecordingDurationUs = 396000;
        let id;
        recorder.bus.on("shot-saved", (event) => { id = event.localShotId; });
        if (method === "saveManualRecording") recorder.store.set({ connected: false, deviceId: null });
        const saving = recorder[method]();
        recorder.store.set({ deviceId: "OpenFloat-BLE:sensor-b" });
        await saving;
        assert((await api.get("shots", id)).device_id === "OpenFloat-BLE:sensor-a", `${method} used the replacement sensor`);
        const upload = (await api.getAll("sync_queue")).find((task) => task.table === "shots" && task.targetId === id);
        assert(upload.payload.device_id === "OpenFloat-BLE:sensor-a", `${method} queued a different sensor key`);
      }
    });

    function manualRecorder() {
      return Object.assign(Object.create(TelemetryStore.prototype), {
        bus: new EventBus(),
        store: createStore({ connected: true, manualRecordingActive: true }),
        isRecordingManual: true, isSavingManual: false, lost: 2, manualRecordingStartLost: 1,
        manualRecordingBuffer: Array.from({ length: 5 }, (_, i) => ({ tUs: i * 20000, ax: 0, ay: 0, az: 1, roll: 0, pitch: 0 })),
        manualRecordingDurationUs: 100000, manualRecordingLabel: "Save recovery check",
      });
    }

    await check("a failed manual save keeps the stopped capture available for retry after disconnect", async () => {
      const recorder = manualRecorder();
      const before = (await api.getAll("shots")).length;
      abortNextWrite = "sync_queue";
      assert(await recorder.saveManualRecording() === null, "Failed write was reported as saved");
      assert((await api.getAll("shots")).length === before, "Failed capture partially committed");
      assert(recorder.store.get().manualRecordingActive && recorder.store.get().manualRecordingPaused, "Failed capture cannot be retried");
      assert(!recorder.store.get().manualRecordingSaving && !recorder.isRecordingManual, "Recording was not frozen for retry");
      assert(recorder.manualRecordingBuffer.length === 5, "Failed capture lost its samples");
      recorder.store.set({ connected: false });
      recorder.lost = 99;
      const id = await recorder.saveManualRecording();
      const saved = await api.get("shots", id);
      assert(saved.packet_loss_count === 1, "Retry included loss after the recording stopped");
      assert(saved.timestamp === recorder.manualRecordingStoppedAt, "Retry shifted the capture time");
      assert((await api.get("shot_traces", id)).payload.length === 5, "Retry changed the recorded samples");
      assert(!recorder.store.get().manualRecordingActive && recorder.manualRecordingBuffer.length === 0, "Committed capture remained unsaved");
    });

    await check("a pending manual save prevents duplicates and cannot be discarded or replaced", async () => {
      const recorder = manualRecorder();
      const before = (await api.getAll("shots")).length;
      const first = recorder.saveManualRecording();
      assert(recorder.store.get().manualRecordingSaving, "Pending save was not exposed to controls");
      assert(recorder.discardManualRecording() === false, "Discard erased a pending save");
      assert(recorder.startManualRecording("Replacement") === false, "A new capture replaced the pending one");
      const second = recorder.saveManualRecording();
      const [id, duplicate] = await Promise.all([first, second]);
      assert(id && duplicate === null, "Concurrent stop created two saves");
      assert((await api.getAll("shots")).length === before + 1, "Pending capture saved more than once");
    });

    await check("manual save logging failures cannot strand a capture or hide its commit", async () => {
      const recorder = manualRecorder();
      const before = (await api.getAll("shots")).length;
      recorder.bus.on("log", () => { throw new Error("Simulated log failure"); });
      const id = await recorder.saveManualRecording();
      assert(!!id && !!await api.get("shot_traces", id), "Logging prevented a complete save");
      assert((await api.getAll("shots")).length === before + 1, "Logging changed the number of committed captures");
      assert(!recorder.isSavingManual && !recorder.store.get().manualRecordingActive, "Logging left the recording busy or unsaved");
    });

    await check("manual saves notify every listener and report view failures after commit", async () => {
      const recorder = manualRecorder();
      let notified = 0;
      recorder.bus.on("shot-saved", () => { throw new Error("Simulated view failure"); });
      recorder.bus.on("shot-saved", async () => { throw new Error("Simulated delayed view failure"); });
      recorder.bus.on("shot-saved", () => { notified += 1; });
      const id = await recorder.saveManualRecording();
      assert(!!id && notified === 1, "A failed view stopped later listeners or hid the committed id");
      assert(!!await api.get("shots", id) && !!await api.get("shot_traces", id), "View failure changed the committed capture");
      assert(!recorder.store.get().manualRecordingActive && !recorder.isSavingManual, "A saved capture became retryable");
      assert(/saved locally/i.test(recorder.store.get().manualRecordMessage) && /reopen saved shots/i.test(recorder.store.get().manualRecordMessage), "View failure was shown as a storage failure or omitted");
    });

    await check("manual controls stay locked while committed views refresh without an unsaved warning", async () => {
      const recorder = manualRecorder();
      let release;
      let began;
      const refreshing = new Promise((resolve) => { began = resolve; });
      recorder.bus.on("shot-saved", () => { began(); return new Promise((resolve) => { release = resolve; }); });
      const saving = recorder.saveManualRecording();
      try {
        await refreshing;
        assert(recorder.store.get().manualRecordingSaving && recorder.isSavingManual, "Controls unlocked before the saved views finished");
        assert(!recorder.store.get().manualRecordingActive && recorder.manualRecordingBuffer.length === 0, "Committed capture still triggers an unsaved warning");
        assert(recorder.discardManualRecording() === false && recorder.startManualRecording("Replacement") === false, "Refresh allowed discard or replacement");
        assert(recorder.reset() === false, "Refresh allowed a transport reset");
        assert(await recorder.saveManualRecording() === null, "Refresh allowed duplicate submission");
        recorder.store.set({ connected: false });
      } finally {
        release?.();
        await saving;
      }
      assert(!recorder.isSavingManual && !recorder.store.get().manualRecordingSaving, "Refresh completion left controls busy");
    });

    await check("a synchronous sync failure cannot reject an already committed manual capture", async () => {
      const recorder = manualRecorder();
      recorder.syncAdapter = { triggerSync() { throw new Error("Simulated sync dispatch failure"); } };
      const id = await recorder.saveManualRecording();
      assert(!!id && !!await api.get("shots", id), "Sync dispatch hid the local save");
      assert(!recorder.store.get().manualRecordingActive && !recorder.isSavingManual, "Sync failure changed the local save state");
      assert((await api.getPendingSyncTasks()).some((task) => task.targetId === id), "Sync failure lost the queued upload");
    });

    await check("a failed manual write stays retryable even when logging also fails", async () => {
      const recorder = manualRecorder();
      const before = (await api.getAll("shots")).length;
      let notified = 0;
      recorder.bus.on("log", async () => { throw new Error("Simulated failed logger"); });
      recorder.bus.on("shot-saved", () => { notified += 1; });
      abortNextWrite = "sync_queue";
      assert(await recorder.saveManualRecording() === null, "A rolled-back write was reported as saved");
      const stoppedAt = recorder.manualRecordingStoppedAt;
      assert((await api.getAll("shots")).length === before && notified === 0, "Failed write committed or notified views");
      assert(!recorder.isSavingManual && recorder.store.get().manualRecordingActive && recorder.store.get().manualRecordingPaused, "Failed logger disabled retry");
      assert(/press save to retry/i.test(recorder.store.get().manualRecordMessage), "Retry message was hidden by logging");
      recorder.lost = 99;
      recorder.store.set({ connected: false });
      const id = await recorder.saveManualRecording();
      const saved = await api.get("shots", id);
      assert(saved.timestamp === stoppedAt && saved.packet_loss_count === 1, "Retry changed the frozen timestamp or loss");
      assert(notified === 1 && (await api.getAll("shots")).length === before + 1, "Retry produced extra writes or notifications");
    });

    await check("a manual view's reported failure keeps the save committed and shows a refresh retry", async () => {
      const recorder = manualRecorder();
      recorder.bus.on("shot-saved", async () => false);
      const id = await recorder.saveManualRecording();
      assert(!!await api.get("shots", id) && recorder.manualRecordingBuffer.length === 0, "Reported view failure restored an unsaved capture");
      assert(!recorder.store.get().manualRecordingActive && !recorder.store.get().manualRecordingSaving, "Reported view failure left controls pending");
      assert(/reopen saved shots/i.test(recorder.store.get().manualRecordMessage), "Reported view failure was ignored");
    });

    await check("background sync failure cannot block or overwrite the next manual recording", async () => {
      const recorder = manualRecorder();
      let rejectSync;
      let syncBegan;
      let failureLogged;
      const began = new Promise((resolve) => { syncBegan = resolve; });
      const logged = new Promise((resolve) => { failureLogged = resolve; });
      recorder.bus.on("log", (message) => { if (message.includes("cloud sync will retry")) failureLogged(); });
      recorder.syncAdapter = { triggerSync() {
        syncBegan();
        return new Promise((_resolve, reject) => { rejectSync = reject; });
      } };
      const id = await recorder.saveManualRecording();
      await began;
      assert(!!id && !recorder.isSavingManual, "Background sync held the recording controls");
      assert(recorder.startManualRecording("Next hold"), "A pending upload blocked the next recording");
      rejectSync(new Error("Simulated delayed sync failure"));
      await logged;
      assert(recorder.manualRecordingLabel === "Next hold" && recorder.isRecordingManual, "Old sync failure changed the next recording");
      assert(/^Recording\./.test(recorder.store.get().manualRecordMessage), "Old sync failure replaced the next recording's message");
      assert((await api.getPendingSyncTasks()).some((task) => task.targetId === id), "Delayed sync failure lost the queued upload");
      recorder.discardManualRecording();
    });

    await check("unlocking a completed manual save preserves a new recording started by a subscriber", async () => {
      const recorder = manualRecorder();
      let started = false;
      let refreshed = false;
      let unlockedAfterRefresh = false;
      recorder.bus.on("shot-saved", async () => { await Promise.resolve(); refreshed = true; });
      const unsubscribe = recorder.store.subscribe((state) => {
        if (started || state.manualRecordingActive || state.manualRecordingSaving) return;
        started = true;
        unlockedAfterRefresh = refreshed;
        recorder.startManualRecording("Next capture after refresh");
        recorder.manualRecordingBuffer.push({ tUs: 10000, ax: 0, ay: 0, az: 1, roll: 0, pitch: 0 });
      });
      try {
        const id = await recorder.saveManualRecording();
        assert(!!await api.get("shots", id), "Original recording did not commit");
        assert(started && unlockedAfterRefresh, "Recording unlocked before refresh finished");
        assert(recorder.isRecordingManual && recorder.store.get().manualRecordingActive && recorder.manualRecordingBuffer.length === 1, "Old save erased the next capture");
        assert(recorder.manualRecordingLabel === "Next capture after refresh" && recorder.manualRecordingStoppedAt === null, "Old save changed the next capture's metadata");
        assert(/^Recording\./.test(recorder.store.get().manualRecordMessage), "Old completion replaced the next recording's message");
      } finally {
        unsubscribe();
        recorder.discardManualRecording();
      }
    });

    const { CloudSyncAdapter } = await import("../app/telemetry/sync.js?v=shot-store-176");
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

    await check("the uploader skips captures deleted while an earlier upload is in flight", async () => {
      await api.put("sync_queue", taskFor("upload-blocker"));
      await api.put("shots", { id: "delete-before-upload" });
      await api.put("sync_queue", taskFor("delete-before-upload"));
      const uploaded = [];
      await adapter.processQueue({ from() { return { async upsert(payload) {
        uploaded.push(payload.id);
        if (payload.id === "upload-blocker") await api.removeSavedShots(["delete-before-upload"]);
        return { error: null };
      } }; } });
      assert(uploaded.includes("upload-blocker") && !uploaded.includes("delete-before-upload"), "A stale queue snapshot uploaded the deleted capture");
      assert(!await api.get("shots", "delete-before-upload"), "Queue processing recreated the deleted capture");
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

    await check("single and bulk deletion refresh scorecards, review state and recent captures", async () => {
      const ids = ["ui-delete-a", "ui-delete-b", "ui-delete-c"];
      for (const [index, id] of ids.entries()) {
        await api.put("shots", {
          id, timestamp: new Date(Date.parse("2099-01-01T12:00:00Z") + index * 10000).toISOString(),
          capture_kind: "arrow", shot_score: [90, 50, 70][index], arrow_score: [10, 8, 6][index],
        });
      }
      await api.put("session_overrides", { id: ids[0], name: "UI deletion practice", arrows_per_end: 6 });
      // Use the real markup and handlers, with fixtures in this page's isolated
      // database. Dialog stubs exist only during this check, never in the app.
      const markup = new DOMParser().parseFromString(await (await fetch("../index.html", { cache: "no-store" })).text(), "text/html");
      const fixture = document.createElement("div");
      fixture.hidden = true;
      fixture.append(markup.querySelector("main"));
      document.body.append(fixture);
      const el = Object.fromEntries([...fixture.querySelectorAll("[id]")].map((node) => [node.id, node]));
      const originalConfirm = window.confirm;
      const originalAlert = window.alert;
      window.confirm = () => true;
      window.alert = (message) => { throw new Error(message); };
      try {
        const { initHistory } = await import("../app/ui/history.js?v=shot-store-183");
        const store = createStore({ reviewMode: true, reviewShotId: ids[0], compareShotId: ids[1], replayActive: true });
        const ui = initHistory({ bus: new EventBus(), store, el, selectViewTab() {} });
        await Promise.all([ui.loadShotHistoryList(), ui.loadRecentShotsList()]);
        await ui.deleteSavedShot(ids[0]);
        const session = el.historyList.querySelector('[data-session-id="ui-delete-b"]');
        assert(session?.querySelector(".session-location").textContent === "UI deletion practice", "Session name disappeared after anchor deletion");
        assert(!session.classList.contains("collapsed"), "Deleting an anchor collapsed the open session");
        assert(session.querySelectorAll(".badge-val")[1].textContent === "60", "Average float score did not refresh");
        assert(session.querySelector(".scorecard-head p").textContent.includes("14 points"), "Arrow total did not refresh");
        assert(session.querySelector(".session-end-size").value === "6", "End size was lost");
        assert(!el.recentShotsList.querySelector('[data-shot-id="ui-delete-a"]'), "Deleted capture remained in recent cards");
        assert(!store.get().reviewMode && !store.get().replayActive && !store.get().compareShotId, "Deleted capture stayed in review or comparison");
        el.historySelectModeBtn.click();
        for (const id of ids.slice(1)) el.historyList.querySelector(`input[data-shot-id="${id}"]`).click();
        const completed = new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (el.historyBulkActions.classList.contains("hidden") && !el.historyList.querySelector('[data-shot-id="ui-delete-b"]')) {
              clearTimeout(timeout);
              observer.disconnect();
              resolve();
            }
          });
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Bulk deletion did not finish refreshing")); }, 5000);
          observer.observe(fixture, { subtree: true, childList: true, attributes: true });
        });
        el.bulkDeleteBtn.click();
        await completed;
        for (const id of ids) {
          assert(!el.historyList.querySelector(`[data-shot-id="${id}"]`), "Bulk-deleted capture stayed in history");
          assert(!el.recentShotsList.querySelector(`[data-shot-id="${id}"]`), "Bulk-deleted capture stayed in recent cards");
        }
        assert(el.historyExportStatus.textContent.includes("Deleted 2 captures"), "Bulk deletion was not announced");
      } finally {
        window.confirm = originalConfirm;
        window.alert = originalAlert;
        fixture.remove();
      }
    });
    const historyMarkup = new DOMParser().parseFromString(await (await fetch("../index.html", { cache: "no-store" })).text(), "text/html");
    const { initHistory } = await import("../app/ui/history.js?v=shot-store-183");
    const { sensorConnectionProblem, mountBrowserSupport } = await import("../app/ui/browser-support.js?v=shot-store-178");
    async function withBrowserNotice(run, options = {}) {
      const fixture = document.createElement("div");
      fixture.style.cssText = "position:absolute;left:-10000px;width:1000px";
      fixture.append(historyMarkup.querySelector("#mobileAlertBanner").cloneNode(true), historyMarkup.querySelector("#statusBadge").cloneNode(true));
      document.body.append(fixture);
      const el = Object.fromEntries([...fixture.querySelectorAll("[id]")].map((node) => [node.id, node]));
      try { await run({ el, ui: mountBrowserSupport({ el, ...options }) }); }
      finally { fixture.remove(); }
    }
    await check("browser notices explain unsupported, insecure and policy-blocked sensor access", async () => {
      const capable = { bluetooth: { requestDevice() { throw new Error("A support check opened a picker"); } } };
      for (const [environment, expected] of [
        [{ navigator: {}, secureContext: true }, "does not provide Web Bluetooth"],
        [{ navigator: { platform: "MacIntel", maxTouchPoints: 5 }, secureContext: true }, "iPhone or iPad"],
        [{ navigator: capable, secureContext: false }, "secure page"],
        [{ navigator: capable, secureContext: true, policy: { allowsFeature: () => false } }, "permissions policy blocks"],
      ]) await withBrowserNotice(async ({ el, ui }) => {
        assert(!ui.check() && !el.mobileAlertBanner.classList.contains("hidden"), "Unavailable connection had no visible help");
        assert(el.mobileAlertText.textContent.includes(expected) && el.mobileAlertText.textContent.includes("Saved Shots"), "Notice omitted its reason or local tools");
        assert(el.mobileAlertText.getAttribute("role") === "status" && el.statusBadge.getAttribute("aria-describedby") === "mobileAlertText", "Sensor help was not described to assistive technology");
      }, { readProblem: () => sensorConnectionProblem({ policy: null, ...environment }) });
      await withBrowserNotice(async ({ el, ui }) => {
        assert(ui.check() && el.mobileAlertBanner.classList.contains("hidden") && !el.statusBadge.hasAttribute("aria-describedby"), "Capable browser received an unsupported warning");
      }, { readProblem: () => sensorConnectionProblem({ navigator: capable, secureContext: true, policy: null }) });
    });
    await check("dismissed browser help reopens on a connection attempt and preserves keyboard focus", async () => {
      let helpCalls = 0;
      await withBrowserNotice(async ({ el, ui }) => {
        el.closeMobileAlertBtn.focus();
        el.closeMobileAlertBtn.click();
        assert(el.mobileAlertBanner.classList.contains("hidden") && document.activeElement === el.statusBadge, "Dismissal stranded focus in a hidden notice");
        assert(!ui.check({ focus: true }) && document.activeElement === el.browserSupportHelpLink && !el.mobileAlertBanner.classList.contains("hidden"), "Connection attempt did not reopen and focus browser help");
        el.browserSupportHelpLink.click();
        el.browserSupportHelpLink.click();
        assert(helpCalls === 2, "Same-section help activation was ignored");
        assert(el.browserSupportHelpLink.getAttribute("href") === "#/guide/quick-start#browser-compatibility", "Help did not target the documented browser section");
      }, { readProblem: () => "This browser cannot connect. Demo and Saved Shots still work.", onHelp: () => { helpCalls++; } });
    });
    async function withHistoryUI(run, options = {}) {
      const fixture = document.createElement("div");
      fixture.style.cssText = "position:absolute;left:-10000px;width:1000px";
      fixture.append(historyMarkup.querySelector("main").cloneNode(true));
      document.body.append(fixture);
      const el = Object.fromEntries([...fixture.querySelectorAll("[id]")].map((node) => [node.id, node]));
      const bus = new EventBus();
      const store = createStore({ reviewMode: false });
      // Retain the actual async control handlers so checks can await operations
      // whose transaction completion is deliberately held. Rows are constructed
      // before insertion, so invocation checks ownership. Native listeners stay
      // attached and normal click behavior is retained for every control.
      const saveHandlers = new WeakMap();
      const listen = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, handler, options) {
        if (type === "click" && this instanceof Element && this.matches(".session-save-btn,#saveOutcomeBtn,#saveNextOutcomeBtn,#clearOutcomeBtn,#bulkExportBtn")) saveHandlers.set(this, handler);
        return listen.call(this, type, handler, options);
      };
      const getPreference = Storage.prototype.getItem;
      const setPreference = Storage.prototype.setItem;
      let outcomePreference = null;
      Storage.prototype.getItem = function (key) {
        return key === "openfloat_last_target_context" ? outcomePreference : getPreference.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === "openfloat_last_target_context") outcomePreference = String(value);
        else setPreference.call(this, key, value);
      };
      const publish = (type, payload) => Promise.all([...bus.handlers.get(type)].map((handler) => handler(payload)));
      const saveSession = (row) => {
        const button = row.querySelector(".session-save-btn");
        assert(fixture.contains(button), "Session control belongs to another fixture");
        return saveHandlers.get(button)(new MouseEvent("click"));
      };
      const saveOutcome = ({ advance = false, clear = false } = {}) => {
        const button = el[clear ? "clearOutcomeBtn" : advance ? "saveNextOutcomeBtn" : "saveOutcomeBtn"];
        assert(fixture.contains(button), "Outcome control belongs to another fixture");
        return saveHandlers.get(button)(new MouseEvent("click"));
      };
      const exportSelected = () => saveHandlers.get(el.bulkExportBtn)(new MouseEvent("click"));
      try {
        const ui = initHistory({ bus, store, el, selectViewTab() {}, ...options });
        await run({ ui, bus, store, el, publish, saveSession, saveOutcome, exportSelected });
      }
      finally {
        EventTarget.prototype.addEventListener = listen;
        Storage.prototype.getItem = getPreference;
        Storage.prototype.setItem = setPreference;
        fixture.remove();
      }
    }

    // Override reads in this test page's realm without changing user settings.
    async function withActiveBow(id, run) {
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        return key === "openfloat_active_bow_id" ? id : getItem.call(this, key);
      };
      try { await run(); } finally { Storage.prototype.getItem = getItem; }
    }
    const rangeTrace = (id) => ({ shot_id: id, source: "browser", sample_rate_hz: 10,
      payload: Array.from({ length: 12 }, (_, index) => ({
        tUs: (index - 1) * 100000, ax: 0, ay: 0, az: 1, micAmp: index === 8 ? 40 : 0,
      })),
    });
    await check("shot range uses the session's assigned bow rather than today's active bow", () => withHistoryUI(async ({ ui, store }) => {
      const shot = { id: "range-session-bow", capture_kind: "arrow", timestamp: "2101-01-01T12:00:00Z" };
      await api.put("bow_profiles", { id: "range-session-profile", arrow_speed: 240 });
      await api.put("bow_profiles", { id: "range-active-profile", arrow_speed: 400 });
      await api.put("session_overrides", { id: shot.id, bow_profile_id: "range-session-profile" });
      await api.saveCapture(shot, rangeTrace(shot.id));
      await withActiveBow("range-active-profile", () => ui.reviewShotTrace(shot));
      assert(store.get().reviewRangeEst.includes("@ 240 fps"), "Range used a different bow's arrow speed");
      await api.remove("bow_profiles", "range-session-profile");
      await withActiveBow("range-active-profile", () => ui.reviewShotTrace(shot));
      assert(store.get().reviewRangeEst.includes("@ 280 fps (assumed)"), "A missing assigned bow was replaced with an unrelated active bow");
    }));
    await check("invalid bow speed cannot turn the review range into NaN", () => withHistoryUI(async ({ ui, store }) => {
      const shot = { id: "range-invalid-speed", capture_kind: "arrow", timestamp: "2101-01-02T12:00:00Z" };
      await api.put("bow_profiles", { id: "range-invalid-profile", arrow_speed: "bad" });
      await api.saveCapture(shot, rangeTrace(shot.id));
      await withActiveBow("range-invalid-profile", () => ui.reviewShotTrace(shot));
      const range = store.get().reviewRangeEst;
      assert(range && !range.includes("NaN") && range.includes("assumed"), "Unknown speed was presented as a measured or invalid range");
    }));
    await check("shot range reads the impact onset from the full-rate saved microphone series", () => withHistoryUI(async ({ ui, store, publish }) => {
      const shot = { id: "range-full-mic", capture_kind: "arrow", timestamp: "2101-01-03T12:00:00Z" };
      const trace = rangeTrace(shot.id);
      trace.payload.forEach((point) => { point.micAmp = 0; });
      trace.mic_series = [
        { tUs: 200000, micAmp: 0 }, { tUs: 659000, micAmp: 0 },
        { tUs: 660000, micAmp: 18 }, { tUs: 661000, micAmp: 40 }, { tUs: 662000, micAmp: 0 },
      ];
      await api.saveCapture(shot, trace);
      await withActiveBow(null, () => ui.reviewShotTrace(shot));
      assert(store.get().reviewHitTimeMs === 659 && store.get().reviewRangeEst,
        "The full-rate impact was missed or rounded to a motion sample");
      trace.mic_series = trace.mic_series.map((point) => ({ ...point, tUs: point.tUs + 100000 }));
      await api.saveShotTrace(trace);
      await withActiveBow(null, () => publish("shot-trace-saved", { localShotId: shot.id }));
      assert(store.get().reviewHitTimeMs === 759 && store.get().reviewRangeEst.includes("assumed"),
        "A late microphone trace kept the previous impact timing or speed provenance");
    }));
    await api.removeSavedShots(["range-session-bow", "range-invalid-speed", "range-full-mic"]);
    await Promise.all(["range-session-profile", "range-active-profile", "range-invalid-profile"]
      .map((id) => api.remove("bow_profiles", id)));

    const uiShots = Array.from({ length: 6 }, (_, index) => ({
      id: `ui-refresh-${index}`, timestamp: new Date(Date.parse("2098-01-01T12:00:00Z") + index * 10000).toISOString(),
      capture_kind: "arrow", shot_score: (index + 1) * 10, sample: true,
    }));
    const uiTrace = (id) => ({ shot_id: id, sample_rate_hz: 2, payload: [{ tUs: 0, az: 1 }, { tUs: 500000, az: 16 }] });
    for (const shot of uiShots) await api.saveCapture(shot, uiTrace(shot.id));

    await check("renaming a session preserves its unavailable historical bow assignment", () => withHistoryUI(async ({ ui, el }) => {
      await api.put("session_overrides", { id: "ui-refresh-0", name: "Original practice", bow_profile_id: "removed-session-bow" });
      await ui.loadShotHistoryList();
      const session = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      session.querySelector(".session-edit-btn").click();
      session.querySelector(".session-name-input").value = "Renamed practice";
      const refreshed = new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (el.historyList.querySelector('[data-session-id="ui-refresh-0"] .session-location')?.textContent === "Renamed practice") {
            clearTimeout(timeout); observer.disconnect(); resolve();
          }
        });
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Session rename did not finish")); }, 5000);
        observer.observe(el.historyList, { childList: true, subtree: true });
      });
      session.querySelector(".session-save-btn").click();
      await refreshed;
      assert((await api.get("session_overrides", "ui-refresh-0")).bow_profile_id === "removed-session-bow", "Renaming cleared the historical bow assignment");
      await api.remove("session_overrides", "ui-refresh-0");
    }));

    await check("a history refresh keeps pending session edits locked until their save completes", () => withHistoryUI(async ({ ui, el }) => {
      await ui.loadShotHistoryList();
      const session = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      session.querySelector(".session-edit-btn").click();
      session.querySelector(".session-name-input").value = "Pending practice";
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      const connection = await historyDb.initDb();
      const transaction = connection.transaction;
      let release, ready;
      let hold = true;
      const committed = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        const stores = Array.isArray(args[0]) ? args[0] : [args[0]];
        if (hold && stores.includes("session_overrides") && args[1] === "readwrite") {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      try {
        session.querySelector(".session-save-btn").click();
        await committed;
        await ui.loadShotHistoryList();
        const current = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
        assert(current.querySelector(".session-save-btn").disabled && current.querySelector(".session-name-input").disabled
          && current.querySelector(".session-end-size").disabled, "A refreshed session permits conflicting edits while its save is pending");
      } finally {
        connection.transaction = transaction;
        release?.();
        await Promise.resolve();
        await ui.loadShotHistoryList();
        await waitForDOM(el.historyList, () => {
          const current = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
          return !current?.querySelector(".session-save-btn").disabled && current?.querySelector(".session-editor").classList.contains("hidden");
        }, "A committed session save did not unlock and close its refreshed editor");
      }
    }));

    await check("failed history reads keep an open session draft and can be retried", () => withHistoryUI(async ({ ui, el }) => {
      await ui.loadShotHistoryList();
      const session = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      session.querySelector(".session-edit-btn").click();
      const name = session.querySelector(".session-name-input");
      name.value = "Keep this draft";
      name.focus();
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      const connection = await historyDb.initDb();
      const transaction = connection.transaction;
      let fail = true;
      connection.transaction = function (...args) {
        if (fail && args[0] === "shots" && args[1] === "readonly") { fail = false; throw new Error("History read unavailable"); }
        return transaction.apply(this, args);
      };
      try {
        await ui.loadShotHistoryList();
        assert(el.historyList.contains(name) && name.value === "Keep this draft" && document.activeElement === name,
          "A failed history refresh discarded the session draft or focus");
        assert(el.historyList.textContent.includes("History read unavailable"), "Read failure was not announced");
      } finally { connection.transaction = transaction; }
      await ui.loadShotHistoryList();
      const current = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      assert(current.querySelector(".session-name-input").value === "Keep this draft", "Retry discarded the preserved draft");
      assert(!el.historyList.textContent.includes("History read unavailable"), "Successful retry kept the old error");
    }));

    await check("concurrent session patches preserve the latest name, bow, end size and unknown metadata", async () => {
      await api.put("shots", { id: "atomic-session-a", timestamp: "2070-01-01T12:00:00Z" });
      await api.put("shots", { id: "atomic-session-b", timestamp: "2070-01-01T12:10:00Z" });
      await api.put("session_overrides", { id: "atomic-session-a", name: "Original", bow_profile_id: "historical-bow", arrows_per_end: 3, note: "Retain metadata" });
      const before = (await api.getAll("sync_queue")).length;
      await Promise.all([
        api.saveSessionOverride("atomic-session-a", { name: "  Concurrent practice  " }),
        api.saveSessionOverride("atomic-session-a", { arrows_per_end: 6 }),
      ]);
      assert(completed.has(latestWrite), "Session edit resolved before commit");
      const saved = await api.get("session_overrides", "atomic-session-a");
      assert(saved.name === "Concurrent practice" && saved.arrows_per_end === 6 && saved.bow_profile_id === "historical-bow"
        && saved.note === "Retain metadata", "Concurrent patches lost session fields");
      assert((await api.getAll("sync_queue")).length === before, "Local display groups created cloud-session uploads");
    });

    await check("session patches roll back fully and cannot create overrides for deleted captures", async () => {
      const original = await api.get("session_overrides", "atomic-session-a");
      abortNextWrite = "session_overrides";
      await rejects(() => api.saveSessionOverride("atomic-session-a", { name: "Aborted", bow_profile_id: null }));
      assert(JSON.stringify(await api.get("session_overrides", "atomic-session-a")) === JSON.stringify(original), "An aborted session patch changed saved settings");
      await rejects(() => api.saveSessionOverride("missing-session-anchor", { name: "Missing" }));
      assert(!await api.get("session_overrides", "missing-session-anchor"), "A deleted session acquired an orphan override");
    });

    await check("a session editor follows an older capture becoming the group's new anchor", async () => {
      await api.put("shots", { id: "atomic-session-earlier", timestamp: "2070-01-01T11:55:00Z" });
      const records = await api.saveSessionOverride("atomic-session-a", { name: "Moved practice" }, { shotIds: ["atomic-session-a", "atomic-session-b"] });
      assert(records.length === 1 && records[0].id === "atomic-session-earlier", "Edit stayed on the obsolete anchor");
      const saved = await api.get("session_overrides", "atomic-session-earlier");
      assert(saved.name === "Moved practice" && saved.arrows_per_end === 6 && saved.bow_profile_id === "historical-bow"
        && saved.note === "Retain metadata", "Moving an edited session lost its other settings");
    });

    await check("session edits follow surviving split groups and never recreate a removed anchor", async () => {
      const ids = ["split-edit-a", "split-edit-bridge", "split-edit-c"];
      for (const [index, id] of ids.entries()) await api.put("shots", { id,
        timestamp: new Date(Date.parse("2071-01-01T12:00:00Z") + index * 25 * 60000).toISOString() });
      await api.put("session_overrides", { id: ids[0], name: "Split practice", arrows_per_end: 6, bow_profile_id: "historical-bow" });
      await api.removeSavedShots([ids[1]]);
      abortNextWrite = "session_overrides";
      await rejects(() => api.saveSessionOverride(ids[0], { name: "Aborted split edit" }, { shotIds: ids }));
      assert((await api.get("session_overrides", ids[0])).name === "Split practice"
        && (await api.get("session_overrides", ids[2])).name === "Split practice", "A failed split edit changed only part of the session");
      const split = await api.saveSessionOverride(ids[0], { name: "Edited split practice" }, { shotIds: ids });
      assert(split.length === 2 && split.every((record) => record.name === "Edited split practice" && record.arrows_per_end === 6), "Split edit lost a surviving group or end size");
      await api.removeSavedShots([ids[0]]);
      const remaining = await api.saveSessionOverride(ids[0], { bow_profile_id: null }, { shotIds: ids });
      assert(remaining.length === 1 && remaining[0].id === ids[2] && remaining[0].name === "Edited split practice", "Deleted anchor prevented an edit reaching the surviving group");
      assert(!await api.get("session_overrides", ids[0]), "Editing recreated the deleted anchor");
      await api.removeSavedShots([ids[2]]);
      await rejects(() => api.saveSessionOverride(ids[0], { name: "Gone" }, { shotIds: ids }));
      assert(!await api.get("session_overrides", ids[2]), "Deleting the whole session left a new override");
    });

    await check("session write failures keep the draft and a successful retry closes the editor", () => withHistoryUI(async ({ ui, el }) => {
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      observeTransactions(await historyDb.initDb());
      await ui.loadShotHistoryList();
      const current = () => el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      current().querySelector(".session-edit-btn").click();
      current().querySelector(".session-name-input").value = "Retry session";
      const before = await api.get("session_overrides", "ui-refresh-0");
      abortNextWrite = "session_overrides";
      current().querySelector(".session-save-btn").click();
      assert(current().querySelector(".session-save-btn").disabled && current().querySelector(".session-cancel-btn").disabled, "Pending save permits conflicting edits");
      await waitForDOM(el.historyList, () => current().querySelector(".session-edit-status").textContent.startsWith("Could not save session")
        && !current().querySelector(".session-save-btn").disabled, "Session failure did not unlock its draft");
      assert(current().querySelector(".session-name-input").value === "Retry session" && !current().querySelector(".session-editor").classList.contains("hidden"), "Write failure discarded the editor draft");
      assert(JSON.stringify(await api.get("session_overrides", "ui-refresh-0")) === JSON.stringify(before), "Failed UI save changed stored settings");
      current().querySelector(".session-save-btn").click();
      current().querySelector(".session-save-btn").click();
      await waitForDOM(el.historyList, () => current().querySelector(".session-editor").classList.contains("hidden")
        && !current().querySelector(".session-save-btn").disabled, "Session retry did not close and unlock the editor");
      assert((await api.get("session_overrides", "ui-refresh-0")).name === "Retry session", "Retry did not save the submitted name");
      assert(current().querySelector(".session-location").textContent === "Retry session", "Committed session name was not displayed");
    }));

    await check("failed end-size changes restore the saved grouping and keep an unsaved session name", () => withHistoryUI(async ({ ui, el }) => {
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      observeTransactions(await historyDb.initDb());
      await ui.loadShotHistoryList();
      const current = () => el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      current().querySelector(".session-edit-btn").click();
      current().querySelector(".session-name-input").value = "Unsubmitted name";
      let select = current().querySelector(".session-end-size");
      const previous = select.value;
      select.value = previous === "6" ? "3" : "6";
      const submitted = select.value;
      abortNextWrite = "session_overrides";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForDOM(el.historyList, () => current().querySelector(".session-edit-status").textContent.startsWith("Could not save scorecard")
        && !current().querySelector(".session-end-size").disabled, "Grouping failure did not finish");
      assert(current().querySelector(".session-end-size").value === previous, "Failed grouping retained an unsaved selection");
      assert(current().querySelector(".session-name-input").value === "Unsubmitted name", "Grouping failure lost the session draft");
      select = current().querySelector(".session-end-size");
      select.value = submitted;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForDOM(el.historyList, () => current().querySelector(".session-edit-status").textContent === "Scorecard grouping saved."
        && !current().querySelector(".session-end-size").disabled, "Grouping retry did not finish");
      assert((await api.get("session_overrides", "ui-refresh-0")).arrows_per_end === Number(submitted), "Grouping retry was not stored");
      assert((await api.get("session_overrides", "ui-refresh-0")).name === "Retry session"
        && current().querySelector(".session-name-input").value === "Unsubmitted name", "Grouping save overwrote or discarded an unsaved name");
    }));

    await check("a committed session edit remains saved when its following history read fails", () => withHistoryUI(async ({ ui, el }) => {
      await ui.loadShotHistoryList();
      const current = () => el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      current().querySelector(".session-edit-btn").click();
      current().querySelector(".session-name-input").value = "Saved without refresh";
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      const connection = await historyDb.initDb();
      const transaction = connection.transaction;
      let fail = true;
      connection.transaction = function (...args) {
        if (fail && args[0] === "shots" && args[1] === "readonly") { fail = false; throw new Error("Post-save read unavailable"); }
        return transaction.apply(this, args);
      };
      try {
        current().querySelector(".session-save-btn").click();
        await waitForDOM(el.historyList, () => current().querySelector(".session-edit-status").textContent.startsWith("Settings saved.")
          && !current().querySelector(".session-save-btn").disabled, "Committed edit was not distinguished from the failed refresh");
        assert((await api.get("session_overrides", "ui-refresh-0")).name === "Saved without refresh", "Refresh failure lost the committed name");
        assert(current().querySelector(".session-editor").classList.contains("hidden"), "Committed edit stayed open as an unsaved draft");
        assert(el.historyList.textContent.includes("Post-save read unavailable"), "Failed follow-up read was hidden");
      } finally { connection.transaction = transaction; }
      await ui.loadShotHistoryList();
      assert(current().querySelector(".session-location").textContent === "Saved without refresh", "Retry did not display the committed name");
    }));

    await check("merged groups stay locked until every overlapping session save finishes", () => withHistoryUI(async ({ ui, el, saveSession }) => {
      const shots = [
        { id: "merge-edit-a", timestamp: "2085-01-01T12:00:00Z" },
        { id: "merge-edit-b", timestamp: "2085-01-01T13:15:00Z" },
      ];
      for (const shot of shots) await api.saveCapture({ ...shot, sample: true, capture_kind: "arrow" });
      await ui.loadShotHistoryList();
      const row = (id) => el.historyList.querySelector(`[data-session-id="${id}"]`);
      for (const shot of shots) { row(shot.id).querySelector(".session-edit-btn").click(); row(shot.id).querySelector(".session-name-input").value = shot.id; }
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      const connection = await historyDb.initDb();
      const transaction = connection.transaction;
      const releases = [];
      let ready, first, second;
      const bothCommitted = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        const stores = Array.isArray(args[0]) ? args[0] : [args[0]];
        if (stores.includes("session_overrides") && args[1] === "readwrite") {
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { releases.push(() => handler(event)); if (releases.length === 2) ready(); });
          } });
        }
        return tx;
      };
      try {
        first = saveSession(row(shots[0].id));
        second = saveSession(row(shots[1].id));
        await bothCommitted;
        await api.saveCapture({ id: "merge-edit-bridge-a", timestamp: "2085-01-01T12:25:00Z", sample: true });
        await api.saveCapture({ id: "merge-edit-bridge-b", timestamp: "2085-01-01T12:50:00Z", sample: true });
        await ui.loadShotHistoryList();
        assert(row(shots[0].id).querySelector(".session-save-btn").disabled, "Merging unlocked both pending edits");
        releases[0]();
        await first;
        const merged = row(shots[0].id);
        assert(merged.querySelector(".session-save-btn").disabled && merged.querySelector(".session-end-size").disabled,
          "The first completed save unlocked another pending edit in the merged group");
        releases[1]();
        await second;
        assert(!row(shots[0].id).querySelector(".session-save-btn").disabled, "The merged group stayed locked after both saves finished");
      } finally {
        connection.transaction = transaction;
        releases.forEach((release) => release());
        await Promise.allSettled([first, second]);
      }
    }));

    await check("capture events keep recents ordered and refresh metrics without losing session edits or focus", () => withHistoryUI(async ({ ui, el, publish }) => {
      await Promise.all([ui.loadShotHistoryList(), ui.loadRecentShotsList()]);
      const ids = () => [...el.recentShotsList.querySelectorAll(".recent-shot-card")].map((card) => card.dataset.shotId);
      const expected = uiShots.slice(1).reverse().map((shot) => shot.id);
      await publish("shot-saved", { localShotId: uiShots[0].id });
      assert(JSON.stringify(ids()) === JSON.stringify(expected), "An older upload displaced a newer recent capture");
      const session = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      session.querySelector(".session-edit-btn").click();
      const name = session.querySelector(".session-name-input");
      name.value = "Unfinished session name";
      name.focus();
      name.setSelectionRange(3, 7);
      await api.saveShotTrace(uiTrace(uiShots[5].id), { shot_score: 99 });
      await publish("shot-trace-saved", { localShotId: uiShots[5].id });
      const refreshed = el.historyList.querySelector('[data-session-id="ui-refresh-0"]');
      const newName = refreshed.querySelector(".session-name-input");
      assert(newName.value === "Unfinished session name" && !refreshed.querySelector(".session-editor").classList.contains("hidden"), "Refresh discarded an unfinished session edit");
      assert(document.activeElement === newName && newName.selectionStart === 3 && newName.selectionEnd === 7, "Refresh lost editor focus or selection");
      assert(refreshed.querySelectorAll(".badge-val")[1].textContent === "42", "Session average kept the old score");
      const card = el.recentShotsList.querySelector('[data-shot-id="ui-refresh-5"]');
      assert(card.querySelector(".metric-val.score").textContent === "99", "Recent card kept the old score");
      card.focus();
      await publish("shot-saved", { localShotId: uiShots[0].id });
      assert(document.activeElement?.dataset.shotId === uiShots[5].id, "Recent-card focus was lost on refresh");
    }));

    await check("review loads current metadata and late traces preserve an unsaved arrow result", () => withHistoryUI(async ({ ui, el, store, publish }) => {
      await api.saveShotTrace(uiTrace(uiShots[5].id), { shot_score: 99 });
      await ui.reviewShotTrace(uiShots[5]);
      assert(store.get().formScore === 99, "Opening a stale card restored its older score");
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      el.outcomeDistanceInput.value = "28";
      el.outcomeDistanceInput.focus();
      store.set({ replayActive: true });
      const replacement = uiTrace(uiShots[5].id);
      replacement.payload.push({ tUs: 1000000, az: 1 });
      await api.saveShotTrace(replacement, { shot_score: 88 });
      await publish("shot-trace-saved", { localShotId: uiShots[5].id });
      assert(store.get().formScore === 88 && store.get().reviewInfo.includes("Float Score: 88"), "Active review did not receive the late score");
      assert(!store.get().replayActive, "A replaced trace left the old replay running");
      assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').classList.contains("selected") && el.outcomeDistanceInput.value === "28", "Late telemetry reset an unsaved target result");
      assert(document.activeElement === el.outcomeDistanceInput, "Late telemetry moved focus out of the target editor");
    }));

    await check("a score-only trace refresh preserves playback, manual markers and unfinished target edits", () => withHistoryUI(async ({ ui, el, store, publish }) => {
      const shot = { id: "unchanged-trace-score-refresh", capture_kind: "arrow", timestamp: "2100-01-01T12:04:00Z", shot_score: 61 };
      const trace = { shot_id: shot.id, source: "browser", sample_rate_hz: 50,
        payload: Array.from({ length: 80 }, (_, index) => ({ tUs: (index - 20) * 20000,
          ax: 0, ay: 0, az: index === 20 ? 16 : 1, roll: 0, pitch: 0, micAmp: 0 })) };
      await api.saveCapture(shot, trace);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      el.outcomeDistanceInput.value = "28";
      el.outcomeDistanceInput.focus();
      store.set({ reviewReleaseIdx: 18, reviewHitIdx: 38, reviewReleaseTimeMs: -40, reviewHitTimeMs: 360,
        replayActive: true, replayPaused: false, replayProgress: 0.35 });
      await api.saveShotTrace(trace, { shot_score: 88 });
      await publish("shot-trace-saved", { localShotId: shot.id });
      const current = store.get();
      assert(current.formScore === 88 && current.reviewInfo.includes("Float Score: 88"), "Score-only refresh did not load the committed metric");
      assert(current.reviewReleaseIdx === 18 && current.reviewHitIdx === 38 && current.reviewReleaseTimeMs === -40 &&
        current.reviewHitTimeMs === 360 && current.replayActive && !current.replayPaused && current.replayProgress === 0.35,
        "An identical recording reset manual markers or interrupted playback");
      assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').classList.contains("selected") &&
        el.outcomeDistanceInput.value === "28" && document.activeElement === el.outcomeDistanceInput,
        "Score-only refresh changed the target draft or its focus");
      await api.removeSavedShots([shot.id]);
    }));

    await check("history and review distinguish unavailable Float Scores from zero and imported numbers", () => withHistoryUI(async ({ ui, el, store }) => {
      const scores = [null, "0", "100", "bad", false];
      const captures = scores.map((shot_score, index) => ({
        id: `ui-score-${index}`, timestamp: new Date(Date.parse("2099-01-01T12:00:00Z") + index * 10000).toISOString(),
        sample: true, capture_kind: "arrow", score_version: "openfloat-float-score-v1", shot_score,
        stability_score: null, peak_g: null, arrow_score: index === 0 ? 0 : null,
      }));
      for (const capture of captures) await api.saveCapture(capture, uiTrace(capture.id));
      await Promise.all([ui.loadShotHistoryList(), ui.loadRecentShotsList()]);
      const session = el.historyList.querySelector('[data-session-id="ui-score-0"]');
      assert(session.querySelectorAll(".badge-val")[1].textContent === "50", "Missing or string scores corrupted the session average");
      assert(session.textContent.includes("2 of 5 captures scored"), "Partial score coverage was hidden");
      for (let index = 0; index < captures.length; index++) {
        const card = el.recentShotsList.querySelector(`[data-shot-id="ui-score-${index}"]`);
        const expected = index === 1 ? "0" : index === 2 ? "100" : "--";
        assert(card.querySelector(".metric-val.score").textContent === expected, `Wrong score display for capture ${index}`);
        assert(card.querySelector(".metric-val.peak").textContent === "--", "Missing peak force became zero g");
      }
      await ui.reviewShotTrace(captures[0]);
      assert(store.get().formScore === null && store.get().coachTitle === "No Float Score", "Missing review scores became a poor form diagnosis");
      assert(store.get().reviewInfo.includes("Float Score: --") && store.get().reviewInfo.includes("Peak Force: --"), "Review fabricated missing measurements");
      assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="0"]').classList.contains("selected"), "Float Score availability changed a recorded target miss");
      await ui.reviewShotTrace(captures[1]);
      assert(store.get().formScore === 0, "A valid zero Float Score disappeared from review");
    }));

    await check("hold and firmware reviews keep capture provenance and suppress unsupported release markers", () => withHistoryUI(async ({ ui, el, store }) => {
      const payload = Array.from({ length: 80 }, (_, index) => ({
        tUs: (index - 20) * 20000, ax: 0, ay: 0, az: index === 20 ? 16 : 1, roll: 0, pitch: 0,
        micAmp: index >= 40 && index <= 43 ? 40 : 0,
      }));
      const captures = [
        { id: "phase-hold", capture_kind: "hold", source: "browser" },
        { id: "phase-legacy-hold", label: "Manual Recording", source: "browser" },
        { id: "phase-firmware", capture_kind: "arrow", source: "firmware" },
      ];
      for (const { source, ...shot } of captures) {
        await api.saveCapture({ ...shot, timestamp: "2100-01-01T12:00:00Z" }, { shot_id: shot.id, sample_rate_hz: 50, source, payload });
        await ui.reviewShotTrace(shot);
        assert(store.get().reviewTraceSource === source, "Review lost its trace source");
        assert(store.get().reviewReleaseIdx === null && store.get().reviewHitIdx === null && store.get().reviewRangeEst === "", "Review invented release or impact timing");
      }
      const compared = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { stop(); reject(new Error("Compare selection did not load")); }, 2000);
        const stop = store.subscribe((state) => {
          if (state.compareShotId !== "phase-hold") return;
          clearTimeout(timeout); stop(); resolve();
        });
      });
      el.reviewCompareSelect.value = "phase-hold";
      el.reviewCompareSelect.dispatchEvent(new Event("change"));
      await compared;
      assert(store.get().compareCaptureKind === "hold" && store.get().compareTraceSource === "browser", "Comparison lost hold provenance");
    }));

    await check("timed firmware review uses the recorded release and measured sample rate", () => withHistoryUI(async ({ ui, store }) => {
      const shot = { id: "timed-firmware-review", capture_kind: "arrow", timestamp: "2100-01-01T12:01:00Z" };
      const decoded = decodeTimedFirmwareTrace(timedFirmwareTraceFrames().bytes);
      await api.saveCapture(shot, { shot_id: shot.id, source: "firmware-timed",
        sample_rate_hz: decoded.sampleRateHz, payload: decoded.trace });
      await ui.reviewShotTrace(shot);
      assert(store.get().reviewTraceSource === "firmware-timed" && store.get().reviewSampleRateHz === 88,
        "Review replaced timing provenance or sample rate");
      assert(store.get().reviewReleaseTimeMs === 0 && store.get().reviewReleaseIdx > 900,
        "Review guessed the release from sample count");
      assert(store.get().reviewMicSeries[0].tUs === -11000000 && store.get().reviewMicSeries.at(-1).tUs === 322000,
        "Review shifted the audio timing");
    }));

    await check("late browser traces update release markers without requiring a new review", () => withHistoryUI(async ({ ui, store, publish }) => {
      const shot = { id: "phase-late-trace", capture_kind: "arrow", timestamp: "2100-01-01T12:00:00Z" };
      await api.saveCapture(shot, { shot_id: shot.id, source: "browser", payload: [] });
      await ui.reviewShotTrace(shot);
      assert(store.get().reviewReleaseIdx === null, "Empty trace showed a release");
      const payload = Array.from({ length: 80 }, (_, index) => ({ tUs: (index - 20) * 20000, ax: 0, ay: 0, az: 1, roll: 0, pitch: 0 }));
      await api.saveShotTrace({ shot_id: shot.id, source: "browser", sample_rate_hz: 50, payload });
      await publish("shot-trace-saved", { localShotId: shot.id });
      assert(store.get().reviewReleaseIdx === 20 && store.get().reviewReleaseTimeMs === 0, "Late trace did not use its recorded event time");
      assert(store.get().reviewHitIdx === null && store.get().reviewRangeEst === "", "Release without impact audio invented a range");
    }));

    await check("late firmware completion cannot replace a newer browser review or reset its markers", () => withHistoryUI(async ({ ui, store, bus, publish }) => {
      const recorder = deviceRecorder();
      recorder.store = store;
      recorder.bus = bus;
      const shotId = 41503;
      const id = await recorder.onShot(deviceShot(shotId));
      await ui.reviewShotTrace(await api.get("shots", id));
      const transaction = captureDb.transaction;
      let hold = true, ready, release;
      const committed = new Promise((resolve) => { ready = resolve; });
      captureDb.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && tx.mode === "readwrite" && tx.objectStoreNames.contains("shot_traces")) {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      const views = [];
      const handlers = bus.handlers.get("shot-trace-saved");
      const refresh = [...handlers][0];
      handlers.delete(refresh);
      handlers.add((payload) => { const work = refresh(payload); views.push(work); return work; });
      let stop;
      const saving = recorder.onTraceChunk(traceChunk(shotId));
      try {
        await committed;
        const browser = { shot_id: id, source: "browser", sample_rate_hz: 50,
          payload: Array.from({ length: 80 }, (_, index) => ({ tUs: (index - 20) * 20000,
            ax: 0, ay: 0, az: index === 20 ? 16 : 1, roll: 0, pitch: 0, micAmp: 0 })) };
        await api.saveShotTrace(browser, { shot_score: 88 });
        await publish("shot-trace-saved", { localShotId: id });
        store.set({ reviewReleaseIdx: 18, reviewHitIdx: 38, reviewReleaseTimeMs: -40, reviewHitTimeMs: 360,
          replayActive: true, replayPaused: true, replayProgress: 0.35 });
        let staleTrace = false;
        stop = store.subscribe((state) => {
          if (state.reviewTraceSource !== "browser" || JSON.stringify(state.reviewTrace) !== JSON.stringify(browser.payload)) staleTrace = true;
        });
        release();
        await saving;
        await Promise.all(views);
        assert(!staleTrace, "Late completion put older firmware samples back into the browser review");
        assert(store.get().reviewReleaseTimeMs === -40 && store.get().reviewHitTimeMs === 360 &&
          store.get().replayActive && store.get().replayPaused && store.get().replayProgress === 0.35,
          "An unchanged saved trace reset manual markers or playback");
        assert(store.get().formScore === 88 && store.get().reviewSampleRateHz === 50, "Review lost the newer browser score or timing");
      } finally {
        release?.();
        await saving;
        await Promise.allSettled(views);
        stop?.();
        captureDb.transaction = transaction;
        await api.removeSavedShots([id]);
      }
    }));

    await check("a delayed capture refresh cannot restore a card deleted by a newer refresh", () => withHistoryUI(async ({ ui, el, publish }) => {
      const id = "ui-refresh-deleted";
      await api.saveCapture({ id, timestamp: "2098-01-01T12:02:00Z", sample: true }, uiTrace(id));
      const historyDb = await import("../app/core/db.js?v=shot-store-176");
      const connection = await historyDb.initDb();
      const transaction = connection.transaction;
      let release;
      let hold = true;
      let ready;
      const blocked = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[0] === "shots" && args[1] === "readonly") {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      let delayed;
      try {
        delayed = publish("shot-saved", { localShotId: id });
        await blocked;
        await api.removeSavedShots([id]);
        await ui.refreshAfterDeletion([id]);
        release();
        await delayed;
        assert(!el.recentShotsList.querySelector(`[data-shot-id="${id}"]`) && !el.historyList.querySelector(`[data-shot-id="${id}"]`), "An old asynchronous refresh restored a deleted capture");
      } finally {
        connection.transaction = transaction;
        release?.();
        await delayed;
      }
    }));
    await check("native canvas dragging uses its review speed immediately and ignores a replaced review", async () => {
      const { mountReviewMarkers } = await import("../app/ui/dashboard.js?v=shot-store-163");
      const store = createStore({
        reviewMode: true, reviewShotId: "marker-first", reviewSampleRateHz: 2, chartView: "trace",
        reviewTrace: [0, 500000, 1000000].map((tUs) => ({ tUs })),
        reviewReleaseIdx: 0, reviewReleaseTimeMs: 0, reviewHitIdx: 2, reviewHitTimeMs: 1000,
        reviewRangeSpeed: { fps: 300, source: "assigned" },
      });
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:fixed;left:20px;top:20px;width:100px;height:100px;visibility:hidden";
      document.body.append(canvas);
      mountReviewMarkers({ store, canvas });
      const rect = canvas.getBoundingClientRect();
      const mouse = (type, x) => canvas.dispatchEvent(new MouseEvent(type, {
        clientX: rect.left + x, clientY: rect.top + 90,
      }));
      try {
        mouse("mousedown", 0);
        mouse("mousemove", 40);
        assert(store.get().reviewReleaseTimeMs === 400 && store.get().reviewRangeEst.includes("@ 300 fps"),
          "Native pointer movement or range waited for a bow lookup");
        mouse("mousemove", 60);
        mouse("mouseup", 60);
        const range = store.get().reviewRangeEst;
        mouse("mousemove", 80);
        assert(store.get().reviewReleaseTimeMs === 600 && store.get().reviewRangeEst === range, "Movement after mouseup changed the latest native drag");
        mouse("mousedown", 60);
        mouse("mousemove", 70);
        store.set({ reviewShotId: "marker-second", reviewRangeEst: "New review" });
        mouse("mousemove", 80);
        assert(store.get().reviewRangeEst === "New review", "An old gesture changed another review");
      } finally {
        canvas.remove();
      }
    });
    await check("guide HTML preserves safe image attributes and in-app document links", async () => {
      const { renderMarkdown } = await import("../app/ui/guide.js?v=shot-store-161");
      const pageUrl = new URL("../docs/feature-status.md", location.href);
      const quickUrl = new URL("quick-start.md", pageUrl);
      const html = renderMarkdown([
        '![Dashboard "preview" <safe>](images/dashboard-live.png)',
        '[**Quick Start**](quick-start.md#connect-sensor)',
        '[Blueprint](../Blueprint.md)',
        '[Unsafe](javascript:alert(1)) <script>alert(1)</script>',
        '![Unsafe](data:text/html,<svg onload=alert(1)>)',
      ].join("\n\n"), { pageUrl, pages: new Map([[quickUrl.href, "quick-start"]]) });
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const image = parsed.querySelector("img");
      assert(image?.getAttribute("src") === new URL("images/dashboard-live.png", pageUrl).href,
        "Image resolved outside its guide folder");
      assert(image.getAttribute("alt") === 'Dashboard "preview" <safe>', "HTML changed the image description");
      const links = parsed.querySelectorAll("a");
      assert(links.length === 2 && links[0].getAttribute("href") === "#/guide/quick-start#connect-sensor"
        && !links[0].hasAttribute("target") && links[0].querySelector("strong")?.textContent === "Quick Start",
      "Indexed links lost navigation or label formatting");
      assert(links[1].getAttribute("href") === new URL("../Blueprint.md", pageUrl).href
        && links[1].rel.includes("noopener"), "Other files lost their document-relative destination");
      assert(parsed.querySelectorAll("img").length === 1 && !parsed.querySelector("script,svg,[onload],[onerror]"),
        "Guide Markdown introduced executable content");
    });
    await check("bow creation commits its exact upload payload and rejects duplicate ids", async () => {
      const profile = { id: "atomic-bow", model: "Atomic Bow", draw_weight: 42.5, arrow_speed: 290,
        stabilizer_setup: "30 inch", notes: "Test only", created_at: "2026-01-01" };
      const saving = api.saveBowProfile(profile, { create: true });
      profile.model = "Changed after submission";
      const saved = await saving;
      assert(completed.has(latestWrite), "Bow save resolved before commit");
      assert(saved.model === "Atomic Bow", "Caller mutation changed the submitted profile");
      const tasks = (await api.getAll("sync_queue")).filter((task) => task.targetId === saved.id);
      assert(tasks.length === 1 && tasks[0].action === "CREATE" && tasks[0].status === "pending", "Bow creation lost or duplicated its upload");
      assert(JSON.stringify(tasks[0].payload) === JSON.stringify(await api.get("bow_profiles", saved.id)), "Upload differs from the committed bow");
      await rejects(() => api.saveBowProfile({ ...saved, model: "Duplicate" }, { create: true }));
      assert((await api.get("bow_profiles", saved.id)).model === "Atomic Bow", "Duplicate creation replaced the original bow");
      assert((await api.getAll("sync_queue")).filter((task) => task.targetId === saved.id).length === 1, "Failed duplicate queued an upload");
    });

    await check("bow edits preserve existing metadata and cannot recreate a deleted profile", async () => {
      const saved = await api.saveBowProfile({ id: "atomic-bow", model: "Edited Bow", arrow_speed: 310, draw_weight: null });
      assert(saved.created_at === "2026-01-01" && saved.stabilizer_setup === "30 inch", "Editing discarded existing metadata");
      const tasks = (await api.getAll("sync_queue")).filter((task) => task.targetId === saved.id);
      assert(tasks.length === 2 && tasks[1].action === "UPDATE" && tasks[1].payload.arrow_speed === 310, "Edit did not queue its committed payload");
      const before = (await api.getAll("sync_queue")).length;
      await rejects(() => api.saveBowProfile({ id: "missing-bow", model: "Missing Bow" }));
      assert(!await api.get("bow_profiles", "missing-bow"), "Editing recreated a deleted bow");
      assert((await api.getAll("sync_queue")).length === before, "Missing bow queued an upload");
    });

    await check("bow creation and editing roll back when either profile or queue writes abort", async () => {
      for (const failingStore of ["bow_profiles", "sync_queue"]) {
        const before = (await api.getAll("sync_queue")).length;
        const id = `rollback-bow-${failingStore}`;
        abortNextWrite = failingStore;
        await rejects(() => api.saveBowProfile({ id, model: "Rollback Bow" }, { create: true }));
        assert(!await api.get("bow_profiles", id), "A partial bow creation committed");
        abortNextWrite = failingStore;
        await rejects(() => api.saveBowProfile({ id: "atomic-bow", model: "Aborted edit" }));
        assert((await api.get("bow_profiles", "atomic-bow")).model === "Edited Bow", "Aborted edit changed the bow");
        assert((await api.getAll("sync_queue")).length === before, "Aborted profile changes queued uploads");
      }
    });

    await check("bow deletion and its upload roll back together while historical references survive", async () => {
      const id = "delete-bow";
      await api.saveBowProfile({ id, model: "Historical Bow" }, { create: true });
      await api.put("shots", { id: "bow-history-shot", bow_profile_id: id, session_id: "bow-history-session" });
      await api.put("sessions", { id: "bow-history-session", bow_profile_id: id });
      await api.put("session_overrides", { id: "bow-history-shot", bow_profile_id: id, name: "Practice" });
      const before = (await api.getAll("sync_queue")).length;
      for (const failingStore of ["bow_profiles", "sync_queue"]) {
        abortNextWrite = failingStore;
        await rejects(() => api.removeBowProfile(id));
        assert(!!await api.get("bow_profiles", id), "Aborted deletion lost the profile");
        assert((await api.getAll("sync_queue")).length === before, "Aborted deletion queued an upload");
      }
      const removed = await api.removeBowProfile(id);
      assert(completed.has(latestWrite) && removed.model === "Historical Bow", "Deletion resolved before commit");
      assert(!await api.get("bow_profiles", id), "Deleted bow survived");
      const tasks = (await api.getAll("sync_queue")).filter((task) => task.targetId === id);
      assert(tasks.length === 2 && tasks[1].action === "DELETE", "Deletion lost its ordered upload");
      for (const [table, key] of [["shots", "bow-history-shot"], ["sessions", "bow-history-session"], ["session_overrides", "bow-history-shot"]]) {
        assert((await api.get(table, key)).bow_profile_id === id, "Bow deletion changed historical records");
      }
      assert(await api.removeBowProfile(id) === null, "Deleting an absent bow reported a change");
      assert((await api.getAll("sync_queue")).length === before + 1, "Repeated deletion queued another upload");
    });

    const { mountBowProfiles } = await import(`../app/ui/bow-profiles.js?browser-test=${testName}`);
    async function withBowUI(run, preferences) {
      const fixture = document.createElement("div");
      fixture.style.cssText = "position:absolute;left:-10000px;width:400px";
      fixture.append(historyMarkup.getElementById("bowProfileSelect").closest(".settings-card").cloneNode(true));
      document.body.append(fixture);
      const el = Object.fromEntries([...fixture.querySelectorAll("[id]")].map((node) => [node.id, node]));
      const settings = new Map();
      const ui = mountBowProfiles({ el, bus: new EventBus(), database: api, confirmDelete: () => true,
        preferences: preferences || { getItem: (key) => settings.get(key) || null, setItem: (key, value) => settings.set(key, value) } });
      function type(id, value) { el[id].value = value; el[id].dispatchEvent(new Event("input")); }
      function waitStatus(pattern) {
        if (pattern.test(el.bowProfileStatus.textContent)) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (pattern.test(el.bowProfileStatus.textContent)) { clearTimeout(timeout); observer.disconnect(); resolve(); }
          });
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Bow profile operation did not finish")); }, 5000);
          observer.observe(el.bowProfileStatus, { subtree: true, childList: true, characterData: true });
        });
      }
      try { await ui.load(); await run({ ui, el, type, waitStatus }); }
      finally { fixture.remove(); }
    }

    await check("the real bow form rejects invalid speed and retains a failed save for retry", async () => withBowUI(async ({ el, type, waitStatus }) => {
      type("bowModelInput", "UI Retry Bow");
      type("bowSpeedInput", "500");
      const before = (await api.getAll("bow_profiles")).length;
      el.saveBowProfileBtn.click();
      assert((await api.getAll("bow_profiles")).length === before, "Invalid HTML speed was saved");
      type("bowSpeedInput", "295");
      type("drawWeightInput", "42.5");
      abortNextWrite = "sync_queue";
      el.saveBowProfileBtn.click();
      assert(el.bowProfileSelect.disabled && el.newBowProfileBtn.disabled && el.bowModelInput.disabled, "Save did not lock the real controls");
      await waitStatus(/^Could not save/);
      assert(el.bowModelInput.value === "UI Retry Bow" && el.drawWeightInput.value === "42.5", "Failed save discarded the draft");
      assert(el.bowProfileSelect.value === "" && !el.saveBowProfileBtn.disabled, "Failed save cannot be retried");
      assert((await api.getAll("bow_profiles")).length === before, "Queue failure committed the UI profile");
      el.saveBowProfileBtn.click();
      el.saveBowProfileBtn.click();
      await waitStatus(/^Saved bow profile/);
      const id = el.bowProfileSelect.value;
      const saved = await api.get("bow_profiles", id);
      assert(saved.model === "UI Retry Bow" && saved.arrow_speed === 295 && saved.draw_weight === 42.5, "Retry saved different values");
      assert((await api.getAll("bow_profiles")).length === before + 1, "Repeated UI save created duplicates");
      assert((await api.getAll("sync_queue")).filter((task) => task.targetId === id).length === 1, "Retry queued duplicate uploads");
      assert(el.bowProfileSelect.selectedOptions[0].textContent.includes("UI Retry Bow") && !el.deleteBowProfileBtn.disabled, "Saved profile is not selected and editable");
    }));

    await check("the real bow form preserves a committed save when preferences are unavailable", async () => withBowUI(async ({ el, type, waitStatus }) => {
      type("bowModelInput", "UI Local Bow");
      el.saveBowProfileBtn.click();
      await waitStatus(/^Saved bow profile/);
      const id = el.bowProfileSelect.value;
      assert((await api.get("bow_profiles", id)).model === "UI Local Bow", "Preference failure lost the saved profile");
      assert(el.bowProfileStatus.textContent.includes("could not remember"), "Preference failure was hidden");
      assert(!el.saveBowProfileBtn.disabled && !el.deleteBowProfileBtn.disabled, "Committed profile cannot be edited");
    }, { getItem: () => null, setItem() { throw new Error("Preferences unavailable"); } }));

    await check("the real bow form keeps a failed delete and refreshes after its successful retry", async () => withBowUI(async ({ el, waitStatus }) => {
      el.bowProfileSelect.value = "atomic-bow";
      el.bowProfileSelect.dispatchEvent(new Event("change"));
      // Wait for the native detail read to finish before requesting deletion.
      await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (!el.deleteBowProfileBtn.disabled) { clearTimeout(timeout); observer.disconnect(); resolve(); }
        });
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Bow details did not load")); }, 5000);
        observer.observe(el.deleteBowProfileBtn, { attributes: true });
      });
      abortNextWrite = "sync_queue";
      el.deleteBowProfileBtn.click();
      await waitStatus(/^Could not delete/);
      assert(el.bowProfileSelect.value === "atomic-bow" && el.bowModelInput.value === "Edited Bow", "Failed deletion changed the form");
      assert(!!await api.get("bow_profiles", "atomic-bow") && !el.deleteBowProfileBtn.disabled, "Failed deletion lost the profile or retry");
      el.deleteBowProfileBtn.click();
      el.deleteBowProfileBtn.click();
      await waitStatus(/^Deleted bow profile/);
      assert(el.bowProfileSelect.value === "" && el.bowModelInput.value === "" && el.deleteBowProfileBtn.disabled, "Deletion did not clear selection and fields");
      assert(![...el.bowProfileSelect.options].some((item) => item.value === "atomic-bow"), "Deleted option remained in the dropdown");
      assert((await api.getAll("sync_queue")).filter((task) => task.targetId === "atomic-bow" && task.action === "DELETE").length === 1, "Repeated UI delete queued duplicates");
    }));
    const backfillIds = ["backfill-earlier", "backfill-original", "backfill-later"];
    for (const [index, id] of backfillIds.entries()) await api.saveCapture({ id, sample: true, capture_kind: "arrow",
      timestamp: ["2080-01-01T11:55:00Z", "2080-01-01T12:00:00Z", "2080-01-01T12:10:00Z"][index] }, rangeTrace(id));
    await api.put("bow_profiles", { id: "backfill-bow", model: "Backfill Bow", arrow_speed: 240 });
    await api.put("session_overrides", { id: backfillIds[1], name: "Backfill practice", bow_profile_id: "backfill-bow", arrows_per_end: 6, note: "Keep context" });

    await check("late earlier captures retain the saved session name, bow and scorecard grouping", () => withHistoryUI(async ({ ui, el }) => {
      await ui.loadShotHistoryList();
      const group = el.historyList.querySelector('[data-session-id="backfill-earlier"]');
      assert(group.querySelector(".session-location").textContent === "Backfill practice", "Backfill hid the saved session name");
      assert(group.querySelector(".session-bow").textContent === "Backfill Bow", "Backfill hid the assigned bow");
      assert(group.querySelector(".session-end-size").value === "6", "Backfill reset the scorecard grouping");
    }));

    await check("shot review uses the inherited session bow after a late capture changes its anchor", () => withHistoryUI(async ({ ui, store }) => {
      await withActiveBow(null, () => ui.reviewShotTrace({ id: backfillIds[1] }));
      assert(store.get().reviewRangeSpeed.fps === 240 && store.get().reviewRangeSpeed.source === "assigned", "Backfill lost the review's bow speed provenance");
      assert(store.get().reviewRangeEst.includes("@ 240 fps"), "Backfill replaced the assigned speed with an assumption");
    }));

    let backfillBackup;
    await check("selected current anchors export inherited context without changing local records", async () => {
      backfillBackup = await api.exportSelectedShots([backfillIds[0]]);
      const { stores } = backfillBackup;
      assert(stores.session_overrides.length === 1 && stores.session_overrides[0].id === backfillIds[0]
        && stores.session_overrides[0].name === "Backfill practice" && stores.session_overrides[0].arrows_per_end === 6, "Selected anchor export lost inherited context");
      assert(stores.shots.length === 1 && stores.bow_profiles.length === 1 && stores.bow_profiles[0].id === "backfill-bow", "Context export omitted its bow or included unselected captures");
      assert(!await api.get("session_overrides", backfillIds[0]), "Export wrote its snapshot alias into local storage");
      const full = await api.exportSelectedShots(backfillIds);
      assert(full.stores.session_overrides.length === 1 && full.stores.session_overrides[0].id === backfillIds[1], "Full selection rewrote the original context id");
      assert((await api.exportSelectedShots([backfillIds[2]])).stores.session_overrides.length === 0, "Non-anchor partial export invented session settings");
    });

    await check("selected capture exports include directly assigned bow profiles", async () => {
      await api.saveCapture({ id: "direct-bow-export", sample: true, timestamp: "2080-02-01T12:00:00Z", bow_profile_id: "backfill-bow" });
      const backup = await api.exportSelectedShots(["direct-bow-export"]);
      assert(backup.stores.bow_profiles.length === 1 && backup.stores.bow_profiles[0].id === "backfill-bow", "Direct bow assignment lost its profile on export");
    });

    await check("deleting an old context anchor preserves inherited settings at the surviving current anchor", async () => {
      abortNextWrite = "session_overrides";
      await rejects(() => api.removeSavedShots([backfillIds[1]]));
      assert(!!await api.get("shots", backfillIds[1]) && !!await api.get("session_overrides", backfillIds[1])
        && !await api.get("session_overrides", backfillIds[0]), "Failed inherited-context move partially committed");
      await api.removeSavedShots([backfillIds[1]]);
      const saved = await api.get("session_overrides", backfillIds[0]);
      assert(saved?.name === "Backfill practice" && saved.bow_profile_id === "backfill-bow" && saved.arrows_per_end === 6
        && saved.note === "Keep context", "Deleting the old anchor lost inherited settings");
      assert(!await api.get("session_overrides", backfillIds[1]), "Deleted anchor left an orphan context");
    });

    await check("an inherited-context anchor export restores independently of its original member capture", async () => {
      await api.removeSavedShots(backfillIds);
      await api.remove("bow_profiles", "backfill-bow");
      await api.importAllData(backfillBackup);
      assert((await api.get("session_overrides", backfillIds[0]))?.name === "Backfill practice"
        && (await api.get("bow_profiles", "backfill-bow"))?.arrow_speed === 240, "Standalone restore lost the exported session or bow");
      assert(!await api.get("shots", backfillIds[1]), "Restore included the unselected original capture");
    });

    const contextEditIds = ["context-edit-earlier", "context-edit-original", "context-edit-later"];
    for (const [index, id] of contextEditIds.entries()) await api.saveCapture({ id, sample: true,
      timestamp: ["2090-01-01T11:55:00Z", "2090-01-01T12:00:00Z", "2090-01-01T12:10:00Z"][index] });
    await api.put("session_overrides", { id: contextEditIds[1], name: "Inherited edit", bow_profile_id: "backfill-bow", arrows_per_end: 6, note: "Keep context" });

    await check("edits at a new group anchor retain its inherited bow, end size and metadata", async () => {
      await api.saveSessionOverride(contextEditIds[0], { name: "Edited inherited practice" }, { shotIds: contextEditIds });
      assert(completed.has(latestWrite), "Inherited edit resolved before commit");
      const saved = await api.get("session_overrides", contextEditIds[0]);
      assert(saved.name === "Edited inherited practice" && saved.bow_profile_id === "backfill-bow"
        && saved.arrows_per_end === 6 && saved.note === "Keep context", "Editing the new anchor lost inherited fields");
      assert((await api.get("session_overrides", contextEditIds[1])).name === "Inherited edit", "New-anchor edit overwrote the original context record");
      await api.saveSessionOverride(contextEditIds[0], { name: null, bow_profile_id: null, arrows_per_end: 3 }, { shotIds: contextEditIds });
      const group = api.groupShotsByTime(await api.getAll("shots")).find((group) => group.anchorId === contextEditIds[0]);
      const context = api.sessionOverrideForGroup(group, new Map((await api.getAll("session_overrides")).map((record) => [record.id, record])));
      assert(context.name === null && context.bow_profile_id === null && context.arrows_per_end === 3, "Cleared current-anchor settings resurrected original values");
    });

    await check("inherited export aliases and bow records share a snapshot with their selected captures", async () => {
      await api.remove("session_overrides", contextEditIds[0]);
      const previousTransaction = db.transaction;
      let concurrentSave;
      db.transaction = (...args) => {
        const tx = previousTransaction(...args);
        if (tx.mode === "readonly") {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            if (name === "shots") {
              const get = store.get.bind(store);
              store.get = (...keys) => {
                const request = get(...keys);
                request.addEventListener("success", () => {
                  concurrentSave ||= api.saveSessionOverride(contextEditIds[0], { name: "After export", bow_profile_id: null, arrows_per_end: 3 }, { shotIds: contextEditIds });
                }, { once: true });
                return request;
              };
            }
            return store;
          };
        }
        return tx;
      };
      try {
        const backup = await api.exportSelectedShots([contextEditIds[0]]);
        assert(!!concurrentSave, "Concurrent context edit was not started");
        await concurrentSave;
        const context = backup.stores.session_overrides[0];
        assert(context.id === contextEditIds[0] && context.name === "Inherited edit"
          && context.bow_profile_id === "backfill-bow" && context.arrows_per_end === 6, "Export context changed mid-snapshot");
        assert(backup.stores.bow_profiles[0]?.arrow_speed === 240, "Export lost the snapshot's assigned bow");
      } finally { db.transaction = previousTransaction; }
      assert((await api.get("session_overrides", contextEditIds[0])).name === "After export", "Concurrent context edit did not complete");
    });

    const { initDataBackup } = await import("../app/ui/data-backup.js?v=shot-store-176");
    async function withBackupUI(run, options = {}) {
      const fixture = document.createElement("div");
      fixture.style.cssText = "position:absolute;left:-10000px;width:400px";
      fixture.append(historyMarkup.getElementById("exportDataBtn").closest(".settings-card").cloneNode(true));
      document.body.append(fixture);
      const el = Object.fromEntries([...fixture.querySelectorAll("[id]")].map((node) => [node.id, node]));
      const logs = [];
      const ui = initDataBackup({ el, database: api, bus: { emit: (_event, message) => logs.push(message) }, ...options });
      function importFile(file) {
        Object.defineProperty(el.importDataInput, "files", { configurable: true, value: [file] });
        el.importDataInput.dispatchEvent(new Event("change"));
      }
      function waitStatus() {
        return waitForDOM(el.dataBackupStatus, () => /^(Imported|Import failed)/.test(el.dataBackupStatus.textContent), "Backup import did not finish");
      }
      try { await run({ ui, el, logs, importFile, waitStatus }); }
      finally { fixture.remove(); }
    }
    function backupFile(id) {
      return new File([JSON.stringify(envelope({ shots: [{ id }] }))], "openfloat-test.json", { type: "application/json" });
    }

    await check("the real backup form keeps a committed import successful when cloud sync throws", () => withBackupUI(async ({ el, importFile, waitStatus }) => {
      importFile(backupFile("backup-ui-sync"));
      await waitStatus();
      assert(!!await api.get("shots", "backup-ui-sync"), "Sync failure lost the local import");
      assert(/^Imported/.test(el.dataBackupStatus.textContent), "Sync failure labeled a committed import as failed");
      assert(el.dataBackupStatus.getAttribute("role") === "status", "Backup result is not announced accessibly");
    }, { syncAdapter: { triggerSync() { throw new Error("Sync unavailable"); } } }));

    await check("the real backup form distinguishes a committed import from a failed view refresh", () => withBackupUI(async ({ el, importFile, waitStatus }) => {
      importFile(backupFile("backup-ui-refresh"));
      await waitStatus();
      assert(!!await api.get("shots", "backup-ui-refresh"), "Refresh failure lost the local import");
      assert(/^Imported/.test(el.dataBackupStatus.textContent) && /refresh/i.test(el.dataBackupStatus.textContent), "Refresh failure mislabeled a committed import");
    }, { onImportComplete() { throw new Error("Views unavailable"); } }));

    await check("the real backup form locks its actions while reading a file and rejects repeated restore events", async () => {
      let releaseRead, reads = 0, refreshed = 0;
      const reading = new Promise((resolve) => { releaseRead = resolve; });
      await withBackupUI(async ({ el, importFile }) => {
        const file = backupFile("backup-ui-repeat");
        file.text = () => { reads++; return reading; };
        importFile(file);
        const locked = el.exportDataBtn.disabled && el.importDataBtn.disabled && el.importDataInput.disabled;
        importFile(file);
        releaseRead(JSON.stringify(envelope({ shots: [{ id: "backup-ui-repeat" }] })));
        await waitForDOM(el.dataBackupStatus, () => refreshed === reads && /^Imported/.test(el.dataBackupStatus.textContent), "Repeated backup imports did not settle");
        assert(locked, "Restore left import/export actions enabled");
        assert(reads === 1 && refreshed === 1, "Repeated restore read or committed the file twice");
        assert(!el.exportDataBtn.disabled && !el.importDataBtn.disabled && !el.importDataInput.disabled, "Completed restore left controls locked");
        assert((await api.getAll("sync_queue")).filter((task) => task.targetId === "backup-ui-repeat").length === 1, "Repeated restore duplicated upload work");
      }, { onImportComplete() { refreshed++; } });
    });

    await check("the real backup form restores rollback failures once when the same file is selected again", () => withBackupUI(async ({ el, importFile, waitStatus }) => {
      const inputFile = backupFile("backup-ui-retry");
      abortNextWrite = "sync_queue";
      importFile(inputFile);
      await waitStatus();
      assert(el.dataBackupStatus.textContent.startsWith("Import failed") && !el.importDataBtn.disabled, "Failed restore cannot be retried");
      assert(!await api.get("shots", "backup-ui-retry"), "Failed restore committed a capture");
      assert(!(await api.getAll("sync_queue")).some((task) => task.targetId === "backup-ui-retry"), "Failed restore left upload work");
      assert(el.importDataInput.value === "", "Failed file selection was not reset for retry");
      importFile(inputFile);
      await waitStatus();
      assert(el.dataBackupStatus.textContent.startsWith("Imported") && !!await api.get("shots", "backup-ui-retry"), "Retry did not restore the capture");
      assert((await api.getAll("sync_queue")).filter((task) => task.targetId === "backup-ui-retry").length === 1, "Retry queued duplicate upload work");
    }));

    await check("the real backup form locks pending exports, blocks imports and returns keyboard focus", async () => {
      let releaseExport;
      const exporting = new Promise((resolve) => { releaseExport = resolve; });
      const downloads = [];
      await withBackupUI(async ({ ui, el, importFile }) => {
        el.exportDataBtn.focus();
        const first = ui.exportData();
        assert(el.exportDataBtn.disabled && el.importDataBtn.disabled && el.importDataInput.disabled, "Pending export left controls enabled");
        await ui.exportData();
        importFile(backupFile("backup-ui-blocked"));
        const snapshot = await api.exportAllData();
        releaseExport(snapshot);
        assert(await first === snapshot && downloads.length === 1 && downloads[0] === snapshot, "Repeated export requested another download or changed the snapshot");
        assert(el.dataBackupStatus.textContent.startsWith("Exported") && !el.exportDataBtn.disabled, "Export did not finish and unlock the form");
        assert(document.activeElement === el.exportDataBtn, "Export did not return keyboard focus");
        assert(!await api.get("shots", "backup-ui-blocked"), "Import ran during a pending export");
      }, { database: { ...api, exportAllData: () => exporting }, download: (record) => downloads.push(record) });
    });

    await check("recent-card read failures report an incomplete refresh and retry reports success", () => withHistoryUI(async ({ ui, el }) => {
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      connection.transaction = function (...args) {
        if (args[0] === "shots" && args[1] === "readonly") throw new Error("Recent read unavailable");
        return transaction.apply(this, args);
      };
      try {
        assert(await ui.loadRecentShotsList() === false, "A failed recent refresh did not report failure to the importer");
        assert(el.recentShotsList.textContent.includes("Failed to load recent shots"), "Recent read failure was hidden");
      } finally { connection.transaction = transaction; }
      assert(await ui.loadRecentShotsList() === true, "A successful recent refresh did not report completion");
      assert(!!el.recentShotsList.querySelector(".recent-shot-card"), "Recent refresh retry did not render captures");
    }));

    async function seedRestoredReview(id, day) {
      const shot = { id, sample: true, capture_kind: "arrow", shot_score: 25, arrow_score: 7,
        target_distance: 20, target_distance_unit: "m", target_face_cm: 40, impact_x: 0.1, impact_y: 0.2,
        timestamp: `2110-01-${String(day).padStart(2, "0")}T12:00:00Z` };
      await api.saveCapture(shot, rangeTrace(id));
      await api.put("bow_profiles", { id: "restore-review-bow", model: "Restore Bow", arrow_speed: 240 });
      await api.put("session_overrides", { id, bow_profile_id: "restore-review-bow" });
      return shot;
    }
    async function restoreIntoReview(history, stores) {
      let status;
      await withBackupUI(async ({ ui: backup, el }) => {
        await backup.importFile(new File([JSON.stringify(envelope(stores))], "review-restore.json", { type: "application/json" }));
        status = el.dataBackupStatus.textContent;
      }, { onImportComplete: () => history.refreshSavedData() });
      return status;
    }

    await check("restoring a reviewed capture refreshes its measured score, trace, microphone and bow speed", () => withHistoryUI(async ({ ui, store }) => {
      const shot = await seedRestoredReview("restore-review-trace", 1);
      await ui.reviewShotTrace(shot);
      store.set({ replayActive: true });
      const trace = rangeTrace(shot.id);
      trace.payload.push({ tUs: 1100000, az: 1, micAmp: 0 });
      trace.mic_series = [{ tUs: 500000, micAmp: 0 }, { tUs: 660000, micAmp: 40 }, { tUs: 670000, micAmp: 0 }];
      await restoreIntoReview(ui, { shots: [{ ...shot, shot_score: 90 }], shot_traces: [trace],
        bow_profiles: [{ id: "restore-review-bow", model: "Restored Bow", arrow_speed: 300 }] });
      assert(store.get().formScore === 90 && store.get().reviewTrace.length === 13, "Restore left the open review's score or trace unchanged");
      assert(store.get().reviewMicSeries.length === 3 && store.get().reviewHitTimeMs === 500, "Restore left the previous microphone or impact timing");
      assert(store.get().reviewRangeSpeed.fps === 300 && store.get().reviewRangeSpeed.source === "assigned", "Restore did not reload the assigned bow speed");
      assert(!store.get().replayActive, "Restore left the replaced trace's replay running");
    }));

    await check("restoring a clean outcome editor updates the saved result and chronological arrow progress", () => withHistoryUI(async ({ ui, el, store }) => {
      const shot = await seedRestoredReview("restore-review-clean", 2);
      await ui.reviewShotTrace(shot);
      await restoreIntoReview(ui, { shots: [{ ...shot, arrow_score: 10, arrow_is_x: true, target_distance: 30,
        target_distance_unit: "yd", target_face_cm: 80 },
        { id: "restore-review-new-arrow", sample: true, capture_kind: "arrow", timestamp: "2110-01-02T12:00:15Z" }] });
      assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="10"][data-outcome-x="true"]').classList.contains("selected"), "A clean editor kept the pre-restore arrow result");
      assert(el.outcomeDistanceInput.value === "30" && el.outcomeDistanceUnit.value === "yd" && el.outcomeFaceInput.value === "80", "A clean editor kept the pre-restore target context");
      assert(store.get().reviewInfo.includes("Arrow: X"), "Review info kept the pre-restore saved result");
      assert(el.reviewArrowProgress.textContent.includes("Arrow 1 of 2") && el.reviewArrowProgress.textContent.includes("1 still to score"), "Restore kept an outdated session's scoring progress");
    }));

    await check("restoring a reviewed capture retains unsaved score, context and cleared impact without moving focus", () => withHistoryUI(async ({ ui, el, store }) => {
      const shot = await seedRestoredReview("restore-review-draft", 3);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      el.outcomeDistanceInput.value = "38";
      el.outcomeDistanceInput.dispatchEvent(new Event("input"));
      el.outcomeFaceInput.value = "60";
      el.outcomeFaceInput.dispatchEvent(new Event("input"));
      el.clearImpactBtn.click();
      el.outcomeDistanceInput.focus();
      await restoreIntoReview(ui, { shots: [{ ...shot, shot_score: 91, arrow_score: 1, target_distance: 50,
        target_face_cm: 122, impact_x: 0.3, impact_y: -0.2 }] });
      assert(store.get().formScore === 91 && store.get().reviewInfo.includes("Arrow: 1"), "Restore did not refresh the saved measurements beneath the draft");
      assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').classList.contains("selected")
        && el.outcomeDistanceInput.value === "38" && el.outcomeFaceInput.value === "60", "Restore overwrote an unsaved arrow result");
      assert(el.outcomeImpactHint.textContent.startsWith("Tap the target") && document.activeElement === el.outcomeDistanceInput, "Restore replaced a cleared draft impact or moved focus");
      assert(el.reviewOutcomeStatus.textContent.includes("unsaved"), "Preserved draft was not distinguished from the restored saved result");
    }));

    await check("restoring comparison data refreshes its trace and clears comparisons whose trace is no longer usable", () => withHistoryUI(async ({ ui, el, store }) => {
      const primary = await seedRestoredReview("restore-review-primary", 4);
      const compared = { id: "restore-review-compare", sample: true, capture_kind: "arrow", label: "Original comparison", timestamp: "2110-01-04T12:00:10Z" };
      await api.saveCapture(compared, rangeTrace(compared.id));
      await ui.reviewShotTrace(primary);
      const loaded = new Promise((resolve) => {
        const unsubscribe = store.subscribe((current) => { if (current.compareShotId === compared.id) { unsubscribe(); resolve(); } });
      });
      el.reviewCompareSelect.value = compared.id;
      el.reviewCompareSelect.dispatchEvent(new Event("change"));
      await loaded;
      await restoreIntoReview(ui, { shots: [{ ...compared, label: "Restored comparison", capture_kind: "hold" }],
        shot_traces: [{ shot_id: compared.id, source: "firmware-timed", sample_rate_hz: 40, payload: [{ tUs: 0, roll: 2 }, { tUs: 25000, roll: 3 }] }] });
      assert(store.get().compareShotLabel.includes("Restored comparison") && store.get().compareTrace[0].roll === 2
        && store.get().compareSampleRateHz === 40 && store.get().compareCaptureKind === "hold", "Restore left the old comparison trace or provenance");
      await restoreIntoReview(ui, { shot_traces: [{ shot_id: compared.id, payload: [] }] });
      assert(store.get().compareShotId === null && store.get().compareTrace === null && el.reviewCompareSelect.value === "", "Restore left an unusable comparison visible");
    }));

    await check("a restored trace without motion data removes the open review's older trace and range markers", () => withHistoryUI(async ({ ui, store }) => {
      const shot = await seedRestoredReview("restore-review-empty", 5);
      await ui.reviewShotTrace(shot);
      assert(store.get().reviewTrace.length > 0, "Initial review has no trace");
      await restoreIntoReview(ui, { shot_traces: [{ shot_id: shot.id }] });
      assert(store.get().reviewMode && store.get().reviewTrace.length === 0 && store.get().reviewMicSeries.length === 0,
        "A missing restored trace left the older recording visible");
      assert(store.get().reviewReleaseTimeMs === null && store.get().reviewHitTimeMs === null && !store.get().reviewRangeEst,
        "A missing restored trace retained earlier release/range markers");
    }));

    await check("review snapshots keep metadata, trace, bow and session context together during a concurrent restore", async () => {
      const shot = await seedRestoredReview("restore-review-snapshot", 6);
      const transaction = db.transaction;
      let restoring;
      db.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === "readonly" && Array.isArray(args[0]) && args[0].includes("bow_profiles")) {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            if (name === "shots") {
              const getAll = store.getAll.bind(store);
              store.getAll = (...keys) => {
                const request = getAll(...keys);
                request.addEventListener("success", () => {
                  restoring ||= api.importAllData(envelope({ shots: [{ ...shot, shot_score: 99 }],
                    shot_traces: [{ shot_id: shot.id, payload: [{ tUs: 0, az: 2 }] }],
                    bow_profiles: [{ id: "restore-review-bow", arrow_speed: 400 }],
                    session_overrides: [{ id: shot.id, name: "After snapshot", bow_profile_id: null }] }));
                }, { once: true });
                return request;
              };
            }
            return store;
          };
        }
        return tx;
      };
      try {
        const snapshot = await api.readSavedReview(shot.id);
        assert(!!restoring, "Concurrent restore was not started");
        await restoring;
        assert(snapshot.shots.find((record) => record.id === shot.id).shot_score === 25 && snapshot.trace.payload.length === 12,
          "Review metadata and trace came from different restores");
        assert(snapshot.bowProfiles.find((record) => record.id === "restore-review-bow").arrow_speed === 240
          && snapshot.overrides.find((record) => record.id === shot.id).bow_profile_id === "restore-review-bow", "Review bow context changed inside the snapshot");
      } finally { db.transaction = transaction; }
      assert((await api.get("shots", shot.id)).shot_score === 99, "Concurrent restore did not complete");
    });

    await check("metadata-only restores retain manual range markers and playback on an unchanged trace", () => withHistoryUI(async ({ ui, store }) => {
      const shot = await seedRestoredReview("restore-review-markers", 7);
      await ui.reviewShotTrace(shot);
      const trace = store.get().reviewTrace;
      store.set({ reviewReleaseTimeMs: 100, reviewHitTimeMs: 850, reviewReleaseIdx: 2, reviewHitIdx: 9,
        replayActive: true, replayProgress: 0.4 });
      await restoreIntoReview(ui, { shots: [{ ...shot, shot_score: 84 }],
        bow_profiles: [{ id: "restore-review-bow", model: "Restore Bow", arrow_speed: 250 }] });
      assert(store.get().reviewTrace === trace && store.get().reviewReleaseTimeMs === 100 && store.get().reviewHitTimeMs === 850,
        "Metadata-only restore replaced the unchanged trace or manual markers");
      assert(store.get().replayActive && store.get().replayProgress === 0.4, "Metadata-only restore interrupted playback");
      assert(store.get().formScore === 84 && store.get().reviewRangeEst.includes("@ 250 fps"), "Metadata-only restore did not update score or marker-based range speed");
    }));

    await check("a delayed outcome-save callback cannot replace a newer restored result in the open review", () => withHistoryUI(async ({ ui, el, store, saveOutcome }) => {
      const shot = await seedRestoredReview("restore-review-saving", 8);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let hold = true, ready, release;
      const committed = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[1] === "readwrite" && Array.isArray(args[0]) && args[0].includes("shots")) {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      let saving;
      const alert = window.alert;
      window.alert = (message) => { throw new Error(message); };
      try {
        saving = saveOutcome();
        await committed;
        await restoreIntoReview(ui, { shots: [{ ...shot, arrow_score: 3, shot_score: 93 }] });
        assert(el.saveOutcomeBtn.disabled, "Restore unlocked a still-pending outcome save");
        release(); release = null;
        await saving;
        assert((await api.get("shots", shot.id)).arrow_score === 3, "Delayed callback changed the last committed result");
        assert(store.get().formScore === 93 && store.get().reviewInfo.includes("Arrow: 3")
          && el.outcomeScoreButtons.querySelector('[data-outcome-score="3"]').classList.contains("selected"), "Delayed save callback replaced the newer restored result on screen");
      } finally {
        release?.(); if (saving) await saving;
        connection.transaction = transaction;
        window.alert = alert;
      }
    }));

    await check("failed restored-review reads preserve the open draft and report saved data until a successful retry", () => withHistoryUI(async ({ ui, el, store }) => {
      const shot = await seedRestoredReview("restore-review-read-failure", 9);
      await ui.reviewShotTrace(shot);
      el.outcomeDistanceInput.value = "33";
      el.outcomeDistanceInput.dispatchEvent(new Event("input"));
      el.outcomeDistanceInput.focus();
      const trace = store.get().reviewTrace;
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      connection.transaction = function (...args) {
        if (args[1] === "readonly" && Array.isArray(args[0]) && args[0].includes("shot_traces")) throw new Error("Review snapshot unavailable");
        return transaction.apply(this, args);
      };
      try {
        const status = await restoreIntoReview(ui, { shots: [{ ...shot, shot_score: 92 }] });
        assert(status.startsWith("Imported") && status.includes("could not refresh"), "Review read failure mislabeled the committed import or hid its incomplete refresh");
        assert((await api.get("shots", shot.id)).shot_score === 92, "Review read failure lost the restored record");
        assert(store.get().reviewTrace === trace && store.get().formScore === 25 && el.outcomeDistanceInput.value === "33"
          && document.activeElement === el.outcomeDistanceInput, "Review read failure replaced the snapshot, draft or focus");
      } finally { connection.transaction = transaction; }
      assert(await ui.refreshSavedData() === true && store.get().formScore === 92, "Review retry did not load the saved data");
      assert(el.outcomeDistanceInput.value === "33", "Successful review retry replaced the retained draft");
    }));

    await check("a delayed restored-review snapshot cannot reopen a closed review or replace a newly selected capture", async () => {
      for (const switchCapture of [false, true]) await withHistoryUI(async ({ ui, el, store }) => {
        const shot = await seedRestoredReview(`restore-review-cancel-${switchCapture}`, 10);
        const next = { ...shot, id: `restore-review-switch-${switchCapture}`, shot_score: 87 };
        await api.saveCapture(next, rangeTrace(next.id));
        await ui.reviewShotTrace(shot);
        const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
        const transaction = connection.transaction;
        let hold = true, ready, release;
        const captured = new Promise((resolve) => { ready = resolve; });
        connection.transaction = function (...args) {
          const tx = transaction.apply(this, args);
          if (hold && args[1] === "readonly" && Array.isArray(args[0]) && args[0].includes("shot_traces")) {
            hold = false;
            Object.defineProperty(tx, "oncomplete", { set(handler) {
              tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
            } });
          }
          return tx;
        };
        let refreshing;
        try {
          refreshing = ui.refreshSavedData();
          await captured;
          if (switchCapture) await ui.reviewShotTrace(next);
          else el.exitReviewBtn.click();
          release(); release = null;
          await refreshing;
          assert(switchCapture ? store.get().reviewShotId === next.id && store.get().formScore === 87 : !store.get().reviewMode,
            "Delayed restore refresh replaced the current review choice");
        } finally {
          release?.(); if (refreshing) await refreshing;
          connection.transaction = transaction;
        }
      });
    });

    await check("restoring an arrow as a hold hides its arrow-result editor and excludes it from scoring progress", () => withHistoryUI(async ({ ui, el, store, saveOutcome }) => {
      const shot = await seedRestoredReview("restore-review-to-hold", 11);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      await restoreIntoReview(ui, { shots: [{ ...shot, capture_kind: "hold", arrow_score: null }] });
      assert(store.get().reviewCaptureKind === "hold" && el.reviewOutcomePanel.classList.contains("hidden"), "Restored hold retained the arrow-result form");
      await saveOutcome();
      assert((await api.get("shots", shot.id)).arrow_score === null, "Hidden outcome form saved a draft score onto the restored hold");
    }));

    await check("Save and Next uses the current restored session when a pending save gains another arrow", () => withHistoryUI(async ({ ui, el, store, saveOutcome }) => {
      const shot = await seedRestoredReview("restore-review-next", 12);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      const next = { id: "restore-review-next-added", sample: true, capture_kind: "arrow", timestamp: "2110-01-12T12:00:10Z" };
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let hold = true, ready, release;
      const committed = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[1] === "readwrite" && Array.isArray(args[0]) && args[0].includes("shots")) {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      let saving;
      try {
        saving = saveOutcome({ advance: true });
        await committed;
        await restoreIntoReview(ui, { shots: [next], shot_traces: [rangeTrace(next.id)] });
        release(); release = null;
        await saving;
        assert(store.get().reviewMode && store.get().reviewShotId === next.id && el.reviewArrowProgress.textContent.includes("Arrow 2 of 2"), "Save and Next finished an outdated one-arrow session");
        assert((await api.get("shots", shot.id)).arrow_score === 9, "Advancing lost the committed result");
      } finally {
        release?.(); if (saving) await saving;
        connection.transaction = transaction;
      }
    }));

    await check("a committed outcome remains saved when refreshing its review snapshot fails", () => withHistoryUI(async ({ ui, el, saveOutcome }) => {
      const shot = await seedRestoredReview("restore-review-save-refresh-failure", 13);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="8"]').click();
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      const alert = window.alert;
      let alerts = 0;
      window.alert = () => { alerts++; };
      connection.transaction = function (...args) {
        if (args[1] === "readonly" && Array.isArray(args[0]) && args[0].includes("shot_traces")) throw new Error("Saved review unavailable");
        return transaction.apply(this, args);
      };
      try {
        await saveOutcome();
        assert((await api.get("shots", shot.id)).arrow_score === 8, "Post-save read failure lost the arrow result");
        assert(el.reviewOutcomeStatus.textContent.startsWith("Result saved locally") && alerts === 0 && !el.saveOutcomeBtn.disabled,
          "Post-save read failure presented a failed save or left its controls locked");
      } finally { connection.transaction = transaction; window.alert = alert; }
      assert(await ui.refreshSavedData() === true && el.outcomeScoreButtons.querySelector('[data-outcome-score="8"]').classList.contains("selected"), "Review retry did not display the committed outcome");
    }));

    await check("failed comparison refreshes report a saved import and a retry loads the restored trace", () => withHistoryUI(async ({ ui, el, store }) => {
      const primary = await seedRestoredReview("restore-review-compare-failure-primary", 14);
      const compared = { ...primary, id: "restore-review-compare-failure", label: "Compare failure" };
      await api.saveCapture(compared, rangeTrace(compared.id));
      await ui.reviewShotTrace(primary);
      const loaded = new Promise((resolve) => {
        const unsubscribe = store.subscribe((current) => { if (current.compareShotId === compared.id) { unsubscribe(); resolve(); } });
      });
      el.reviewCompareSelect.value = compared.id;
      el.reviewCompareSelect.dispatchEvent(new Event("change"));
      await loaded;
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let reads = 0;
      connection.transaction = function (...args) {
        if (args[1] === "readonly" && Array.isArray(args[0]) && args[0].includes("shot_traces") && ++reads === 2) throw new Error("Comparison unavailable");
        return transaction.apply(this, args);
      };
      try {
        const status = await restoreIntoReview(ui, { shot_traces: [{ shot_id: compared.id, sample_rate_hz: 20, payload: [{ tUs: 0, az: 2 }, { tUs: 50000, az: 3 }] }] });
        assert(status.startsWith("Imported") && status.includes("could not refresh"), "Failed comparison refresh was hidden or presented as a failed import");
        assert((await api.get("shot_traces", compared.id)).payload[0].az === 2, "Comparison refresh failure lost the restored trace");
      } finally { connection.transaction = transaction; }
      assert(await ui.refreshSavedData() === true && store.get().compareTrace[0].az === 2, "Comparison retry did not load the stored trace");
    }));

    await check("sync failures after a committed outcome do not present a failed save", () => withHistoryUI(async ({ ui, el, saveOutcome }) => {
      const shot = { ...await seedRestoredReview("restore-review-save-sync-failure", 15), sample: false };
      await api.put("shots", shot);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="8"]').click();
      const alert = window.alert;
      let alerts = 0;
      window.alert = () => { alerts++; };
      try {
        await saveOutcome();
        assert((await api.get("shots", shot.id)).arrow_score === 8 && el.reviewOutcomeStatus.textContent.startsWith("Saved") && alerts === 0,
          "Sync failure mislabeled a committed outcome");
        assert((await api.getAll("sync_queue")).some((task) => task.targetId === shot.id && task.payload?.arrow_score === 8), "Sync failure lost the committed upload work");
      } finally { window.alert = alert; }
    }, { syncAdapter: { triggerSync() { throw new Error("Sync unavailable"); } } }));

    await check("failed outcome transactions retain the real form's draft and a successful retry commits it", () => withHistoryUI(async ({ ui, el, saveOutcome }) => {
      const shot = { ...await seedRestoredReview("restore-review-outcome-retry", 16), sample: false };
      await api.put("shots", shot);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      el.outcomeDistanceInput.value = "32";
      el.outcomeDistanceInput.dispatchEvent(new Event("input"));
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      observeTransactions(connection);
      const alert = window.alert;
      window.alert = () => {};
      try {
        abortNextWrite = "sync_queue";
        await saveOutcome();
        assert((await api.get("shots", shot.id)).arrow_score === 7, "Failed UI save committed an arrow score without its upload");
        assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').classList.contains("selected") && el.outcomeDistanceInput.value === "32"
          && !el.saveOutcomeBtn.disabled && el.reviewOutcomeStatus.textContent.startsWith("Save failed"), "Failed save lost its draft or retry");
        await saveOutcome();
        const saved = await api.get("shots", shot.id);
        assert(saved.arrow_score === 9 && saved.target_distance === 32 && el.reviewOutcomeStatus.textContent.startsWith("Saved"), "Retry did not save the retained draft");
        assert((await api.getAll("sync_queue")).filter((task) => task.targetId === shot.id && task.payload?.arrow_score === 9).length === 1, "Retry duplicated the result's upload work");
      } finally { window.alert = alert; }
    }));
    async function withExportDownloads(run) {
      const create = URL.createObjectURL;
      const revoke = URL.revokeObjectURL;
      const click = HTMLAnchorElement.prototype.click;
      const clickDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "click");
      const alert = window.alert;
      const blobs = new Map(), downloads = [], alerts = [];
      URL.createObjectURL = (blob) => { const url = create.call(URL, blob); blobs.set(url, blob); return url; };
      HTMLAnchorElement.prototype.click = function () {
        if (this.download.startsWith("openfloat-")) {
          downloads.push({ filename: this.download, url: this.href, blob: blobs.get(this.href) });
        } else click.call(this);
      };
      window.alert = (message) => alerts.push(message);
      try { await run({ downloads, alerts }); }
      finally {
        URL.createObjectURL = create;
        if (clickDescriptor) Object.defineProperty(HTMLAnchorElement.prototype, "click", clickDescriptor);
        else delete HTMLAnchorElement.prototype.click;
        window.alert = alert;
        for (const url of blobs.keys()) revoke.call(URL, url);
      }
    }

    await check("single-shot export accepts undated captures and remains restorable", () => withHistoryUI(async ({ ui }) => {
      const shot = { id: "export-undated", sample: true, capture_kind: "hold", label: "Undated imported hold" };
      await api.saveCapture(shot, { shot_id: shot.id, payload: [{ az: 1 }, { az: 2 }] });
      await withExportDownloads(async ({ downloads, alerts }) => {
        await ui.exportSingleShot(shot.id);
        assert(downloads.length === 1 && downloads[0].filename.includes("undated"), "Undated capture could not be downloaded");
        assert(alerts.length === 0, "Undated export showed a failure alert");
        const payload = JSON.parse(await downloads[0].blob.text());
        assert(payload.format === "openfloat-shot-export" && payload.version === 1 && payload.shot.id === shot.id
          && payload.trace.shot_id === shot.id, "Single-shot export changed its portable format");
        await api.removeSavedShots([shot.id]);
        await api.importAllData(payload);
        assert((await api.get("shots", shot.id)).label === shot.label && (await api.get("shot_traces", shot.id)).payload[1].az === 2,
          "Undated single-shot file could not restore its capture and trace");
      });
    }));

    await check("single-shot export keeps metadata and trace together during a concurrent save", () => withHistoryUI(async ({ ui }) => {
      const shot = { id: "export-single-snapshot", sample: true, timestamp: "2110-02-01T12:00:00Z", label: "Before" };
      await api.saveCapture(shot, { shot_id: shot.id, payload: [{ ax: 1 }] });
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let concurrent;
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === "readonly") {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            if (name === "shots") {
              const get = store.get.bind(store);
              store.get = (...keys) => {
                const request = get(...keys);
                request.addEventListener("success", () => {
                  if (!concurrent) concurrent = api.saveCapture({ ...shot, label: "After" }, { shot_id: shot.id, payload: [{ ax: 2 }] });
                }, { once: true });
                return request;
              };
            }
            return store;
          };
        }
        return tx;
      };
      try {
        await withExportDownloads(async ({ downloads }) => {
          await ui.exportSingleShot(shot.id);
          assert(!!concurrent && downloads.length === 1, "Concurrent capture save or export did not start");
          await concurrent;
          const payload = JSON.parse(await downloads[0].blob.text());
          assert(payload.shot.label === "Before" && payload.trace.payload[0].ax === 1, "Single export mixed earlier metadata with a later trace");
        });
      } finally { connection.transaction = transaction; }
    }));

    await check("shot download URLs remain readable while the browser starts the file", () => withHistoryUI(async ({ ui }) => {
      const shot = { id: "export-url-lifetime", sample: true, timestamp: "2110-02-02T12:00:00Z" };
      await api.saveCapture(shot, { shot_id: shot.id, payload: [{ az: 1 }] });
      await withExportDownloads(async ({ downloads }) => {
        await ui.exportSingleShot(shot.id);
        assert(downloads.length === 1, "No shot download was prepared");
        const payload = await (await fetch(downloads[0].url)).json();
        assert(payload.shot.id === shot.id && payload.trace.shot_id === shot.id, "Download URL was released before its JSON could be read");
      });
    }));

    await check("single-shot snapshots allow missing traces and reject absent metadata without queue changes", async () => {
      const shot = { id: "export-metadata-only", sample: true, label: "Imported metadata" };
      await api.saveCapture(shot);
      await api.put("shot_traces", { shot_id: "export-orphan", payload: [{ az: 1 }] });
      const before = (await api.getAll("sync_queue")).length;
      const payload = await api.exportShotData(shot.id);
      assert(payload.trace === null && payload.shot.label === shot.label, "Metadata-only export fabricated a trace or omitted the capture");
      assert(api.normalizeImportPayload(payload).stores.shot_traces.length === 0, "Metadata-only file cannot be imported");
      await rejects(() => api.exportShotData("export-orphan"));
      assert((await api.getAll("sync_queue")).length === before, "Readonly exports changed the upload queue");
    });

    await check("single-shot exports stay locked through snapshot and download, ignore repeats, and restore row focus", async () => {
      let releaseDownload, started;
      const downloading = new Promise((resolve) => { releaseDownload = resolve; });
      const began = new Promise((resolve) => { started = resolve; });
      const downloads = [];
      await withHistoryUI(async ({ ui, el, exportSelected }) => {
        const shot = { id: "export-pending-row", sample: true, capture_kind: "arrow", timestamp: "2110-02-03T12:00:00Z" };
        await api.saveCapture(shot, { shot_id: shot.id, payload: [{ az: 1 }] });
        await ui.loadShotHistoryList();
        await ui.reviewShotTrace(shot);
        el.historySelectModeBtn.click();
        const checkbox = el.historyList.querySelector(`[data-shot-id="${shot.id}"].history-item-checkbox`);
        checkbox.click();
        assert(el.bulkSelectCount.textContent === "1 selected", "Capture was not selected before the export");
        const rowButton = el.historyList.querySelector(`[data-shot-id="${shot.id}"] .history-item-export-btn`);
        rowButton.focus();
        const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
        const transaction = connection.transaction;
        let hold = true, releaseRead, ready, reads = 0;
        const committed = new Promise((resolve) => { ready = resolve; });
        connection.transaction = function (...args) {
          const tx = transaction.apply(this, args);
          if (args[1] === "readonly" && Array.isArray(args[0]) && args[0].length === 2 && args[0].includes("shots")) {
            reads++;
            if (hold) {
              hold = false;
              Object.defineProperty(tx, "oncomplete", { set(handler) {
                tx.addEventListener("complete", (event) => { releaseRead = () => handler(event); ready(); });
              } });
            }
          }
          return tx;
        };
        let exporting;
        try {
          exporting = ui.exportSingleShot(shot.id, rowButton);
          await committed;
          assert(el.exportShotBtn.disabled && el.bulkExportBtn.disabled && el.bulkDeleteBtn.disabled && rowButton.disabled,
            "Pending single export left conflicting controls enabled");
          await ui.exportSingleShot(shot.id, rowButton);
          await exportSelected();
          await ui.deleteSavedShot(shot.id);
          await ui.loadShotHistoryList();
          assert([...el.historyList.querySelectorAll(".history-item-export-btn,.history-item-delete-btn")].every((button) => button.disabled),
            "History refresh unlocked a pending export");
          assert(reads === 1 && !!await api.get("shots", shot.id), "Repeated actions started another export or deleted the capture");
          releaseRead(); releaseRead = null;
          await began;
          assert(downloads.length === 1 && el.exportShotBtn.disabled && el.reviewExportStatus.textContent.startsWith("Preparing"),
            "Download preparation unlocked the export or duplicated the file");
          releaseDownload();
          const payload = await exporting;
          assert(payload.shot.id === shot.id && !el.exportShotBtn.disabled && !el.bulkExportBtn.disabled && !el.bulkDeleteBtn.disabled,
            "Completed export did not return its frozen payload or unlock controls");
          const current = el.historyList.querySelector(`[data-shot-id="${shot.id}"] .history-item-export-btn`);
          assert(document.activeElement === current && el.reviewExportStatus.textContent.startsWith("Exported"), "Export lost row focus after a refresh or omitted its result");
        } finally { releaseRead?.(); releaseDownload(); if (exporting) await exporting; connection.transaction = transaction; }
      }, { download: (payload, filename) => { downloads.push({ payload, filename }); started(); return downloading; } });
    });

    await check("single-shot read and download failures report inline, retain target edits, and retry once", async () => {
      for (const phase of ["read", "download"]) {
        let failing = true;
        const downloads = [], alerts = [];
        await withHistoryUI(async ({ ui, el }) => {
          const shot = { id: `export-retry-${phase}`, sample: true, capture_kind: "arrow", timestamp: "2110-02-04T12:00:00Z" };
          await api.saveCapture(shot);
          await ui.reviewShotTrace(shot);
          el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
          el.outcomeDistanceInput.value = "38";
          el.outcomeDistanceInput.dispatchEvent(new Event("input"));
          const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
          const transaction = connection.transaction;
          const alert = window.alert;
          window.alert = (message) => alerts.push(message);
          connection.transaction = function (...args) {
            if (failing && phase === "read" && args[1] === "readonly" && Array.isArray(args[0]) && args[0].length === 2) throw new Error("Snapshot unavailable");
            return transaction.apply(this, args);
          };
          try {
            await ui.exportSingleShot(shot.id, el.exportShotBtn);
            assert(el.reviewExportStatus.textContent.startsWith("Export failed") && !el.exportShotBtn.disabled && alerts.length === 0,
              "Export failure was modal, hidden, or left the control locked");
            assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').classList.contains("selected") && el.outcomeDistanceInput.value === "38",
              "Failed export changed the unfinished arrow result");
            failing = false;
            const payload = await ui.exportSingleShot(shot.id, el.exportShotBtn);
            assert(payload.shot.id === shot.id && payload.trace === null && downloads.length === 1
              && el.reviewExportStatus.textContent.includes("without a saved trace"), "Retry did not export the metadata-only capture exactly once");
          } finally { connection.transaction = transaction; window.alert = alert; }
        }, { download(payload, filename) {
          if (failing && phase === "download") throw new Error("Download unavailable");
          downloads.push({ payload, filename });
        } });
      }
    });

    await check("a finished export does not change another review's status or keyboard focus", async () => {
      let release, began;
      const downloading = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { began = resolve; });
      const downloads = [];
      await withHistoryUI(async ({ ui, el, store }) => {
        const first = { id: "export-review-first", sample: true, capture_kind: "arrow", timestamp: "2110-02-05T12:00:00Z" };
        const second = { ...first, id: "export-review-second", timestamp: "2110-02-05T12:00:10Z" };
        await api.saveCapture(first);
        await api.saveCapture(second);
        await ui.reviewShotTrace(first);
        el.exportShotBtn.focus();
        const exporting = ui.exportSingleShot(first.id, el.exportShotBtn);
        try {
          await started;
          await ui.reviewShotTrace(second);
          el.outcomeDistanceInput.focus();
          assert(!el.reviewExportStatus.textContent && el.exportShotBtn.disabled, "New review showed the older pending export or unlocked it");
          release();
          await exporting;
          assert(store.get().reviewShotId === second.id && !el.reviewExportStatus.textContent && document.activeElement === el.outcomeDistanceInput,
            "An older export completion changed the newer review or stole focus");
          assert(downloads.length === 1 && downloads[0].shot.id === first.id, "Pending export switched to the newly reviewed capture");
        } finally { release(); await exporting; }
      }, { download: (payload) => { downloads.push(payload); began(); return downloading; } });
    });

    await check("selected exports freeze their clicked selection and preserve a newer selection and its focus", async () => {
      let release, began;
      const downloading = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { began = resolve; });
      const downloads = [];
      await withHistoryUI(async ({ ui, el, exportSelected }) => {
        const first = { id: "export-selection-first", sample: true, timestamp: "2110-02-06T12:00:00Z" };
        const second = { ...first, id: "export-selection-second", timestamp: "2110-02-06T12:00:10Z" };
        await api.saveCapture(first);
        await api.saveCapture(second);
        await ui.loadShotHistoryList();
        el.historySelectModeBtn.click();
        const select = (id, checked) => {
          const checkbox = el.historyList.querySelector(`[data-shot-id="${id}"].history-item-checkbox`);
          if (checkbox.checked !== checked) checkbox.click();
          return checkbox;
        };
        select(first.id, true);
        assert(el.bulkSelectCount.textContent === "1 selected", "Capture was not selected before the export");
        el.bulkExportBtn.focus();
        const exporting = exportSelected();
        try {
          await started;
          select(first.id, false);
          select(second.id, true).focus();
          await exportSelected();
          await ui.exportSingleShot(second.id);
          await ui.deleteSavedShot(second.id);
          await ui.loadShotHistoryList();
          assert(el.bulkExportBtn.disabled && el.bulkDeleteBtn.disabled && downloads.length === 1, "Selected export did not keep its operation guard across a refresh");
          const focused = el.historyList.querySelector(`[data-shot-id="${second.id}"].history-item-checkbox`);
          assert(document.activeElement === focused && !!await api.get("shots", second.id), "Pending export lost a newer selection's focus or allowed deletion");
          release();
          const payload = await exporting;
          assert(payload.stores.shots.length === 1 && payload.stores.shots[0].id === first.id, "Selected file used a later checkbox selection");
          assert(el.bulkSelectCount.textContent === "1 selected" && focused.checked && !el.bulkExportBtn.disabled && document.activeElement === focused,
            "Completed export changed the newer selection or moved focus to the export button");
        } finally { release(); await exporting; }
      }, { download: (payload, filename) => { downloads.push({ payload, filename }); began(); return downloading; } });
    });

    await check("selected downloads remain readable and contain only their clicked capture", () => withHistoryUI(async ({ ui, el, exportSelected }) => {
      const shot = { id: "export-selected-url", sample: true, timestamp: "2110-02-07T12:00:00Z" };
      await api.saveCapture(shot);
      await ui.loadShotHistoryList();
      el.historySelectModeBtn.click();
      const checkbox = el.historyList.querySelector(`[data-shot-id="${shot.id}"].history-item-checkbox`);
      checkbox.click();
      assert(el.bulkSelectCount.textContent === "1 selected", "Capture was not selected before the export");
      await withExportDownloads(async ({ downloads }) => {
        await exportSelected();
        assert(downloads.length === 1 && downloads[0].filename.startsWith("openfloat-selected-"), "Selected download was not prepared");
        const payload = await (await fetch(downloads[0].url)).json();
        assert(payload.format === "openfloat-export" && payload.stores.shots.length === 1 && payload.stores.shots[0].id === shot.id,
          "Selected download was released early or included an unrelated capture");
      });
    }));

    async function withTrainingUI(run, { wallTime = null } = {}) {
      const fixture = document.createElement("div");
      fixture.style.cssText = "position:absolute;left:-10000px;width:1000px";
      const panel = historyMarkup.querySelector("#tabTraining").cloneNode(true);
      panel.classList.remove("hidden-view"); panel.classList.add("active-view");
      fixture.append(panel); document.body.append(fixture);
      const el = Object.fromEntries([...fixture.querySelectorAll("[id]")].map((node) => [node.id, node]));
      const bus = new EventBus();
      const store = createStore({ connected: true, statusMode: "ble", roll: 0, pitch: 0, yaw: 0, cantOffset: 0, pitchOffset: 0 });
      const logs = [], tones = [], notices = [], timers = new Map(), frames = new Map();
      bus.on("log", (message) => logs.push(message));
      let now = 1000, nextId = 0, hidden = false, saving, wallNow = wallTime;
      const properties = new Map();
      const replace = (object, key, value) => {
        properties.set([object, key], Object.getOwnPropertyDescriptor(object, key));
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
      };
      replace(performance, "now", () => now);
      if (wallNow !== null) {
        const NativeDate = window.Date;
        replace(window, "Date", class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [wallNow])); }
          static now() { return wallNow; }
        });
      }
      replace(window, "setInterval", (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay, due: now + delay, interval: true }); return id; });
      replace(window, "setTimeout", (callback, delay) => { const id = ++nextId; timers.set(id, { callback, due: now + delay }); return id; });
      replace(window, "clearInterval", (id) => timers.delete(id));
      replace(window, "clearTimeout", (id) => timers.delete(id));
      replace(window, "requestAnimationFrame", (callback) => { const id = ++nextId; frames.set(id, callback); return id; });
      replace(window, "cancelAnimationFrame", (id) => frames.delete(id));
      replace(window, "alert", (message) => notices.push(message));
      replace(window, "AudioContext", class {
        currentTime = 0; destination = {};
        createOscillator() { return { frequency: { value: 0 }, connect() {}, start() { tones.push(this.frequency.value); }, stop() {}, set onended(callback) { callback(); } }; }
        createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
        close() {}
      });
      replace(document, "hidden", false);
      replace(document, "visibilityState", "visible");
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
      const listen = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, handler, ...args) {
        if (this === el.saveTrainingShotBtn && type === "click") saving = handler;
        return listen.call(this, type, handler, ...args);
      };
      let ui;
      const advance = (ms, { tick = true } = {}) => {
        now += ms;
        if (wallNow !== null) wallNow += ms;
        if (tick) for (const [id, timer] of [...timers]) {
          if (now < timer.due || !timers.has(id)) continue;
          if (timer.interval) timer.due = now + timer.delay;
          else timers.delete(id);
          timer.callback();
        }
      };
      const sample = (roll = 0, source = "ble") => {
        store.set({ roll, pitch: 0, sample: { source } });
        bus.emit("sample", { source, axMg: 0, ayMg: 0, azMg: 0, gxDps: 0, gyDps: 0, gzDps: 0 });
      };
      const beginHold = () => {
        el.trainingDurationSelect.value = "5";
        el.startTrainingBtn.click();
        for (let index = 0; index < 5; index++) advance(1000);
        assert(!el.trainingTargetWrapper.classList.contains("hidden"), "Hold did not begin after countdown");
      };
      const completeHold = () => {
        beginHold();
        for (let index = 0; index < 49; index++) { advance(100); sample(); }
        advance(100);
        assert(!el.trainingResultsCard.classList.contains("hidden"), "A fully sampled hold did not produce a result");
      };
      const frame = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); } };
      try {
        const { mountTraining } = await import("../app/ui/training.js?v=shot-store-200");
        ui = mountTraining({ store, el, bus });
        EventTarget.prototype.addEventListener = listen;
        await run({ ui, el, store, bus, logs, tones, notices, advance, sample, beginHold, completeHold, frame, frames, timers,
          save: () => saving(new MouseEvent("click")),
          setHidden(value) { hidden = value; document.dispatchEvent(new Event("visibilitychange")); },
          setWallTime(value) { wallNow = value; },
        });
      } finally {
        EventTarget.prototype.addEventListener = listen;
        el.cancelTrainingBtn.click(); el.discardTrainingShotBtn.click(); ui?.destroy();
        timers.clear(); frames.clear(); fixture.remove();
        for (const [[object, key], descriptor] of properties) {
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
        }
      }
    }

    await check("a late browser score updates the training baseline without changing a chosen drill, duration or focus", async () => {
      const shot = { id: "training-late-browser-score", device_id: "OpenFloat-Sensor", timestamp: "2120-01-01T12:00:00Z",
        capture_kind: "arrow", hold_stability: null, level_consistency: null, shot_score: null };
      await api.importAllData(envelope({ shots: [shot] }), { merge: false });
      await withTrainingUI(async ({ el, bus }) => {
        await bus.emitAsync("shot-saved", { localShotId: shot.id });
        assert(el.adaptiveCoachStats.textContent.includes("New baseline"), "Unscored metadata entered the training baseline");
        el.trainingDrillSelect.value = "settle";
        el.trainingDrillSelect.dispatchEvent(new Event("change"));
        el.trainingDurationSelect.value = "20";
        el.trainingDurationSelect.focus();
        const recorder = deviceRecorder();
        recorder.bus = bus;
        recorder.shotTraceBuffer = Array.from({ length: 100 }, (_, index) => ({
          tUs: index * 20000, ax: 0, ay: 0, az: index === 70 ? 16 : 1,
          roll: index % 2 ? 0.1 : 0, pitch: 0, rotDps: 0, lost: 0,
        }));
        assert(await recorder.saveBrowserShotTrace(shot.id, 41801, 1400000, {}, 50, 600, 0) === shot.id,
          "Late browser trace was not committed");
        const scored = await api.get("shots", shot.id);
        assert(Number.isFinite(scored.hold_stability) && Number.isFinite(scored.level_consistency), "Trace did not supply usable training components");
        const baseline = Math.round(Math.min(scored.hold_stability, scored.level_consistency));
        assert(el.adaptiveCoachStats.textContent.includes(`Baseline ${baseline}`), "Committed late scores did not reach the adaptive coach");
        assert(el.trainingDrillSelect.value === "settle" && el.trainingDurationSelect.value === "20"
          && el.trainingReadyTitle.textContent === "Settle & Hold" && document.activeElement === el.trainingDurationSelect,
          "Recommendation refresh replaced chosen settings or keyboard focus");
      });
      await api.removeSavedShots([shot.id]);
    });

    await check("late training recommendations preserve an active hold's drill and target through Save", async () => {
      const shot = { id: "training-late-active-score", timestamp: "2120-01-02T12:00:00Z",
        hold_stability: 80, level_consistency: 30 };
      await api.importAllData(envelope({ shots: [shot] }), { merge: false });
      await withTrainingUI(async ({ el, bus, beginHold, sample, advance, save }) => {
        await bus.emitAsync("shot-saved", { localShotId: shot.id });
        assert(el.trainingReadyTitle.textContent === "Level Lock" && el.trainingReadyText.textContent.includes("Target score: 35"), "Initial adaptive drill did not use its saved baseline");
        el.startTrainingBtn.focus(); beginHold(); sample();
        const cue = el.trainingPhaseLabel.textContent;
        await api.saveShotTrace({ shot_id: shot.id, source: "browser", payload: [{ tUs: 0, az: 1 }] },
          { hold_stability: 20, level_consistency: 90 });
        await bus.emitAsync("shot-trace-saved", { localShotId: shot.id });
        assert(el.adaptiveCoachTitle.textContent === "Tighten your aiming hold" && el.adaptiveCoachStats.textContent.includes("Baseline 20"),
          "Late trace did not update the next recommendation during a hold");
        assert(el.trainingReadyTitle.textContent === "Level Lock" && el.trainingPhaseLabel.textContent === cue
          && el.trainingHoldTimerBadge.textContent === "5.0s" && el.trainingDurationSelect.disabled
          && document.activeElement === el.cancelTrainingBtn, "Late recommendation restarted or changed the active drill");
        for (let index = 0; index < 49; index++) { advance(100); sample(); }
        advance(100);
        assert(el.resultScoreLabel.textContent === "Level Lock Score" && el.resultCoachingText.textContent.includes("Goal: 35"),
          "Completed hold used the next drill's scoring rule or target");
        const id = await save();
        assert((await api.get("shots", id)).label === "Level Lock Hold (5s)", "Save relabeled the completed drill");
        assert(el.trainingReadyTitle.textContent === "Steady Aim" && el.trainingDurationSelect.value === "5",
          "Next idle drill did not use the refreshed recommendation or reset the chosen duration");
      });
      await api.removeSavedShots([shot.id]);
    });

    await check("a late trace recommendation wins over an older held metadata refresh", async () => {
      const shot = { id: "training-late-read-order", timestamp: "2120-01-03T12:00:00Z",
        hold_stability: 80, level_consistency: 30 };
      await api.importAllData(envelope({ shots: [shot] }), { merge: false });
      await withTrainingUI(async ({ el, bus }) => {
        await bus.emitAsync("shot-saved", { localShotId: shot.id });
        const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
        const transaction = connection.transaction;
        let hold = true, ready, release, stale;
        const readComplete = new Promise((resolve) => { ready = resolve; });
        connection.transaction = function (...args) {
          const tx = transaction.apply(this, args);
          if (hold && args[0] === "shots" && args[1] === "readonly") {
            hold = false;
            Object.defineProperty(tx, "oncomplete", { set(handler) {
              tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
            } });
          }
          return tx;
        };
        try {
          stale = bus.emitAsync("shot-saved", { localShotId: shot.id });
          await readComplete;
          await api.saveShotTrace({ shot_id: shot.id, source: "browser", payload: [{ tUs: 0, az: 1 }] },
            { hold_stability: 20, level_consistency: 90 });
          await bus.emitAsync("shot-trace-saved", { localShotId: shot.id });
          assert(el.adaptiveCoachTitle.textContent === "Tighten your aiming hold" && el.adaptiveCoachStats.textContent.includes("Baseline 20"),
            "Committed trace did not refresh the recommendation while an older read was pending");
          release(); release = null;
          await stale;
          assert(el.adaptiveCoachTitle.textContent === "Tighten your aiming hold" && el.adaptiveCoachStats.textContent.includes("Baseline 20"),
            "An older metadata read replaced the late trace's recommendation");
        } finally { release?.(); if (stale) await stale; connection.transaction = transaction; }
      });
      await api.removeSavedShots([shot.id]);
    });

    await check("training countdown follows elapsed seconds after delayed callbacks", () => withTrainingUI(async ({ el, advance }) => {
      el.trainingDurationSelect.value = "5"; el.startTrainingBtn.click();
      advance(1500);
      assert(el.trainingCountdownVal.textContent === "4", "Countdown rounded remaining seconds incorrectly");
      advance(2800);
      assert(el.trainingCountdownVal.textContent === "1", "Delayed countdown callback stretched preparation time");
      advance(700);
      assert(!el.trainingTargetWrapper.classList.contains("hidden") && el.trainingHoldTimerBadge.textContent === "5.0s", "Hold did not start with its full selected duration");
    }));
    await check("hiding the page cancels active training and rejects background starts", () => withTrainingUI(async ({ el, setHidden, advance }) => {
      el.startTrainingBtn.click(); setHidden(true);
      assert(el.trainingDisplayActive.classList.contains("hidden") && !el.startTrainingBtn.classList.contains("hidden"), "Hidden page kept its countdown running");
      el.startTrainingBtn.dispatchEvent(new MouseEvent("click")); advance(10000);
      assert(el.trainingTargetWrapper.classList.contains("hidden") && el.trainingResultsCard.classList.contains("hidden"), "Background action started or completed a hold");
      setHidden(false);
      assert(!el.startTrainingBtn.disabled && el.trainingStatusDesc.textContent.includes("hidden"), "Returning to the page did not offer an explained retry");
    }));
    await check("a few early telemetry frames cannot become a completed training score", () => withTrainingUI(async ({ el, beginHold, sample, advance }) => {
      beginHold();
      for (let index = 0; index < 5; index++) { advance(20); sample(); }
      advance(1500);
      assert(el.trainingTargetWrapper.classList.contains("hidden") && el.trainingResultsCard.classList.contains("hidden"), "Stopped telemetry left a valid-looking hold running");
      assert(!el.startTrainingBtn.disabled && el.trainingStatusDesc.textContent.includes("data paused"), "Missing telemetry had no retry explanation");
    }));
    await check("late samples after the selected hold window cannot change its score", () => withTrainingUI(async ({ el, beginHold, sample, advance }) => {
      beginHold();
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(300, { tick: false }); sample(75); advance(0);
      assert(!el.trainingResultsCard.classList.contains("hidden") && el.resultSteadinessScore.textContent === "100", "A sample received after the hold window changed the result");
    }));

    await check("training requires timely usable telemetry from the start of the hold", () => withTrainingUI(async ({ el, beginHold, sample, advance, tones }) => {
      beginHold();
      for (let index = 0; index < 6; index++) { advance(200); sample(NaN); }
      assert(el.trainingTargetWrapper.classList.contains("hidden") && el.trainingResultsCard.classList.contains("hidden") && !tones.includes(660),
        "Invalid orientation counted as usable telemetry or played a success cue");
      assert(el.trainingStatusDesc.textContent.includes("data paused"), "Missing usable orientation had no interruption explanation");
      beginHold();
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(100);
      assert(!el.trainingResultsCard.classList.contains("hidden") && !el.trainingStatusDesc.textContent.includes("data paused"),
        "A valid retry retained the previous interruption or failed to complete");
    }));

    await check("resumed telemetry cannot conceal a gap while timer callbacks were delayed", () => withTrainingUI(async ({ el, beginHold, sample, advance }) => {
      beginHold();
      for (let index = 0; index < 20; index++) { advance(100); sample(); }
      advance(1100, { tick: false }); sample();
      assert(el.trainingTargetWrapper.classList.contains("hidden") && el.trainingStatusDesc.textContent.includes("data paused"),
        "The first frame after a long interior gap resumed an incomplete hold");
    }));

    await check("leaving Training cancels unfinished holds without restarting them on return", () => withTrainingUI(async ({ el, bus, beginHold, sample, advance, frames, timers }) => {
      beginHold(); advance(100); sample();
      bus.emit("view-changed", "tabHistory");
      assert(el.trainingTargetWrapper.classList.contains("hidden") && frames.size === 0 && timers.size === 0 && el.startTrainingBtn.disabled,
        "Leaving Training kept an unfinished hold or its work running");
      el.startTrainingBtn.dispatchEvent(new MouseEvent("click")); advance(6000);
      bus.emit("view-changed", "tabTraining");
      assert(!el.startTrainingBtn.disabled && el.trainingDisplayActive.classList.contains("hidden") && el.trainingResultsCard.classList.contains("hidden") &&
        el.trainingStatusDesc.textContent.includes("left the Training tab"), "Returning resumed an old hold or omitted retry guidance");
    }));

    await check("page-cache suspension cancels an active hold and returns to an idle retry", () => withTrainingUI(async ({ el, beginHold, sample, advance }) => {
      beginHold(); advance(100); sample();
      window.dispatchEvent(new Event("pagehide"));
      el.startTrainingBtn.dispatchEvent(new MouseEvent("click")); advance(8000);
      window.dispatchEvent(new Event("pageshow"));
      assert(el.trainingTargetWrapper.classList.contains("hidden") && el.trainingResultsCard.classList.contains("hidden") && !el.startTrainingBtn.disabled,
        "A suspended page resumed or completed its unfinished hold");
    }));

    await check("finished training survives view, visibility, page-cache, and connection changes", () => withTrainingUI(async ({ el, store, bus, beginHold, sample, advance, setHidden, tones }) => {
      beginHold();
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(100);
      const result = el.resultSteadinessScore.textContent;
      const completedTones = tones.length;
      bus.emit("view-changed", "tabDashboard"); setHidden(true);
      window.dispatchEvent(new Event("pagehide"));
      store.set({ connected: false, statusMode: "idle" });
      advance(20000); sample(75);
      window.dispatchEvent(new Event("pageshow")); setHidden(false);
      bus.emit("view-changed", "tabTraining");
      assert(!el.trainingResultsCard.classList.contains("hidden") && !el.saveTrainingShotBtn.disabled && el.startTrainingBtn.disabled &&
        el.resultSteadinessScore.textContent === result, "A completed result changed or became unavailable before Save or Dismiss");
      assert(tones.length === completedTones, "Returning played a delayed success tone from the hidden result");
    }));

    await check("saving training retains its result and provenance across hidden-page changes", () => withTrainingUI(async ({ el, store, bus, beginHold, sample, advance, setHidden, save }) => {
      store.set({ statusMode: "demo" });
      const prior = new Set((await api.getAll("shots")).map((shot) => shot.id));
      beginHold();
      for (let index = 0; index < 49; index++) { advance(100); sample(0, "demo"); }
      advance(100);
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let hold = true, began, release;
      const committed = new Promise((resolve) => { began = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[1] === "readwrite") {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); began(); });
          } });
        }
        return tx;
      };
      const saving = save();
      try {
        await committed;
        setHidden(true); bus.emit("view-changed", "tabHistory"); store.set({ connected: false, statusMode: "idle" });
        el.discardTrainingShotBtn.dispatchEvent(new MouseEvent("click")); await save();
        assert(!el.trainingResultsCard.classList.contains("hidden") && el.saveTrainingShotBtn.disabled && el.discardTrainingShotBtn.disabled,
          "A hidden page cleared a saving result or enabled a duplicate save/dismissal");
        release(); release = null; await saving;
        const created = (await api.getAll("shots")).filter((shot) => !prior.has(shot.id));
        assert(created.length === 1 && created[0].sample === true && created[0].device_id === "OpenFloat-Demo" &&
          (await api.get("shot_traces", created[0].id)).source === "sample", "Saving after disconnect duplicated or reclassified a demo hold");
        setHidden(false); bus.emit("view-changed", "tabTraining");
        assert(el.trainingResultsCard.classList.contains("hidden") && el.startTrainingBtn.disabled, "Completed save did not return to the disconnected idle view");
      } finally { release?.(); await saving; connection.transaction = transaction; }
    }));

    await check("a finished training canvas draws once and redraws on resize or theme changes", () => withTrainingUI(async ({ beginHold, sample, advance, frames, frame }) => {
      beginHold(); frame();
      assert(frames.size === 1, "A live hold did not continue drawing");
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(100); frame();
      assert(frames.size === 0, "Finished training kept an animation loop running");
      window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("themechange"));
      assert(frames.size === 1, "Resize/theme changes did not schedule a single result redraw");
      frame(); assert(frames.size === 0, "A static result redraw started another animation loop");
    }));

    await check("training keyboard focus follows Start, Cancel, completion, and Dismiss", () => withTrainingUI(async ({ el, beginHold, sample, advance }) => {
      el.startTrainingBtn.focus(); el.startTrainingBtn.click();
      assert(document.activeElement === el.cancelTrainingBtn, "Start hid the focused control without focusing Cancel");
      el.cancelTrainingBtn.click();
      assert(document.activeElement === el.startTrainingBtn, "Cancel did not return focus to Start");
      beginHold();
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(100);
      assert(document.activeElement === el.saveTrainingShotBtn, "Completed hold did not focus its Save control");
      el.discardTrainingShotBtn.focus(); el.discardTrainingShotBtn.click();
      assert(document.activeElement === el.startTrainingBtn, "Dismiss hid the focused result without returning to Start");
    }));

    await check("unsaved training results warn on reload until the result is dismissed", () => withTrainingUI(async ({ el, beginHold, sample, advance }) => {
      beginHold();
      const activeReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(activeReload);
      assert(!activeReload.defaultPrevented, "An unfinished hold created an unsaved-result warning");
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(100);
      const finishedReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(finishedReload);
      assert(finishedReload.defaultPrevented, "Reload could silently lose a finished training result");
      el.discardTrainingShotBtn.click();
      const dismissedReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(dismissedReload);
      assert(!dismissedReload.defaultPrevented, "Dismissed training still warned about an unsaved result");
    }));

    await check("saved training excludes late movement and preserves measured zero acceleration", () => withTrainingUI(async ({ el, store, beginHold, sample, advance, save, notices }) => {
      const prior = new Set((await api.getAll("shots")).map((shot) => shot.id));
      beginHold();
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(3100, { tick: false }); sample(75);
      assert(!el.trainingResultsCard.classList.contains("hidden"), "A delayed completion rejected a fully sampled hold");
      el.saveTrainingShotBtn.focus(); await save();
      const created = (await api.getAll("shots")).filter((shot) => !prior.has(shot.id));
      assert(created.length === 1 && created[0].capture_kind === "hold" && created[0].stability_score === 100 && created[0].peak_g === 0,
        "Saved hold changed its score, duplicated records, or replaced zero acceleration");
      const trace = await api.get("shot_traces", created[0].id);
      assert(trace.payload.length === 49 && trace.payload.every((point) => point.roll === 0 && point.az === 0) && trace.payload.at(-1).tUs === 4800000,
        "Saved trace included late movement or rewrote the recorded interval");
      assert(document.activeElement === el.startTrainingBtn && notices.length === 0, "Successful save lost keyboard focus or opened a modal alert");
      store.set({ roll: 2 });
      assert(el.trainingStatusDesc.textContent.includes("saved locally"), "A live display update erased the save result");
    }));

    await check("a failed training refresh cannot offer a duplicate save of a committed hold", () => withTrainingUI(async ({ el, bus, beginHold, sample, advance, save, notices }) => {
      const prior = new Set((await api.getAll("shots")).map((shot) => shot.id));
      const stop = bus.on("shot-saved", () => { throw new Error("Training refresh unavailable"); });
      try {
        beginHold();
        for (let index = 0; index < 49; index++) { advance(100); sample(); }
        advance(100); await save(); await save();
        const created = (await api.getAll("shots")).filter((shot) => !prior.has(shot.id));
        assert(created.length === 1 && el.trainingResultsCard.classList.contains("hidden"), "Refresh failure allowed the same committed hold to be saved twice");
        assert(el.trainingStatusDesc.textContent.includes("saved locally") && el.trainingStatusDesc.textContent.includes("Saved Shots") &&
          !notices.some((message) => message.includes("Error saving")), "Committed hold was reported as a storage failure");
      } finally { stop(); }
    }));

    await check("a completed training hold retains its starting BLE sensor through a delayed Save", () => withTrainingUI(async ({ store, completeHold, save }) => {
      store.set({ deviceId: "OpenFloat-BLE:sensor-a" });
      completeHold();
      store.set({ deviceId: "OpenFloat-BLE:sensor-b" });
      const id = await save();
      assert((await api.get("shots", id)).device_id === "OpenFloat-BLE:sensor-a", "Training Save used the replacement sensor");
      const upload = (await api.getAll("sync_queue")).find((task) => task.table === "shots" && task.targetId === id);
      assert(upload.payload.device_id === "OpenFloat-BLE:sensor-a", "Training upload changed the recorded sensor key");
    }));

    await check("delayed training Save keeps the hold in its original practice session", () => withTrainingUI(async ({ completeHold, advance, setHidden, save }) => {
      const practiceEnd = Date.now() + 10000;
      const neighbor = { id: "training-time-neighbor", timestamp: new Date(practiceEnd + 2000).toISOString(), sample: true };
      await api.saveCapture(neighbor);
      completeHold(); setHidden(true); advance(2 * 60 * 60 * 1000); setHidden(false);
      const id = await save(), hold = await api.get("shots", id);
      assert(hold.timestamp === new Date(practiceEnd).toISOString(), "Training timestamp was taken from Save rather than the recorded hold");
      assert(api.groupShotsByTime([neighbor, hold]).length === 1, "Delayed Save split a hold from its neighboring practice captures");
      const upload = (await api.getAll("sync_queue")).find((task) => task.table === "shots" && task.targetId === id);
      assert(upload.payload.timestamp === hold.timestamp && (await api.exportShotData(id)).shot.timestamp === hold.timestamp,
        "Upload or export replaced the recorded hold time");
    }, { wallTime: Date.UTC(2112, 0, 5, 12) }));

    await check("a delayed preparation cue and completion callback preserve the actual scored hold window", () => withTrainingUI(async ({ el, advance, sample, save }) => {
      const started = Date.now();
      el.trainingDurationSelect.value = "5"; el.startTrainingBtn.click(); advance(7000);
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(60000, { tick: false }); sample(75);
      const id = await save(), hold = await api.get("shots", id);
      assert(hold.timestamp === new Date(started + 12000).toISOString(), "A late cue or callback moved the recorded hold's end time");
      const trace = await api.get("shot_traces", id);
      assert(trace.payload.length === 49 && trace.payload.every((point) => point.roll === 0), "Late completion included movement outside the hold window");
    }, { wallTime: Date.UTC(2112, 0, 6, 12) }));

    await check("a wall-clock change during training does not retime its monotonic hold window", () => withTrainingUI(async ({ beginHold, advance, sample, setWallTime, save }) => {
      const practiceEnd = Date.now() + 10000;
      beginHold(); setWallTime(Date.now() - 60 * 60 * 1000);
      for (let index = 0; index < 49; index++) { advance(100); sample(); }
      advance(100); setWallTime(Date.now() + 4 * 60 * 60 * 1000);
      const id = await save();
      assert((await api.get("shots", id)).timestamp === new Date(practiceEnd).toISOString(), "A wall-clock correction changed the recorded hold's timestamp");
    }, { wallTime: Date.UTC(2112, 0, 7, 12) }));

    await check("training retry retains the original recorded timestamp after a failed write", () => withTrainingUI(async ({ completeHold, advance, save }) => {
      const practiceEnd = Date.now() + 10000;
      completeHold(); advance(60 * 60 * 1000);
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let attempted;
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === "readwrite") {
          const shots = tx.objectStore("shots"), put = shots.put.bind(shots);
          shots.put = (record) => {
            attempted = record;
            const request = put(record); request.addEventListener("success", () => tx.abort(), { once: true }); return request;
          };
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => name === "shots" ? shots : objectStore(name);
        }
        return tx;
      };
      try { await save(); }
      finally { connection.transaction = transaction; }
      advance(2 * 60 * 60 * 1000);
      const id = await save(), hold = await api.get("shots", id);
      assert(attempted.timestamp === new Date(practiceEnd).toISOString() && hold.timestamp === attempted.timestamp,
        "A failed attempt or retry moved the hold from its recorded time");
      assert(!await api.get("shots", attempted.id), "Failed timestamp retry left a provisional capture saved");
    }, { wallTime: Date.UTC(2112, 0, 8, 12) }));

    await check("discarded and canceled training timestamps do not carry into a new hold", () => withTrainingUI(async ({ el, completeHold, beginHold, advance, save }) => {
      completeHold(); el.discardTrainingShotBtn.click(); advance(60 * 60 * 1000);
      beginHold(); el.cancelTrainingBtn.click(); advance(60 * 60 * 1000);
      const practiceEnd = Date.now() + 10000;
      completeHold(); advance(60 * 60 * 1000);
      const id = await save();
      assert((await api.get("shots", id)).timestamp === new Date(practiceEnd).toISOString(), "A new hold's timestamp did not match its own recorded window");
    }, { wallTime: Date.UTC(2112, 0, 9, 12) }));

    await check("a broken training log cannot change the saved outcome or enable another save", () => withTrainingUI(async ({ el, bus, beginHold, sample, advance, save }) => {
      const prior = new Set((await api.getAll("shots")).map((shot) => shot.id));
      const stop = bus.on("log", () => { throw new Error("Training log unavailable"); });
      try {
        beginHold();
        for (let index = 0; index < 49; index++) { advance(100); sample(); }
        advance(100); await save().catch(() => {}); await save().catch(() => {});
        const created = (await api.getAll("shots")).filter((shot) => !prior.has(shot.id));
        assert(created.length === 1 && el.trainingResultsCard.classList.contains("hidden") && el.trainingStatusDesc.textContent.includes("saved locally"),
          "A broken log listener changed or duplicated a committed hold");
      } finally { stop(); }
    }));

    for (const event of ["shot-saved", "shot-trace-saved"]) {
      for (const outcome of ["rejects", "reports failure"]) {
        await check(`training stays saved when an asynchronous ${event} listener ${outcome}`, () => withTrainingUI(async ({ el, bus, completeHold, save }) => {
          const prior = new Set((await api.getAll("shots")).map((shot) => shot.id));
          const seen = [];
          const stopFailed = bus.on(event, async () => {
            if (outcome === "rejects") throw new Error("Asynchronous training refresh unavailable");
            return false;
          });
          const stopGood = bus.on(event, (payload) => { seen.push(payload.localShotId); });
          try {
            completeHold(); const id = await save(); await save();
            const created = (await api.getAll("shots")).filter((shot) => !prior.has(shot.id));
            assert(created.length === 1 && created[0].id === id && seen.length === 1 && seen[0] === id,
              "A failed asynchronous listener duplicated the saved hold or prevented another listener's delivery");
            assert(el.trainingResultsCard.classList.contains("hidden") && el.trainingStatusDesc.textContent.includes("saved locally") &&
              el.trainingStatusDesc.textContent.includes("could not refresh"), "An asynchronous refresh failure lost the saved outcome or recovery guidance");
          } finally { stopFailed(); stopGood(); }
        }));
      }
    }

    await check("failed training writes retain the result and roll back metadata, trace, and uploads before retry", () => withTrainingUI(async ({ el, store, bus, completeHold, save, notices }) => {
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      const stopLog = bus.on("log", async () => { throw new Error("Failure log unavailable"); });
      try {
        for (const abortStore of ["shots", "shot_traces", "sync_queue"]) {
          store.set({ connected: true, statusMode: "ble" }); completeHold();
          const prior = new Set((await api.getAll("shots")).map((shot) => shot.id));
          const beforeTraces = (await api.getAll("shot_traces")).length;
          const beforeQueue = (await api.getAll("sync_queue")).length;
          let abortNext = true;
          connection.transaction = function (...args) {
            const tx = transaction.apply(this, args);
            if (abortNext && args[1] === "readwrite") {
              abortNext = false;
              const target = tx.objectStore(abortStore);
              const method = abortStore === "sync_queue" ? "add" : "put";
              const write = target[method].bind(target);
              target[method] = (...values) => {
                const request = write(...values);
                request.addEventListener("success", () => tx.abort(), { once: true });
                return request;
              };
              const objectStore = tx.objectStore.bind(tx);
              tx.objectStore = (name) => name === abortStore ? target : objectStore(name);
            }
            return tx;
          };
          el.saveTrainingShotBtn.focus(); await save();
          assert(document.activeElement === el.saveTrainingShotBtn && !el.saveTrainingShotBtn.disabled && !el.discardTrainingShotBtn.disabled &&
            !el.trainingResultsCard.classList.contains("hidden") && el.trainingDurationSelect.disabled, "Failed write lost its result, locked retry, or changed focus");
          store.set({ connected: false, statusMode: "idle" });
          assert(el.trainingStatusDesc.textContent.includes("Your result is still here") && notices.length === 0, "Failed save feedback was lost or replaced by a modal alert");
          assert((await api.getAll("shots")).length === prior.size && (await api.getAll("shot_traces")).length === beforeTraces &&
            (await api.getAll("sync_queue")).length === beforeQueue, `Aborted ${abortStore} write retained partial data or upload tasks`);
          const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
          assert(reload.defaultPrevented, "An uncommitted retryable result lost reload protection");
          const id = await save();
          const created = (await api.getAll("shots")).filter((shot) => !prior.has(shot.id));
          assert(created.length === 1 && created[0].id === id && (await api.get("shot_traces", id)).payload.length === 49 &&
            (await api.getAll("sync_queue")).length === beforeQueue + 2, "Retry failed to save exactly one complete hold and its uploads");
          assert(el.trainingResultsCard.classList.contains("hidden") && document.activeElement === el.trainingDrillSelect &&
            !el.trainingStatusDesc.textContent.includes("could not refresh"), "A successful retry stayed unsaved or treated logging as a view failure");
        }
      } finally { connection.transaction = transaction; stopLog(); }
    }));

    await check("training stays locked through a pending refresh while the committed result survives page changes", () => withTrainingUI(async ({ el, store, bus, completeHold, save, setHidden, frame, frames }) => {
      let began, release;
      const started = new Promise((resolve) => { began = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      const stop = bus.on("shot-saved", () => { began(); return pending; });
      completeHold(); el.saveTrainingShotBtn.focus(); const saving = save();
      try {
        await started;
        assert(el.trainingStatusDesc.textContent.includes("saved locally") && el.saveTrainingShotBtn.disabled && el.discardTrainingShotBtn.disabled,
          "Pending refresh did not show the committed outcome with guarded actions");
        const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
        assert(!reload.defaultPrevented, "A committed hold warned that reloading would lose an unsaved result");
        el.discardTrainingShotBtn.dispatchEvent(new MouseEvent("click")); await save();
        el.startTrainingBtn.dispatchEvent(new MouseEvent("click")); frame();
        assert(!el.trainingResultsCard.classList.contains("hidden") && el.trainingDisplayActive.classList.contains("hidden") && frames.size === 0,
          "A pending refresh allowed dismissal/new training or kept a static result animating");
        setHidden(true); bus.emit("view-changed", "tabHistory"); store.set({ connected: false, statusMode: "idle" });
        assert(!el.trainingResultsCard.classList.contains("hidden"), "Hiding a committed refresh lost its result");
        setHidden(false); bus.emit("view-changed", "tabTraining"); frame();
        release(false); const id = await saving;
        assert(!!await api.get("shots", id) && el.trainingResultsCard.classList.contains("hidden") &&
          el.trainingStatusDesc.textContent.includes("saved locally") && el.trainingStatusDesc.textContent.includes("could not refresh"),
          "Failed refresh changed a committed hold into a retryable storage failure");
      } finally { release(true); await saving; stop(); }
    }));

    await check("a completed training save preserves focus moved to another control", () => withTrainingUI(async ({ el, bus, completeHold, save }) => {
      let began, release;
      const started = new Promise((resolve) => { began = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      const stop = bus.on("shot-saved", () => { began(); return pending; });
      const other = document.createElement("button"); other.textContent = "Another control"; document.body.append(other);
      completeHold(); el.saveTrainingShotBtn.focus(); const saving = save();
      try {
        await started; other.focus(); release(true); await saving;
        assert(document.activeElement === other, "Completed training save moved focus away from a newer user action");
      } finally { release(true); await saving; stop(); other.remove(); }
    }));

    await check("unmounting during a training refresh keeps its committed hold without updating detached controls", () => withTrainingUI(async ({ ui, el, bus, completeHold, save, frames, timers }) => {
      let began, release;
      const started = new Promise((resolve) => { began = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      let id;
      const stop = bus.on("shot-saved", (payload) => { id = payload.localShotId; began(); return pending; });
      completeHold(); const saving = save();
      try {
        await started; const message = el.trainingStatusDesc.textContent; ui.destroy(); release(false); await saving;
        assert(!!await api.get("shots", id) && el.trainingStatusDesc.textContent === message && el.saveTrainingShotBtn.disabled &&
          frames.size === 0 && timers.size === 0, "Unmounting lost a committed hold or let a late refresh change detached controls");
      } finally { release(true); await saving; stop(); }
    }));

    await check("unmounting training cancels work and removes its page and event listeners", () => withTrainingUI(async ({ ui, el, bus, store, beginHold, advance, frames, timers }) => {
      beginHold(); const status = el.trainingStatusDesc.textContent;
      ui.destroy();
      assert(frames.size === 0 && timers.size === 0, "Unmounted training kept a timer or animation running");
      store.set({ connected: false }); bus.emit("sample", { source: "ble" }); bus.emit("view-changed", "tabHistory");
      window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("resize")); advance(10000);
      assert(el.trainingStatusDesc.textContent === status && frames.size === 0 && timers.size === 0 &&
        [...bus.handlers].every(([name, handlers]) => name === "log" || handlers.size === 0),
        "Detached training responded to a page event or retained subscriptions");
    }));

    async function withSavedDataPeer(run, { messagingBlocked = false } = {}) {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      const marker = crypto.randomUUID();
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Peer database did not open")); }, 5000);
        function receive(event) {
          if (event.source !== frame.contentWindow || event.data?.marker !== marker) return;
          clearTimeout(timeout);
          window.removeEventListener("message", receive);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve();
        }
        window.addEventListener("message", receive);
      });
      const source = new URL("../app/core/db.js?v=shot-store-176", location.href).href;
      frame.srcdoc = `<script type="module">
        const nativeFactory = window.indexedDB;
        Object.defineProperty(window, "indexedDB", { configurable: true,
          value: { open: (_name, version) => nativeFactory.open(${JSON.stringify(testName)}, version) } });
        if (${messagingBlocked}) window.BroadcastChannel = undefined;
        try {
          window.peerApi = await import(${JSON.stringify(source)});
          window.peerConnection = await window.peerApi.initDb();
          window.peerSavedData = await import(${JSON.stringify(new URL("../app/core/saved-data.js?v=shot-store-174", location.href).href)});
          parent.postMessage({ marker: ${JSON.stringify(marker)} }, ${JSON.stringify(location.origin)});
        } catch (error) {
          parent.postMessage({ marker: ${JSON.stringify(marker)}, error: error.message }, ${JSON.stringify(location.origin)});
        }
      <\/script>`;
      document.body.append(frame);
      try { await ready; await run(frame.contentWindow.peerApi, frame.contentWindow.peerSavedData); }
      finally { frame.contentWindow.peerConnection?.close(); frame.remove(); }
    }

    async function withWatchedViews(refresh, run) {
      const { watchSavedData } = await import("../app/core/saved-data.js?v=shot-store-174");
      const viewDocument = new EventTarget();
      viewDocument.hidden = false;
      const viewWindow = new EventTarget();
      viewWindow.setTimeout = window.setTimeout.bind(window);
      viewWindow.clearTimeout = window.clearTimeout.bind(window);
      const errors = [];
      let waiter;
      const stop = watchSavedData(testName, async (stores) => {
        const result = await refresh(stores);
        if (result === false || Array.isArray(result) && result.includes(false)) throw new Error("Saved views did not refresh");
        waiter?.resolve();
      }, { document: viewDocument, window: viewWindow, onError: (error) => { errors.push(error); waiter?.reject(error); } });
      async function refreshOnce(action) {
        const refreshed = new Promise((resolve, reject) => { waiter = { resolve, reject }; });
        refreshed.catch(() => {});
        const timeout = setTimeout(() => waiter?.reject(new Error("Views did not receive the peer change")), 5000);
        try { await action(); await refreshed; }
        finally { clearTimeout(timeout); waiter = null; }
      }
      try { await run({ viewWindow, viewDocument, errors, refreshOnce }); }
      finally { stop(); }
    }

    async function withCommitNotices(run) {
      const channel = new BroadcastChannel(`openfloat:saved-data:${testName}`);
      const notices = [];
      channel.addEventListener("message", ({ data }) => notices.push(data));
      const next = (store) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { channel.removeEventListener("message", receive); reject(new Error("Committed change was not announced")); }, 5000);
        function receive({ data }) {
          if (!data.stores?.includes(store)) return;
          clearTimeout(timeout);
          channel.removeEventListener("message", receive);
          resolve(data);
        }
        channel.addEventListener("message", receive);
      });
      try { await run({ notices, next }); }
      finally { channel.close(); }
    }

    await check("peer capture notices contain only committed store names", () => withCommitNotices(async ({ next }) => {
      await withSavedDataPeer(async (peer) => {
        const notice = next("shots");
        const shot = { id: "peer-committed", label: "Private capture label", sample: true };
        await peer.saveCapture(shot, { shot_id: shot.id, payload: [{ az: 1 }, { az: 2 }] });
        const message = await notice;
        assert(message.version === 1 && Object.keys(message).sort().join() === "stores,version", "Notice exposed capture data");
        assert(new Set(message.stores).size === 2 && message.stores.includes("shots") && message.stores.includes("shot_traces"), "Notice included unrelated stores");
        assert((await api.get("shots", shot.id)).label === shot.label && (await api.get("shot_traces", shot.id)).payload.length === 2,
          "Notification arrived without its committed metadata and trace");
      });
    }));

    await check("aborted peer writes do not announce or retain provisional captures", () => withCommitNotices(async ({ notices, next }) => {
      await withSavedDataPeer(async (peer, messages) => {
        const connection = await peer.initDb();
        const transaction = connection.transaction;
        connection.transaction = function (...args) {
          const tx = transaction.apply(this, args);
          if (args[1] === "readwrite") {
            const store = tx.objectStore("sync_queue");
            const add = store.add.bind(store);
            store.add = (...values) => {
              const request = add(...values);
              request.addEventListener("success", () => tx.abort(), { once: true });
              return request;
            };
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = (name) => name === "sync_queue" ? store : objectStore(name);
          }
          return tx;
        };
        try {
          await rejects(() => peer.saveCapture({ id: "peer-rolled-back" }, { shot_id: "peer-rolled-back", payload: [{ az: 1 }] }));
        } finally { connection.transaction = transaction; }
        const barrier = next("sessions");
        messages.publishSavedDataChange(testName, ["sessions"]);
        await barrier;
        assert(notices.length === 1 && notices[0].stores.join() === "sessions", "Rolled-back write produced a change notice");
        assert(!await api.get("shots", "peer-rolled-back") && !await api.get("shot_traces", "peer-rolled-back"), "Peer abort left partial capture data");
      });
    }));

    await check("peer reads and upload status changes produce no saved-view notices", () => withCommitNotices(async ({ notices, next }) => {
      await withSavedDataPeer(async (peer, messages) => {
        const id = await peer.put("sync_queue", { status: "pending", table: "shots", targetId: "peer-status-only" });
        await peer.updateSyncTaskStatus(id, "done");
        await peer.getAll("shots");
        await peer.readSavedReview("peer-committed");
        const barrier = next("sessions");
        messages.publishSavedDataChange(testName, ["sessions"]);
        await barrier;
        assert(notices.length === 1 && notices[0].stores.join() === "sessions", "A read or sync-status update triggered a refresh loop");
      });
    }));

    await check("another tab's committed restore refreshes the open review", () => withHistoryUI(async ({ ui, store, el }) => {
      const shot = await seedRestoredReview("restore-review-peer", 17);
      await ui.reviewShotTrace(shot);
      await withWatchedViews(() => ui.refreshSavedData(), async ({ refreshOnce }) => {
        await withSavedDataPeer(async (peer) => {
          await refreshOnce(() => peer.importAllData(envelope({ shots: [{ ...shot, shot_score: 94,
            arrow_score: 8, target_distance: 30, target_distance_unit: "yd", target_face_cm: 80 }] })));
          assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="8"]').classList.contains("selected"), "Review did not receive the peer restore");
          assert(store.get().formScore === 94, "Review retained the older float score");
          assert(el.outcomeDistanceInput.value === "30", "Review retained the older target context");
        });
      });
    }));

    await check("tab focus refreshes saves made without broadcast support", () => withHistoryUI(async ({ ui, store, el }) => {
      const shot = await seedRestoredReview("restore-review-peer-focus", 18);
      await ui.reviewShotTrace(shot);
      await withWatchedViews(() => ui.refreshSavedData(), async ({ viewWindow, refreshOnce }) => {
        await withSavedDataPeer(async (peer) => {
          await refreshOnce(async () => {
            await peer.saveShotOutcome(shot.id, { arrow_score: 10, target_distance: 50, target_distance_unit: "m", target_face_cm: 122 });
            assert((await api.get("shots", shot.id)).arrow_score === 10, "Blocked messaging prevented the local save");
            viewWindow.dispatchEvent(new Event("focus"));
          });
          assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="10"]').classList.contains("selected"), "Focus did not refresh a save from an older or blocked tab");
          assert(store.get().reviewShotId === shot.id && el.outcomeDistanceInput.value === "50", "Focus changed the active review or retained old context");
        }, { messagingBlocked: true });
      });
    }));

    await check("peer changes preserve unfinished target edits, manual markers and replay", () => withHistoryUI(async ({ ui, store, el }) => {
      const shot = await seedRestoredReview("restore-review-peer-draft", 19);
      await ui.reviewShotTrace(shot);
      el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').click();
      el.outcomeDistanceInput.value = "38";
      el.outcomeDistanceInput.dispatchEvent(new Event("input"));
      el.outcomeDistanceInput.focus();
      const trace = store.get().reviewTrace;
      store.set({ reviewReleaseIndex: 2, reviewHitIndex: 9, reviewReleaseTimeMs: 100, reviewHitTimeMs: 850,
        replayActive: true, replayPaused: false, replayProgress: 0.4 });
      await withWatchedViews(() => ui.refreshSavedData(), async ({ refreshOnce }) => {
        await withSavedDataPeer(async (peer) => {
          await refreshOnce(() => peer.importAllData(envelope({ shots: [{ ...shot, shot_score: 96, arrow_score: 3 }],
            bow_profiles: [{ id: "restore-review-bow", model: "Peer Bow", arrow_speed: 260 }] })));
          assert(el.reviewOutcomeStatus.textContent.includes("unsaved"), "Peer change did not preserve the draft");
          assert(el.outcomeScoreButtons.querySelector('[data-outcome-score="9"]').classList.contains("selected") && el.outcomeDistanceInput.value === "38"
            && document.activeElement === el.outcomeDistanceInput, "Peer change lost target edits or focus");
          const current = store.get();
          assert(current.formScore === 96 && current.reviewRangeSpeed.fps === 260, "Peer metrics or bow speed stayed stale");
          assert(current.reviewTrace === trace && current.reviewReleaseTimeMs === 100 && current.reviewHitTimeMs === 850
            && current.replayActive && current.replayProgress === 0.4, "Unchanged peer trace reset manual markers or playback");
        });
      });
    }));

    await check("peer deletion exits a removed review and prunes its selected history row", () => withHistoryUI(async ({ ui, store, el }) => {
      const shot = await seedRestoredReview("restore-review-peer-delete", 20);
      await ui.loadShotHistoryList();
      el.historySelectModeBtn.click();
      const checkbox = el.historyList.querySelector(`[data-shot-id="${shot.id}"].history-item-checkbox`);
      checkbox.click();
      assert(el.bulkSelectCount.textContent === "1 selected", "Capture was not selected before peer deletion");
      await ui.reviewShotTrace(shot);
      await withWatchedViews(() => ui.refreshSavedData(), async ({ refreshOnce }) => {
        await withSavedDataPeer(async (peer) => {
          await refreshOnce(() => peer.removeSavedShots([shot.id]));
          assert(!el.historyList.querySelector(`[data-session-id="${shot.id}"]`), "Deleted peer capture remained in history");
          assert(!store.get().reviewMode && store.get().reviewTrace === null, "Deleted peer review retained its trace");
          assert(el.bulkSelectCount.textContent === "0 selected" && el.bulkDeleteBtn.disabled, "Deleted peer capture remained selected");
          assert(!el.recentShotsList.querySelector(`[data-shot-id="${shot.id}"]`), "Deleted peer capture remained in recent shots");
        });
      });
    }));

    await check("peer changes refresh comparison traces and session drafts together", () => withHistoryUI(async ({ ui, store, el }) => {
      const shot = await seedRestoredReview("restore-review-peer-context", 21);
      const compared = { id: "restore-review-peer-compared", sample: true, capture_kind: "arrow", timestamp: "2110-01-21T12:00:10Z" };
      await api.saveCapture(compared, rangeTrace(compared.id));
      await ui.reviewShotTrace(shot);
      el.reviewCompareSelect.value = compared.id;
      el.reviewCompareSelect.dispatchEvent(new Event("change"));
      await waitForState(store, (current) => current.compareShotId === compared.id, "Initial comparison did not load");
      await ui.loadShotHistoryList();
      const session = el.historyList.querySelector(`[data-session-id="${shot.id}"]`);
      session.querySelector(".session-edit-btn").click();
      const name = session.querySelector(".session-name-input");
      name.value = "Keep this session draft";
      name.focus();
      name.setSelectionRange(3, 7);
      await withWatchedViews(() => ui.refreshSavedData(), async ({ refreshOnce }) => {
        await withSavedDataPeer(async (peer) => {
          await refreshOnce(() => peer.importAllData(envelope({ shots: [{ ...compared, label: "Peer comparison", capture_kind: "hold" }],
            shot_traces: [{ shot_id: compared.id, sample_rate_hz: 40, source: "firmware-timed", payload: [{ tUs: 0, roll: 4 }, { tUs: 25000, roll: 5 }] }],
            session_overrides: [{ id: shot.id, name: "Peer session", arrows_per_end: 6 }] })));
          assert(store.get().compareShotLabel.includes("Peer comparison"), "Comparison retained the peer's old recording");
          assert(store.get().compareTrace[0].roll === 4 && store.get().compareCaptureKind === "hold", "Comparison retained its old samples or provenance");
          const current = el.historyList.querySelector(`[data-session-id="${shot.id}"]`);
          const draft = current.querySelector(".session-name-input");
          assert(draft.value === "Keep this session draft" && document.activeElement === draft && draft.selectionStart === 3 && draft.selectionEnd === 7,
            "Peer context changes discarded the open session draft or focus");
          assert(el.reviewArrowProgress.textContent.includes("Arrow 1 of 1"), "Peer capture conversion left old review navigation");
        });
      });
    }));

    await check("peer bow updates refresh review speed while preserving a profile draft", () => withHistoryUI(async ({ ui, store, el, bus }) => {
      const shot = await seedRestoredReview("restore-review-peer-bow", 22);
      const { mountBowProfiles } = await import("../app/ui/bow-profiles.js?v=shot-store-176");
      const profiles = mountBowProfiles({ el, bus, database: api, preferences: { getItem: () => "restore-review-bow", setItem() {} } });
      await profiles.load();
      await ui.reviewShotTrace(shot);
      el.bowModelInput.value = "Unfinished bow details";
      el.bowModelInput.dispatchEvent(new Event("input"));
      el.bowModelInput.focus();
      await withWatchedViews(() => Promise.all([ui.refreshSavedData(), profiles.load()]), async ({ refreshOnce }) => {
        await withSavedDataPeer(async (peer) => {
          await refreshOnce(() => peer.saveBowProfile({ id: "restore-review-bow", model: "Peer bow details", arrow_speed: 275 }));
          assert(store.get().reviewRangeSpeed.fps === 275, "Review kept the older assigned bow speed");
          assert(el.bowModelInput.value === "Unfinished bow details" && el.bowSpeedInput.value === "240"
            && document.activeElement === el.bowModelInput, "Peer bow update overwrote the unfinished profile draft or focus");
          assert(el.bowProfileSelect.selectedOptions[0].textContent.startsWith("Peer bow details"), "Bow selector retained the older saved name");
        });
      });
    }));

    await check("a newer profile read supersedes a peer refresh without a false failure warning", () => withHistoryUI(async ({ el, bus }) => {
      const { mountBowProfiles } = await import("../app/ui/bow-profiles.js?v=shot-store-176");
      const profiles = mountBowProfiles({ el, bus, preferences: { getItem: () => "", setItem() {} } });
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let hold = true, ready, release;
      const committed = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[0] === "bow_profiles" && args[1] === "readonly") {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      try {
        await withWatchedViews(() => profiles.load(), async ({ refreshOnce, errors }) => {
          await withSavedDataPeer(async (peer) => {
            const refreshing = refreshOnce(() => peer.put("bow_profiles", { id: "peer-refresh-overlap", model: "Latest peer profile" }));
            await committed;
            assert(await profiles.load() === true, "The newer Settings read did not complete");
            release(); release = null;
            await refreshing;
            assert(errors.length === 0 && !el.bowProfileStatus.textContent, "An ignored older read produced a failure warning");
            assert([...el.bowProfileSelect.options].some((option) => option.value === "peer-refresh-overlap" && option.textContent === "Latest peer profile"),
              "The superseded peer read replaced the newer profile list");
          });
        });
      } finally { release?.(); connection.transaction = transaction; }
    }));

    await check("peer changes update adaptive training without an older read replacing the recommendation", () => withHistoryUI(async ({ store, el, bus }) => {
      const originalShot = { id: "peer-training", timestamp: "2111-01-01T12:00:00Z", hold_stability: 20, level_consistency: 90 };
      await api.importAllData(envelope({ shots: [originalShot] }), { merge: false });
      const { mountTraining } = await import("../app/ui/training.js?v=shot-store-200");
      const training = mountTraining({ store, el, bus });
      await waitForDOM(el.adaptiveCoachStats, () => el.adaptiveCoachStats.textContent.includes("Baseline 20"), "Initial training recommendation did not load");
      const connection = await (await import("../app/core/db.js?v=shot-store-176")).initDb();
      const transaction = connection.transaction;
      let hold = true, ready, release;
      const committed = new Promise((resolve) => { ready = resolve; });
      connection.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (hold && args[0] === "shots" && args[1] === "readonly") {
          hold = false;
          Object.defineProperty(tx, "oncomplete", { set(handler) {
            tx.addEventListener("complete", (event) => { release = () => handler(event); ready(); });
          } });
        }
        return tx;
      };
      let stale;
      try {
        stale = Promise.all([...bus.handlers.get("saved-data-changed")].map((handler) => handler()));
        await committed;
        await withWatchedViews(() => Promise.all([...bus.handlers.get("saved-data-changed")].map((handler) => handler())), async ({ refreshOnce }) => {
          await withSavedDataPeer(async (peer) => {
            await refreshOnce(() => peer.importAllData(envelope({ shots: [{ ...originalShot, hold_stability: 80, level_consistency: 30 }] }), { merge: false }));
            assert(el.adaptiveCoachTitle.textContent === "Lock in bow level" && el.adaptiveCoachStats.textContent.includes("Baseline 30"), "Peer restore did not update adaptive training");
            release(); release = null;
            await stale;
            assert(el.adaptiveCoachTitle.textContent === "Lock in bow level" && el.adaptiveCoachStats.textContent.includes("Baseline 30"), "An older read replaced the newer training recommendation");
          });
        });
      } finally { release?.(); if (stale) await stale; connection.transaction = transaction; training.destroy(); }
    }));
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
