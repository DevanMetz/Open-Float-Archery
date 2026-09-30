// Client-side IndexedDB database wrapper for OpenFloat.
// Handles local storage of profiles, sessions, shots, traces, and the sync queue.

const DB_NAME = "openfloat_db";
const DB_VERSION = 2;

// Shots whose timestamps fall within this window of each other are grouped into
// the same practice session automatically (no manual start/stop needed).
export const SESSION_GAP_MS = 30 * 60 * 1000;

let dbPromise = null;

export function initDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (e) => {
      console.error("IndexedDB error:", e.target.error);
      reject(e.target.error);
    };

    request.onsuccess = (e) => {
      const db = e.target.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      // 1. Bow Profiles (keyPath 'id' which will be a Client-generated UUID)
      if (!db.objectStoreNames.contains("bow_profiles")) {
        db.createObjectStore("bow_profiles", { keyPath: "id" });
      }

      // 2. Sessions (keyPath 'id' - Client-generated UUID)
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("started_at", "started_at", { unique: false });
      }

      // 3. Shots (keyPath 'id' - Client-generated UUID)
      if (!db.objectStoreNames.contains("shots")) {
        const store = db.createObjectStore("shots", { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }

      // 4. Shot Traces (keyPath 'shot_id' - maps directly to shot.id).
      //    payload[] carries motion (+ micAmp per point); mic_series[] is an
      //    optional full-rate mic window for connected-shot captures.
      if (!db.objectStoreNames.contains("shot_traces")) {
        db.createObjectStore("shot_traces", { keyPath: "shot_id" });
      }

      // 5. Sync Queue (Auto-incrementing ID for execution sequence)
      if (!db.objectStoreNames.contains("sync_queue")) {
        const store = db.createObjectStore("sync_queue", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("status", "status", { unique: false });
      }

      // 6. Session Overrides (keyPath 'id' = anchor shot id of an auto-detected
      //    session group). Stores the user-edited name and bow for that group.
      if (!db.objectStoreNames.contains("session_overrides")) {
        db.createObjectStore("session_overrides", { keyPath: "id" });
      }
    };
  }).catch((error) => {
    // A transient open failure must not poison every later storage operation.
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

// Request success is provisional: the containing transaction can still abort.
// Queue work synchronously and resolve only after the whole transaction commits.
async function runTransaction(storeNames, mode, work) {
  const db = await initDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = (event) => reject(
      tx.error || event.target.error || new DOMException("Database transaction aborted.", "AbortError"),
    );
    try {
      const request = work(tx);
      if (request) request.onsuccess = () => { result = request.result; };
    } catch (error) {
      // A synchronous DataError/DataCloneError does not abort other requests
      // already queued in this transaction. Explicitly roll them back.
      tx.abort();
      reject(error);
    }
  });
}

export function put(storeName, item) {
  return runTransaction(storeName, "readwrite", (tx) => tx.objectStore(storeName).put(item));
}

export function get(storeName, key) {
  return runTransaction(storeName, "readonly", (tx) => tx.objectStore(storeName).get(key));
}

export function remove(storeName, key) {
  return runTransaction(storeName, "readwrite", (tx) => tx.objectStore(storeName).delete(key));
}

export function getAll(storeName) {
  return runTransaction(storeName, "readonly", (tx) => tx.objectStore(storeName).getAll());
}

export function getPendingSyncTasks() {
  return runTransaction("sync_queue", "readonly", (tx) =>
    tx.objectStore("sync_queue").index("status").getAll("pending"));
}

export async function updateSyncTaskStatus(taskId, status) {
  let updatedTask;
  await runTransaction("sync_queue", "readwrite", (tx) => {
    const store = tx.objectStore("sync_queue");
    const getReq = store.get(taskId);
    getReq.onsuccess = () => {
      const task = getReq.result;
      if (task) {
        updatedTask = { ...task, status };
        store.put(updatedTask);
      }
    };
  });
  return updatedTask;
}

