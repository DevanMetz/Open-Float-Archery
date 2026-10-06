import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { BleAdapter } from "../app/device/adapters.js";
import { EventBus } from "../app/core/store.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function characteristic() {
  const value = new EventTarget();
  value.startNotifications = async () => value;
  value.stopNotifications = async () => value;
  value.readValue = async () => new DataView(new Uint8Array([80]).buffer);
  value.commands = [];
  value.writeValue = async (bytes) => value.commands.push(new TextDecoder().decode(bytes));
  return value;
}

function bleFixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = new EventBus();
  const adapter = new BleAdapter(bus);
  const statuses = [], batteries = [];
  bus.on("status", (status) => statuses.push(status));
  bus.on("battery", (level) => batteries.push(level));
  const live = characteristic(), control = characteristic(), battery = characteristic();
  const device = new EventTarget();
  device.name = "OpenFloat-Test";
  const service = { getCharacteristic: async (uuid) => uuid.endsWith("002") ? live : control };
  const server = {
    connected: false,
    connect: async () => { server.connected = true; return server; },
    disconnect: () => {
      if (!server.connected) return;
      server.connected = false;
      device.dispatchEvent(new Event("gattserverdisconnected"));
    },
    getPrimaryService: async (uuid) => uuid === "battery_service"
      ? { getCharacteristic: async () => battery } : service,
  };
  device.gatt = server;
  // Node exposes a read-only navigator in recent versions.
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { bluetooth: { requestDevice: async () => device } },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  t.after(() => adapter.disconnect());
  return { adapter, bus, statuses, batteries, live, control, battery, device, server, service };
}

test("canceling a pending Bluetooth picker never opens its selected device", async (t) => {
  const { adapter, device, server, statuses } = bleFixture(t);
  const picker = deferred();
  navigator.bluetooth.requestDevice = () => picker.promise;
  let opened = 0;
  server.connect = async () => { opened += 1; return server; };
  const connecting = adapter.connect();
  await adapter.disconnect();
  picker.resolve(device);
  await connecting;
  assert.equal(opened, 0);
  assert.equal(adapter.connected, false);
  assert.equal(statuses.at(-1).text, "Disconnected");
});

test("a GATT connection that completes after disconnect is closed without publishing live status", async (t) => {
  const { adapter, device, server, control, statuses } = bleFixture(t);
  const opening = deferred();
  server.connect = () => opening.promise;
  const connecting = adapter.connect();
  await flush();
  await adapter.disconnect();
  server.connected = true;
  opening.resolve(server);
  await connecting;
  assert.equal(device.gatt.connected, false);
  assert.equal(adapter.connected, false);
  assert.deepEqual(control.commands, []);
  assert.ok(statuses.every((status) => status.mode !== "live"));
});

test("late notification setup and battery reads cannot revive a stopped adapter", async (t) => {
  const { adapter, live, battery, control, batteries, statuses } = bleFixture(t);
  const reading = deferred();
  battery.readValue = () => reading.promise;
  const connecting = adapter.connect();
  await flush();
  await adapter.disconnect();
  reading.resolve(new DataView(new Uint8Array([99]).buffer));
  await connecting;
  battery.dispatchEvent(new Event("characteristicvaluechanged"));
  live.dispatchEvent(new Event("characteristicvaluechanged"));
  assert.deepEqual(batteries, []);
  assert.deepEqual(control.commands, []);
  assert.ok(statuses.every((status) => status.mode !== "live"));
});

test("notification subscription finishing after disconnect cannot start the stream", async (t) => {
  const { adapter, live, control, statuses } = bleFixture(t);
  const subscribing = deferred();
  live.startNotifications = () => subscribing.promise;
  const connecting = adapter.connect();
  await flush();
  await adapter.disconnect();
  subscribing.resolve(live);
  await connecting;
  live.dispatchEvent(new Event("characteristicvaluechanged"));
  assert.equal(adapter.connected, false);
  assert.equal(adapter.live, null);
  assert.deepEqual(control.commands, []);
  assert.ok(statuses.every((status) => status.mode !== "live"));
});

