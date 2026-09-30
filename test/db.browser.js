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

    const { TelemetryStore } = await import("../app/telemetry/telemetry.js?v=shot-store-147");
    const { EventBus, createStore } = await import("../app/core/store.js");
    const captureDb = await (await import("../app/core/db.js?v=shot-store-147")).initDb();
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

    await check("concurrent device metadata frames save one capture and trace waits for that commit", async () => {
      const recorder = deviceRecorder();
      await Promise.all([recorder.onShot(deviceShot(41002)), recorder.onShot(deviceShot(41002)), recorder.onTraceChunk(traceChunk(41002))]);
      const shots = (await api.getAll("shots")).filter((shot) => shot.device_shot_id === 41002);
      assert(shots.length === 1, "Concurrent frames created duplicate captures");
      assert((await api.get("shot_traces", shots[0].id)).payload[0].micAmp === 12, "Trace did not wait for its metadata");
    });

    await check("deleted current captures never redirect firmware traces to an older reused device id", async () => {
      const recorder = deviceRecorder();
      await api.put("shots", { id: "older-device-id", device_id: "OpenFloat-Sensor", device_shot_id: 41003, timestamp: "2000-01-01T12:00:00Z" });
      await api.put("shot_traces", { shot_id: "older-device-id", payload: [{ roll: 7 }], source: "original" });
      const id = await recorder.onShot(deviceShot(41003));
      await api.removeSavedShots([id]);
      await recorder.onTraceChunk(traceChunk(41003));
      assert(!await api.get("shot_traces", id), "Deleted capture regained its trace");
      assert((await api.get("shot_traces", "older-device-id")).source === "original", "Trace overwrote an older capture with the same device id");
    });

    await check("reconnect during metadata save cannot acknowledge or attach a trace to the new connection", async () => {
      const recorder = deviceRecorder();
      const saved = [];
      recorder.bus.on("shot-saved", (event) => saved.push(event));
      const writing = recorder.onShot(deviceShot(41004));
      const tracing = recorder.onTraceChunk(traceChunk(41004));
      recorder.reset();
      recorder.store.set({ formScore: 99, yaw: 88 });
      const newerPending = { chunks: new Map(), totalChunks: 2 };
      recorder.pendingTraces.set(41004, newerPending);
      const [id] = await Promise.all([writing, tracing]);
      assert(saved.length === 1 && saved[0].shotId === null, "An old save acknowledged the new connection");
      assert(recorder.connectionShotIds.size === 0 && recorder.store.get().formScore === 99, "An old save changed the new connection state");
      assert((await api.get("shots", id)).yaw_angle_deg === 12, "Metadata used orientation from the new connection");
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

    await check("manual recordings and rolling captures retain demo origin after disconnect", async () => {
      for (const method of ["saveManualRecording", "saveManual30sCapture"]) {
        let savedId;
        const recorder = Object.create(TelemetryStore.prototype);
        const points = Array.from({ length: 12 }, (_, index) => ({
          sample: true, ax: 0, ay: 0, az: 1, roll: 0, pitch: 0, lost: 0,
          tUs: 4000000 + index * 33000, micAmp: index,
        }));
        Object.assign(recorder, {
          bus: { emit(type, event) { if (type === "shot-saved") savedId = event.localShotId; } },
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

    const { CloudSyncAdapter } = await import("../app/telemetry/sync.js?v=shot-store-146");
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
        const { initHistory } = await import("../app/ui/history.js?v=shot-store-147");
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