// Delete local captures as one operation, including queued uploads. Cloud
// copies and uploads already in flight are outside this transaction's scope.
export async function removeSavedShots(shotIds) {
  if (!Array.isArray(shotIds) || shotIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Capture deletion requires a list of shot ids.");
  }
  const ids = new Set(shotIds);
  if (!ids.size) return 0;
  let removedCount = 0;
  await runTransaction(["shots", "shot_traces", "sync_queue", "session_overrides"], "readwrite", (tx) => {
    const shots = tx.objectStore("shots");
    const overrides = tx.objectStore("session_overrides");
    const shotRequest = shots.getAll();
    shotRequest.onsuccess = () => {
      removedCount = shotRequest.result.filter((shot) => ids.has(shot.id)).length;
      const overrideRequest = overrides.getAll();
      overrideRequest.onsuccess = () => {
        const overrideMap = new Map(overrideRequest.result.map((record) => [record.id, record]));
        // Deleting an anchor (or a bridging shot) can create new session
        // anchors. Carry the old group's settings to each surviving fragment,
        // preserving any more specific settings already attached there.
        for (const group of groupShotsByTime(shotRequest.result)) {
          if (!group.shots.some((shot) => ids.has(shot.id))) continue;
          const settings = overrideMap.get(group.anchorId);
          if (!settings) continue;
          const remaining = group.shots.filter((shot) => !ids.has(shot.id));
          for (const survivor of groupShotsByTime(remaining)) {
            if (survivor.anchorId === group.anchorId) continue;
            overrides.put({ ...settings, ...overrideMap.get(survivor.anchorId), id: survivor.anchorId });
          }
        }
        for (const id of ids) {
          shots.delete(id);
          tx.objectStore("shot_traces").delete(id);
          overrides.delete(id);
        }
      };
    };
    const queue = tx.objectStore("sync_queue");
    const cursorRequest = queue.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const task = cursor.value;
      if (task.table === "shots" || task.table === "shot_traces") {
        const key = task.table === "shot_traces" ? "shot_id" : "id";
        if (ids.has(task.targetId) || ids.has(task.payload?.[key])) queue.delete(cursor.primaryKey);
      }
      cursor.continue();
    };
  });
  return removedCount;
}

// --- Data portability (local backup / restore) ---------------------------
// The export bundles every object store so a field-test capture can be moved
// between browsers or machines, or kept as a backup, without any cloud account.

