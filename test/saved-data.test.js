import test from "node:test";
import assert from "node:assert/strict";
import { publishSavedDataChange, watchSavedData } from "../app/core/saved-data.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(run, { unavailable = false } = {}) {
  const original = globalThis.BroadcastChannel;
  const peers = [];
  class Channel extends EventTarget {
    constructor(name) { super(); this.name = name; this.closed = false; peers.push(this); }
    postMessage(data) {
      for (const peer of peers) if (peer !== this && !peer.closed && peer.name === this.name) {
        peer.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
      }
    }
    close() { this.closed = true; }
  }
  globalThis.BroadcastChannel = unavailable ? class { constructor() { throw new Error("Blocked"); } } : Channel;
  const window = new EventTarget();
  const document = new EventTarget();
  document.hidden = false;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback) => { timers.set(++nextTimer, callback); return nextTimer; };
  window.clearTimeout = (timer) => timers.delete(timer);
  const name = `test-${Math.random()}`;
  const calls = [], errors = [], stops = [];
  let refresh = async () => {};
  const start = () => {
    const stop = watchSavedData(name, async (stores) => { calls.push(stores); await refresh(stores); },
      { window, document, onError: (error) => errors.push(error.message) });
    stops.push(stop);
    return stop;
  };
  async function flush() {
    const queued = [...timers.values()];
    timers.clear();
    await Promise.all(queued.map((callback) => callback()));
  }
  try {
    start();
    const peer = unavailable ? null : new Channel(`openfloat:saved-data:${name}`);
    await run({ peer, peers, window, document, calls, errors, timers, flush, start,
      stop: stops[0], publish: (stores) => publishSavedDataChange(name, stores),
      refresh: (callback) => { refresh = callback; } });
  } finally {
    for (const stop of stops) stop();
    for (const peer of peers) peer.close();
    globalThis.BroadcastChannel = original;
  }
}

test("peer notices coalesce store names without passing capture data or echoing own writes", () => fixture(async (f) => {
  const received = [];
  f.peer.addEventListener("message", ({ data }) => received.push(data));
  f.publish(["shots", "sync_queue", "shots"]);
  assert.deepEqual(received, [{ version: 1, stores: ["shots"] }]);
  assert.equal(f.timers.size, 0);
  f.peer.postMessage({ version: 1, stores: ["shots", "shot_traces"] });
  f.peer.postMessage({ version: 1, stores: ["bow_profiles", "shots"] });
  assert.equal(f.timers.size, 1);
  await f.flush();
  assert.deepEqual(f.calls, [["shots", "shot_traces", "bow_profiles"]]);
}));

test("invalid notices and sync-only changes do not refresh or broadcast", () => fixture(async (f) => {
  f.peer.postMessage({ version: 2, stores: ["shots"] });
  f.peer.postMessage({ version: 1, stores: "shots" });
  f.peer.postMessage({ version: 1, stores: ["sync_queue", "unknown"] });
  f.publish(["sync_queue"]);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls, []);
}));

test("hidden pages wait for visibility and focus refreshes without channel support", () => fixture(async (f) => {
  f.document.hidden = true;
  f.window.dispatchEvent(new Event("focus"));
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.window.dispatchEvent(new Event("focus"));
  await f.flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(new Set(f.calls[0]), new Set(["shots", "shot_traces", "sessions", "session_overrides", "bow_profiles"]));
}, { unavailable: true }));

test("a notice arriving during a read gets a following refresh without overlapping reads", () => fixture(async (f) => {
  const read = deferred();
  f.refresh(() => read.promise);
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  const first = f.flush();
  f.peer.postMessage({ version: 1, stores: ["shot_traces"] });
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  read.resolve();
  await first;
  assert.equal(f.timers.size, 1);
  await f.flush();
  assert.deepEqual(f.calls, [["shots"], ["shot_traces"]]);
}));

test("a failed refresh retries on focus without creating an automatic retry loop", () => fixture(async (f) => {
  f.refresh(async () => { throw new Error("Read failed"); });
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  await f.flush();
  assert.deepEqual(f.errors, ["Read failed"]);
  assert.equal(f.timers.size, 0);
  f.refresh(async () => {});
  f.window.dispatchEvent(new Event("focus"));
  await f.flush();
  assert.equal(f.calls.length, 2);
}));

test("page-cache suspension closes notices and resuming refreshes the latest data", () => fixture(async (f) => {
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  const originalChannel = f.peers.find((peer) => peer !== f.peer);
  f.window.dispatchEvent(new Event("pagehide"));
  assert.equal(originalChannel.closed, true);
  assert.equal(f.timers.size, 0);
  f.peer.postMessage({ version: 1, stores: ["bow_profiles"] });
  f.window.dispatchEvent(new Event("pageshow"));
  await f.flush();
  assert.equal(f.calls.length, 1);
  f.peer.postMessage({ version: 1, stores: ["session_overrides"] });
  await f.flush();
  assert.equal(f.calls.length, 2);
  f.stop();
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  f.window.dispatchEvent(new Event("focus"));
  assert.equal(f.timers.size, 0);
}));

test("one watcher can stop without disconnecting another watcher in the same page", () => fixture(async (f) => {
  f.start();
  f.stop();
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  await f.flush();
  assert.equal(f.calls.length, 1);
}));

test("blocked notifications cannot turn a committed write into a failure", () => fixture(async (f) => {
  const sender = f.peers.find((peer) => peer !== f.peer);
  sender.postMessage = () => { throw new Error("Messaging blocked"); };
  assert.doesNotThrow(() => f.publish(["shots"]));
  f.window.dispatchEvent(new Event("focus"));
  await f.flush();
  assert.equal(f.calls.length, 1);
}));

test("a scheduled refresh waits if the tab becomes hidden before it runs", () => fixture(async (f) => {
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  f.document.hidden = true;
  await f.flush();
  assert.equal(f.calls.length, 0);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  await f.flush();
  assert.equal(f.calls.length, 1);
}));

test("stopping during a read cancels pending follow-up refreshes", () => fixture(async (f) => {
  const read = deferred();
  f.refresh(() => read.promise);
  f.peer.postMessage({ version: 1, stores: ["shots"] });
  const first = f.flush();
  f.peer.postMessage({ version: 1, stores: ["shot_traces"] });
  f.stop();
  read.resolve();
  await first;
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 1);
}));
