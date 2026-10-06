// Same-origin tabs share IndexedDB, but their event buses are independent.
// Send only store names; each receiving view reads the committed local data.
const SAVED_STORES = ["shots", "shot_traces", "sessions", "session_overrides", "bow_profiles"];
const channels = new Map();

function savedStores(stores) {
  return Array.isArray(stores) ? [...new Set(stores.filter((name) => SAVED_STORES.includes(name)))] : [];
}

function channelFor(databaseName) {
  if (channels.has(databaseName)) return channels.get(databaseName);
  try {
    const channel = new BroadcastChannel(`openfloat:saved-data:${databaseName}`);
    const entry = { channel, listeners: new Set() };
    channel.addEventListener("message", ({ data }) => {
      if (data?.version !== 1) return;
      const stores = savedStores(data.stores);
      if (stores.length) for (const listener of entry.listeners) listener(stores);
    });
    channels.set(databaseName, entry);
    return entry;
  } catch (_) { return null; }
}

export function publishSavedDataChange(databaseName, stores) {
  const changed = savedStores(stores);
  if (!changed.length) return;
  // Notification support is optional and cannot fail an already committed save.
  try { channelFor(databaseName)?.channel.postMessage({ version: 1, stores: changed }); }
  catch (_) { /* Focus refresh remains available if messaging is blocked. */ }
}

function listen(databaseName, listener) {
  const entry = channelFor(databaseName);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      entry.channel.close();
      if (channels.get(databaseName) === entry) channels.delete(databaseName);
    }
  };
}

export function watchSavedData(databaseName, refresh, {
  document = globalThis.document, window = globalThis.window, onError = () => {},
} = {}) {
  const pending = new Set();
  let timer = null, running = false, suspended = false, stopped = false;

  function schedule() {
    if (stopped || suspended || document.hidden || running || timer !== null || !pending.size) return;
    timer = window.setTimeout(flush, 50);
  }
  function request(stores = SAVED_STORES) {
    if (stopped) return;
    for (const name of savedStores(stores)) pending.add(name);
    schedule();
  }
  async function flush() {
    timer = null;
    if (stopped || suspended || document.hidden || !pending.size) return;
    const stores = [...pending];
    pending.clear();
    running = true;
    try { await refresh(stores); }
    catch (error) {
      try { onError(error); } catch (_) { /* Leave refresh available for retry. */ }
    } finally { running = false; schedule(); }
  }
  let unlisten = listen(databaseName, request);
  const focus = () => request();
  const visible = () => { if (!document.hidden) request(); };
  const hide = () => {
    suspended = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    unlisten();
  };
  const show = () => {
    if (suspended) { suspended = false; unlisten = listen(databaseName, request); }
    request();
  };
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  document.addEventListener("visibilitychange", visible);
  return () => {
    stopped = true;
    hide();
    pending.clear();
    window.removeEventListener("focus", focus);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
    document.removeEventListener("visibilitychange", visible);
  };
}
