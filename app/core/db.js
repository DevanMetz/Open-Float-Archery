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
      resolve(e.target.result);
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

      // 4. Shot Traces (keyPath 'shot_id' - maps directly to shot.id)
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
  });

  return dbPromise;
}

// Helper to perform a read-write transaction
function getStore(storeName, mode = "readonly") {
  return initDb().then((db) => {
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  });
}

export async function put(storeName, item) {
  const store = await getStore(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(storeName, key) {
  const store = await getStore(storeName, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(storeName, key) {
  const store = await getStore(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName) {
  const store = await getStore(storeName, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getPendingSyncTasks() {
  const store = await getStore("sync_queue", "readonly");
  const index = store.index("status");
  return new Promise((resolve, reject) => {
    const req = index.getAll("pending");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateSyncTaskStatus(taskId, status) {
  const store = await getStore("sync_queue", "readwrite");
  return new Promise((resolve, reject) => {
    const getReq = store.get(taskId);
    getReq.onsuccess = () => {
      const task = getReq.result;
      if (!task) {
        resolve();
        return;
      }
      task.status = status;
      const putReq = store.put(task);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// Group shots into practice sessions purely from their timestamps. Any gap
// larger than `gapMs` between consecutive shots starts a new session. Each group
// is anchored by its earliest shot's id (stable as new shots are appended), so
// user edits (name/bow) stored in `session_overrides` stay attached.
// Returns groups sorted newest-first; each group's shots are also newest-first.
export function groupShotsByTime(shots, gapMs = SESSION_GAP_MS) {
  const sorted = [...shots].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );

  const groups = [];
  let current = null;
  for (const shot of sorted) {
    const t = new Date(shot.timestamp).getTime();
    if (!current || t - current.lastTime > gapMs) {
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