test("optional battery notifications failing do not block a usable telemetry connection", async (t) => {
  const { adapter, battery, control } = bleFixture(t);
  battery.startNotifications = async () => { throw new Error("Battery notifications unavailable"); };
  await adapter.connect();
  assert.equal(adapter.connected, true);
  assert.deepEqual(control.commands, ["start", "shotdump"]);
});

test("reconnection starts a fresh write queue and rejects old queued writes and failures", async (t) => {
  const { adapter, control } = bleFixture(t);
  await adapter.connect();
  const pending = deferred();
  control.writeValue = () => pending.promise;
  const oldWrite = adapter.sendControl("zero");
  const oldQueued = adapter.sendControl("shotreset");
  await flush();
  adapter._onDrop();
  adapter._stopReconnectTimer();
  const replacement = characteristic();
  adapter.control = replacement;
  adapter.connected = true;
  const newWrite = adapter.sendControl("start");
  await flush();
  assert.deepEqual(replacement.commands, ["start"], "New connection waited for a stale GATT operation");
  pending.reject(new Error("GATT server disconnected"));
  assert.equal(await oldWrite, false);
  assert.equal(await oldQueued, false);
  assert.equal(await newWrite, true);
  assert.equal(adapter.connected, true, "An old failure disconnected the replacement link");
  assert.deepEqual(replacement.commands, ["start"]);
});

test("a delayed retry never sends the old command to a replacement characteristic", async (t) => {
  const { adapter, control } = bleFixture(t);
  await adapter.connect();
  control.writeValue = async () => { throw new Error("Busy"); };
  const writing = adapter.sendControl("zero");
  await flush();
  adapter._onDrop();
  adapter._stopReconnectTimer();
  const replacement = characteristic();
  adapter.control = replacement;
  t.mock.timers.tick(150);
  assert.equal(await writing, false);
  assert.deepEqual(replacement.commands, []);
});

test("canceling an in-flight reconnect does not publish success or schedule more attempts", async (t) => {
  const { adapter, server, statuses } = bleFixture(t);
  await adapter.connect();
  server.disconnect();
  const opening = deferred();
  server.connect = () => opening.promise;
  t.mock.timers.tick(1000);
  await flush();
  await adapter.disconnect();
  server.connected = true;
  opening.resolve(server);
  await flush();
  t.mock.timers.tick(30000);
  assert.equal(server.connected, false);
  assert.equal(adapter.reconnectTimer, null);
  assert.equal(statuses.at(-1).text, "Disconnected");
  assert.equal(statuses.filter((status) => status.mode === "live").length, 1);
});

test("a failed reconnect removes its partial subscription before the next attempt", async (t) => {
  const { adapter, server, live } = bleFixture(t);
  await adapter.connect();
  server.disconnect();
  live.startNotifications = async () => { throw new Error("Subscription failed"); };
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(adapter.live, null);
  assert.equal(adapter.control, null);
  assert.equal(adapter.connected, false);
  live.dispatchEvent(new Event("characteristicvaluechanged"));
  live.startNotifications = async () => live;
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(adapter.connected, true);
});

test("a queued saved notification cannot acknowledge a replacement BLE connection", async (t) => {
  const { adapter, bus } = bleFixture(t);
  await adapter.connect();
  const sourceConnection = { token: adapter.connectionToken, epoch: adapter.connectionEpoch };
  const notifying = bus.emitAsync("shot-saved", { shotId: 42, stored: true, sourceConnection });
  adapter.connectionEpoch += 1;
  const replacement = characteristic();
  adapter.control = replacement;
  await notifying;
  await flush();
  assert.deepEqual(replacement.commands, [], "Old metadata acknowledged or requested traces from the replacement connection");
  assert.equal(adapter.currentTraceDownloadShotId, null);
});

test("a successful BLE control write is not retried or rejected when logging fails", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  await adapter.connect();
  control.commands.length = 0;
  bus.on("log", () => { throw new Error("Log unavailable"); });
  assert.equal(await adapter.sendControl("shotack:42"), true);
  assert.deepEqual(control.commands, ["shotack:42"]);
});

function storedShotFrame(id) {
  const bytes = new Uint8Array(29);
  bytes.set([0x4f, 0x46, 1, 4]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, id, true);
  view.setUint16(6, id, true);
  view.setInt16(12, 16000, true);
  return bytes;
}