export const EXPORT_FORMAT = "openfloat-export";
export const EXPORT_VERSION = 1;

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Both backup formats use the same atomic restore path. Validate the envelope
// before opening a transaction, including the shot-to-trace link for a single
// capture. Older v1 files without an explicit version remain readable.
export function normalizeImportPayload(payload) {
  if (!isRecord(payload) || ![EXPORT_FORMAT, "openfloat-shot-export"].includes(payload.format)) {
    throw new Error("Unrecognized OpenFloat export file.");
  }
  if (payload.version != null && payload.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported OpenFloat export version: ${payload.version}.`);
  }
  let stores = payload.stores;
  if (payload.format === "openfloat-shot-export") {
    if (!isRecord(payload.shot) || typeof payload.shot.id !== "string" || !payload.shot.id.trim()) {
      throw new Error("Single-shot export is missing a valid shot id.");
    }
    if (payload.trace != null && (!isRecord(payload.trace) || payload.trace.shot_id !== payload.shot.id)) {
      throw new Error("The exported trace does not belong to this shot.");
    }
    stores = { shots: [payload.shot], shot_traces: payload.trace == null ? [] : [payload.trace] };
  }
  if (!isRecord(stores)) throw new Error("Export file is missing its data stores.");
  for (const [name, records] of Object.entries(stores)) {
    if (!Array.isArray(records) || records.some((record) => !isRecord(record))) {
      throw new Error(`Export store ${name} must contain a list of records.`);
    }
  }
  return { ...payload, format: EXPORT_FORMAT, version: EXPORT_VERSION, stores };
}

// Queue rows are browser-local work, not portable data. Rebuild uploads from
// the imported records in dependency order, keeping the last value per key.
export function buildImportSyncTasks(stores) {
  const isSample = (record) => record.sample === true || record.device_id === "OpenFloat-Demo";
  const sampleShots = new Set((stores.shots || []).filter(isSample).map((shot) => shot.id));
  const tasks = [];
  for (const table of ["bow_profiles", "sessions", "shots", "shot_traces"]) {
    const key = table === "shot_traces" ? "shot_id" : "id";
    const latest = new Map((stores[table] || []).map((record) => [record[key], record]));
    for (const [targetId, record] of latest) {
      if (isSample(record)) continue;
      if (table === "shot_traces" && (record.source === "sample" || sampleShots.has(targetId))) continue;
      tasks.push({ table, action: "CREATE", targetId, payload: record, status: "pending" });
    }
  }
  return tasks;
}

// Commit capture metadata, any available trace, and their uploads together.
// Device metadata can arrive before its trace; demo captures stay local.
export async function saveCapture(shot, trace = null) {
  if (!shot?.id || (trace != null && trace.shot_id !== shot.id)) {
    throw new Error("Capture metadata and trace must have matching shot ids.");
  }
  const tasks = buildImportSyncTasks({ shots: [shot], shot_traces: trace ? [trace] : [] });
  await runTransaction(["shots", "shot_traces", "sync_queue"], "readwrite", (tx) => {
    tx.objectStore("shots").put(shot);
    if (trace) tx.objectStore("shot_traces").put(trace);
    for (const task of tasks) tx.objectStore("sync_queue").add(task);
  });
}

// Late telemetry patches only the latest record. Deletion wins if the capture
// has gone, and user-entered arrow outcomes survive delayed scoring updates.
export async function saveShotTrace(trace, metrics = null) {
  if (!trace?.shot_id) throw new Error("A saved trace must identify its capture.");
  let updatedShot = null;
  await runTransaction(["shots", "shot_traces", "sync_queue"], "readwrite", (tx) => {
    const shots = tx.objectStore("shots");
    const request = shots.get(trace.shot_id);
    request.onsuccess = () => {
      if (!request.result) return;
      updatedShot = { ...request.result, ...metrics, id: trace.shot_id };
      const sample = updatedShot.sample === true || updatedShot.device_id === "OpenFloat-Demo";
      const savedTrace = sample ? { ...trace, sample: true, source: "sample" } : trace;
      if (metrics) shots.put(updatedShot);
      tx.objectStore("shot_traces").put(savedTrace);
      for (const task of buildImportSyncTasks({ shots: [updatedShot], shot_traces: [savedTrace] })) {
        if (task.table === "shots" && !metrics) continue;
        tx.objectStore("sync_queue").add({ ...task, action: task.table === "shots" ? "UPDATE" : "CREATE" });
      }
    };
  });
  return updatedShot;
}

// Patch the latest saved shot and queue that exact version in one transaction.
// Reading inside the write transaction preserves telemetry fields that arrived
// while the outcome editor was open, and never recreates a deleted capture.
export async function saveShotOutcome(shotId, changes) {
  let updatedShot;
  await runTransaction(["shots", "sync_queue"], "readwrite", (tx) => {
    const shots = tx.objectStore("shots");
    const request = shots.get(shotId);
    request.onsuccess = () => {
      if (!request.result) return;
      updatedShot = { ...request.result, ...changes, id: shotId };
      shots.put(updatedShot);
      for (const task of buildImportSyncTasks({ shots: [updatedShot] })) {
        tx.objectStore("sync_queue").add({ ...task, action: "UPDATE" });
      }
    };
  });
  if (!updatedShot) throw new Error("The reviewed shot is no longer in local storage.");
  return updatedShot;
}

// Read every object store into a single JSON-serializable envelope.
export async function exportAllData() {
  const db = await initDb();
  const storeNames = Array.from(db.objectStoreNames);
  const stores = {};

  await runTransaction(storeNames, "readonly", (tx) => {
    for (const name of storeNames) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => {
        stores[name] = req.result;
      };
    }
  });

  return exportEnvelope(stores);
}

function exportEnvelope(stores) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

// Read only the selected captures and their dependencies in one snapshot.
// Overrides keep their original anchor ids; exporting a partial session never
// invents a second override that could conflict when merged back later.
export async function exportSelectedShots(shotIds) {
  const ids = [...new Set(shotIds)];
  if (!ids.length) throw new Error("Select at least one shot to export.");
  const stores = { shots: [], shot_traces: [], sessions: [], session_overrides: [], bow_profiles: [] };
  const requested = Object.fromEntries(Object.keys(stores).map((name) => [name, new Set()]));

  await runTransaction(Object.keys(stores), "readonly", (tx) => {
    function collect(name, key) {
      if (!key || requested[name].has(key)) return;
      requested[name].add(key);
      const request = tx.objectStore(name).get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) return;
        stores[name].push(record);
        if (name === "shots") {
          collect("shot_traces", record.id);
          collect("session_overrides", record.id);
          collect("sessions", record.session_id);
        }
        if (name === "sessions" || name === "session_overrides") {
          collect("bow_profiles", record.bow_profile_id);
        }
      };
    }
    for (const id of ids) collect("shots", id);
  });

  if (stores.shots.length !== ids.length) {
    throw new Error("Some selected shots are no longer saved. Refresh Saved Shots and select again.");
  }
  return exportEnvelope(stores);
}

// Restore an exported envelope. By default records are merged into the existing
// database (put by key, so a re-import overwrites matching records but keeps
// everything else). Pass { merge: false } to clear each store before restoring.
// Saved queue rows are never replayed. The UI requests fresh upload tasks in
// this same transaction so imported corrections cannot lose their sync work.
// Returns a per-store count of restored records.
export async function importAllData(payload, { merge = true, queueForSync = false } = {}) {
  const { stores } = normalizeImportPayload(payload);

  const db = await initDb();
  const validStores = new Set(Array.from(db.objectStoreNames));
  const incoming = Object.keys(stores).filter((name) => name !== "sync_queue" && validStores.has(name));
  if (!incoming.length) {
    throw new Error("Export file contains no known data stores.");
  }

  const tasks = queueForSync ? buildImportSyncTasks(stores) : [];
  const counts = { sync_queue: tasks.length };
  await runTransaction(tasks.length ? [...incoming, "sync_queue"] : incoming, "readwrite", (tx) => {
    for (const name of incoming) {
      const store = tx.objectStore(name);
      if (!merge) store.clear();
      const records = stores[name];
      counts[name] = records.length;
      for (const record of records) store.put(record);
    }
    // Append after existing work: an older queued payload must not hide the
    // newly imported version, and numeric ids from another browser can collide.
    for (const task of tasks) tx.objectStore("sync_queue").add(task);
  });

  return counts;
}

// Group shots into practice sessions purely from their timestamps. Any gap
// larger than `gapMs` between consecutive shots starts a new session. Each group
// is anchored by its earliest shot's id (stable as new shots are appended), so
// user edits (name/bow) stored in `session_overrides` stay attached.
// Returns groups sorted newest-first; each group's shots are also newest-first.
export function groupShotsByTime(shots, gapMs = SESSION_GAP_MS) {
  const sortTime = (shot) => {
    const time = Date.parse(shot.timestamp);
    return Number.isFinite(time) ? time : -Infinity;
  };
  const sorted = [...shots].sort((a, b) => {
    const leftId = String(a.id);
    const rightId = String(b.id);
    return sortTime(a) - sortTime(b) || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
  });

  const groups = [];
  let current = null;
  for (const shot of sorted) {
    const t = Date.parse(shot.timestamp);
    if (!current || !Number.isFinite(t) || !Number.isFinite(current.lastTime) || t - current.lastTime > gapMs) {
      current = {
        anchorId: shot.id,
        startTime: t,
        lastTime: t,
        shots: [],
      };
      groups.push(current);
    }
    current.shots.push(shot);
    current.lastTime = t;
  }

  // Present newest sessions and newest shots first for display.
  for (const g of groups) g.shots.reverse();
  groups.reverse();
  return groups;
}

// Generate a cryptographic-quality UUIDv4 client side
export function generateUUID() {
  // Use crypto.randomUUID if available, else fallback
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