test("automatic reconnect restores acknowledged trace transfers after a failed subscription retry", async (t) => {
  const { adapter, bus, live, control } = bleFixture(t);
  const resumed = [];
  bus.on("trace-resume", (entry) => { resumed.push(entry); return true; });
  await adapter.connect();
  for (const shotId of [42, 43]) await bus.emitAsync("shot-saved", {
    shotId, stored: true, localShotId: `saved-${shotId}`,
    sourceConnection: { token: adapter.connectionToken, epoch: adapter.connectionEpoch },
  });
  await flush();
  assert.ok(control.commands.includes("shotack:42") && control.commands.includes("shotack:43"));
  adapter._onDrop(); control.commands.length = 0;
  live.startNotifications = async () => { throw new Error("Subscription interrupted"); };
  t.mock.timers.tick(1000); await flush();
  assert.equal(adapter.connected, false);
  assert.deepEqual(control.commands, []);
  live.startNotifications = async () => live;
  t.mock.timers.tick(2000); await flush();
  assert.equal(adapter.connected, true);
  assert.deepEqual(resumed.map(({ shotId, localShotId }) => [shotId, localShotId]), [[42, "saved-42"], [43, "saved-43"]]);
  assert.deepEqual(control.commands.filter((command) => command.startsWith("tracetimed:")), ["tracetimed:42"]);
  adapter._onTraceChunkReceived({ shotId: 42, timed: true, protocol: 2, totalChunks: 1, chunkIndex: 0 });
  await flush();
  assert.deepEqual(control.commands.filter((command) => command.startsWith("tracetimed:")), ["tracetimed:42", "tracetimed:43"]);
});

test("manual disconnect cancels a pending trace-resume decision without a late request", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  const resume = deferred();
  let asked = false;
  bus.on("trace-resume", () => { asked = true; return resume.promise; });
  await adapter.connect();
  await bus.emitAsync("shot-saved", { shotId: 42, stored: true, localShotId: "saved-42" });
  await flush();
  adapter._onDrop(); control.commands.length = 0;
  try {
    t.mock.timers.tick(1000); await flush();
    assert.equal(asked, true, "Reconnect did not inspect its pending trace");
    await adapter.disconnect();
    resume.resolve(true); await flush();
    assert.equal(adapter.connected, false);
    assert.ok(control.commands.every((command) => !command.startsWith("tracetimed:") && !command.startsWith("shotack:")));
  } finally { resume.resolve(false); }
});

test("a fully received trace still resumes when disconnect wins before its local commit", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  bus.on("trace-resume", () => true);
  await adapter.connect();
  await bus.emitAsync("shot-saved", { shotId: 42, stored: true, localShotId: "saved-42" });
  await flush();
  adapter._onTraceChunkReceived({ shotId: 42, timed: true, protocol: 2, totalChunks: 1, chunkIndex: 0 });
  await flush();
  assert.equal(adapter.currentTraceDownloadShotId, null);
  adapter._onDrop(); control.commands.length = 0;
  t.mock.timers.tick(1000); await flush();
  assert.ok(control.commands.includes("tracetimed:42"), "Last-chunk receipt lost the uncommitted replay");
});

test("a trace committed while disconnected is not requested again on reconnect", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  let resumes = 0;
  bus.on("trace-resume", () => { resumes += 1; return true; });
  await adapter.connect();
  await bus.emitAsync("shot-saved", { shotId: 42, stored: true, localShotId: "saved-42" });
  await flush();
  adapter._onDrop(); control.commands.length = 0;
  await bus.emitAsync("shot-trace-saved", { deviceShotId: 42, localShotId: "saved-42" });
  t.mock.timers.tick(1000); await flush();
  assert.equal(resumes, 0);
  assert.ok(control.commands.every((command) => !command.startsWith("tracetimed:")));
});

test("a stalled trace remains recoverable when the radio drop is reported after its timeout", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  bus.on("trace-resume", () => true);
  await adapter.connect();
  await bus.emitAsync("shot-saved", { shotId: 42, stored: true, localShotId: "saved-42" });
  await flush();
  adapter._onTraceChunkReceived({ shotId: 42, timed: true, protocol: 2, totalChunks: 2, chunkIndex: 0 });
  t.mock.timers.tick(8000); await flush();
  assert.equal(adapter.currentTraceDownloadShotId, null, "A stalled transfer did not let the queue proceed");
  adapter._onDrop(); control.commands.length = 0;
  t.mock.timers.tick(1000); await flush();
  assert.ok(control.commands.includes("tracetimed:42"), "Timeout forgot the acknowledged trace before the radio disconnect");
});

test("a failed resume lookup retains the trace for a later automatic reconnect", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  let checks = 0;
  bus.on("trace-resume", () => {
    if (++checks === 1) throw new Error("Local storage temporarily unavailable");
    return true;
  });
  await adapter.connect();
  await bus.emitAsync("shot-saved", { shotId: 42, stored: true, localShotId: "saved-42" });
  await flush();
  bus.on("log", () => { throw new Error("Log unavailable"); });
  adapter._onDrop(); control.commands.length = 0;
  t.mock.timers.tick(1000); await flush();
  assert.equal(adapter.connected, true);
  assert.equal(checks, 1);
  assert.ok(!control.commands.includes("tracetimed:42"), "Failed lookup requested an unbound trace");
  adapter._onDrop(); control.commands.length = 0;
  t.mock.timers.tick(1000); await flush();
  assert.equal(checks, 2);
  assert.ok(control.commands.includes("tracetimed:42"), "Failed lookup discarded the pending trace");
});

test("duplicate metadata with a missing trace queues one firmware transfer while re-acknowledging", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  await adapter.connect();
  control.commands.length = 0;
  const saved = { shotId: 42, stored: true, duplicate: true, traceNeeded: true,
    sourceConnection: { token: adapter.connectionToken, epoch: adapter.connectionEpoch } };
  await bus.emitAsync("shot-saved", saved);
  await flush();
  assert.deepEqual(control.commands, ["shotack:42", "tracetimed:42"]);
  await bus.emitAsync("shot-saved", saved);
  await flush();
  assert.equal(control.commands.filter((command) => command === "tracetimed:42").length, 1);
  assert.equal(control.commands.filter((command) => command === "shotack:42").length, 2);
});

test("BLE status and shot metadata retain the selected device identity independently of its name", async (t) => {
  const { adapter, bus, device, statuses } = bleFixture(t);
  device.id = "sensor-a";
  await adapter.connect();
  assert.equal(statuses.at(-1).deviceId, "OpenFloat-BLE:sensor-a");
  const shots = [];
  bus.on("shot", (shot) => shots.push(shot));
  device.name = "Another display name";
  const bytes = storedShotFrame(0);
  adapter._onValue({ target: { value: new DataView(bytes.buffer) } });
  assert.equal(shots[0].sourceConnection.deviceId, "OpenFloat-BLE:sensor-a");
});

test("a saved capture from another BLE device cannot acknowledge an otherwise matching connection", async (t) => {
  const { adapter, bus, device, control } = bleFixture(t);
  device.id = "sensor-b";
  await adapter.connect();
  control.commands.length = 0;
  await bus.emitAsync("shot-saved", { shotId: 0, stored: true, localShotId: "other-sensor-capture",
    sourceConnection: { token: adapter.connectionToken, epoch: adapter.connectionEpoch, deviceId: "OpenFloat-BLE:sensor-a" } });
  await flush();
  assert.deepEqual(control.commands, []);
  assert.equal(adapter.currentTraceDownloadShotId, null);
});

test("BLE shot frames keep their receiving connection and stop a batch after connection changes", async (t) => {
  const { adapter, bus } = bleFixture(t);
  await adapter.connect();
  const epoch = adapter.connectionEpoch;
  const received = [];
  bus.on("shot", (shot) => { received.push(shot); adapter.connectionEpoch += 1; });
  const bytes = new Uint8Array([...storedShotFrame(42), ...storedShotFrame(43)]);
  adapter._onValue({ target: { value: new DataView(bytes.buffer) } });
  assert.equal(received.length, 1, "A disconnected packet continued into another connection");
  assert.equal(received[0].sourceConnection.token, adapter.connectionToken);
  assert.equal(received[0].sourceConnection.epoch, epoch);
});

test("a BLE adapter ignores a saved capture received by a different adapter", async (t) => {
  const { adapter, bus, control } = bleFixture(t);
  await adapter.connect();
  control.commands.length = 0;
  await bus.emitAsync("shot-saved", { shotId: 42, stored: true,
    sourceConnection: { token: {}, epoch: adapter.connectionEpoch } });
  await flush();
  assert.deepEqual(control.commands, []);
  assert.equal(adapter.currentTraceDownloadShotId, null);
});

// Exercise the actual entry-point lifecycle with delayed transports, without
// booting the rest of the dashboard or mocking a browser's Bluetooth picker.
function appFixture({ supported = true } = {}) {
  const source = readFileSync(new URL("../app/main.js", import.meta.url), "utf8");
  const lifecycle = source.slice(source.indexOf("let adapter = null;"), source.indexOf("function thresholdGrams()"));
  const adapters = [];
  const context = {
    browserSupportUi: { check: () => supported },
    createAdapter: (kind) => {
      const connecting = deferred(), stopping = deferred();
      const adapter = {
        kind, connecting, stopping, commands: [], disconnects: 0,
        connect: () => connecting.promise,
        disconnect: () => { adapter.disconnects += 1; return stopping.promise; },
        sendControl: async (command) => adapter.commands.push(command),
      };
      adapters.push(adapter);
      return adapter;
    },
    store: { get: () => ({}) }, telemetry: { reset: () => true }, bus: { emit() {} },
    thresholdGrams: () => 5, wakeSensitivityGrams: () => 2, sleepTimeoutSeconds: () => 30,
    sleepSensitivityG: () => 0.1, bufferRateHz: () => 52, bufferNvsEnabled: () => 1,
    followThroughMs: () => 1500, streamRateDivider: () => 1, autoSleepEnabled: () => 1,
  };
  const api = runInNewContext(`${lifecycle}\n({ connect, disconnect, current: () => adapter });`, context);
  return { adapters, ...api };
}

test("unavailable Bluetooth never opens an adapter and keeps a working demo intact", async () => {
  const app = appFixture({ supported: false });
  await app.connect("ble");
  assert.equal(app.adapters.length, 0);
  const demo = app.connect("demo");
  await flush();
  const selected = app.adapters[0];
  selected.connecting.resolve();
  await demo;
  await app.connect("ble");
  assert.equal(app.current(), selected);
  assert.equal(selected.disconnects, 0);
  assert.equal(app.adapters.length, 1);
});

test("switching transport while an old disconnect is pending keeps only the latest choice", async () => {
  const app = appFixture();
  const initial = app.connect("demo");
  await flush();
  app.adapters[0].connecting.resolve();
  await initial;
  const earlier = app.connect("ble");
  await flush();
  const latest = app.connect("demo");
  await flush();
  assert.equal(app.adapters.length, 2);
  const selected = app.adapters[1];
  selected.connecting.resolve();
  await latest;
  app.adapters[0].stopping.resolve();
  await earlier;
  assert.equal(app.current(), selected);
  assert.equal(app.adapters.length, 2, "A superseded request created another adapter");
});

test("a replaced adapter's late connection failure cannot disconnect the current demo", async () => {
  const app = appFixture();
  const earlier = app.connect("ble");
  await flush();
  const latest = app.connect("demo");
  app.adapters[0].stopping.resolve();
  await flush();
  const selected = app.adapters[1];
  selected.connecting.resolve();
  await latest;
  app.adapters[0].connecting.reject(new Error("Picker canceled"));
  await flush();
  assert.equal(selected.disconnects, 0);
  await earlier;
  assert.equal(app.current(), selected);
});

test("a superseded BLE connection never sends its settings to the new demo", async () => {
  const app = appFixture();
  const earlier = app.connect("ble");
  await flush();
  const latest = app.connect("demo");
  app.adapters[0].stopping.resolve();
  await flush();
  const selected = app.adapters[1];
  selected.connecting.resolve();
  await latest;
  app.adapters[0].connecting.resolve();
  await earlier;
  assert.deepEqual(selected.commands, []);
});
