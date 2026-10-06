import test from "node:test";
import assert from "node:assert/strict";
import { DemoAdapter } from "../app/device/adapters.js";
import { EventBus, createStore } from "../app/core/store.js";
import { prepareTimedTrace } from "../app/protocol/trace.js";
import { TelemetryStore } from "../app/telemetry/telemetry.js";

test("slow manual streams keep their real duration and sample rate", () => {
  const points = Array.from({ length: 51 }, (_, index) => ({ tUs: 5000000 + index * 40000 }));
  const { payload, sampleRateHz } = prepareTimedTrace(points);
  assert.equal(payload.length, 51);
  assert.equal(payload[0].tUs, 0);
  assert.equal(payload.at(-1).tUs, 2000000);
  assert.equal(sampleRateHz, 25);
  assert.equal(points[0].tUs, 5000000, "Input timestamps must not be mutated");
});

test("high-rate manual streams are bounded without shortening replay or separating microphone samples", () => {
  const points = Array.from({ length: 5551 }, (_, index) => ({
    tUs: 8000000 + Math.round(index * 1000000 / 1110), micAmp: index, qw: 1,
  }));
  const { payload, sampleRateHz } = prepareTimedTrace(points);
  assert.ok(payload.length <= 262);
  assert.ok(payload.length >= 260);
  assert.equal(payload.at(-1).tUs, 5000000);
  assert.equal(sampleRateHz, 52);
  for (const point of payload) {
    assert.equal(point.tUs, points[point.micAmp].tUs - 8000000);
    assert.equal(point.qw, 1);
  }
});

test("timed replay keeps pauses and jitter instead of filling them with invented samples", () => {
  const points = [1000000, 1021000, 1044000, 3000000, 3028000].map((tUs) => ({ tUs }));
  const { payload } = prepareTimedTrace(points);
  assert.deepEqual(payload.map((point) => point.tUs), [0, 21000, 44000, 2000000, 2028000]);
});

test("untimed callers use their actual fallback rate and preserve the last point", () => {
  const points = [{ micAmp: 1 }, { micAmp: 2 }, { micAmp: 3 }];
  const { payload, sampleRateHz } = prepareTimedTrace(points, 52, 10);
  assert.deepEqual(payload.map((point) => point.tUs), [0, 100000, 200000]);
  assert.equal(sampleRateHz, 10);
  assert.deepEqual(prepareTimedTrace([]).payload, []);
  assert.deepEqual(prepareTimedTrace([{ tUs: 15 }]).payload, [{ tUs: 0 }]);
});

test("demo timing follows measured timer intervals, including delayed callbacks", async (t) => {
  let tick;
  let now = 1000;
  t.mock.method(globalThis, "setInterval", (callback) => { tick = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(performance, "now", () => now);
  const bus = new EventBus();
  const samples = [];
  bus.on("sample", (sample) => samples.push(sample));
  const demo = new DemoAdapter(bus);
  await demo.connect();
  for (const delay of [16, 20, 64]) { now += delay; tick(); }
  await demo.disconnect();
  assert.deepEqual(samples.map((sample) => sample.dtUs), [16000, 20000, 64000]);
  assert.equal(samples.reduce((sum, sample) => sum + sample.dtUs, 0), 100000);
});

function recorder(t) {
  t.mock.method(globalThis, "setInterval", () => 1);
  return new TelemetryStore(new EventBus(), createStore({ liveTraceDuration: 3, connected: true }));
}

function sample(sequence, dtUs) {
  return { sequence, dtUs, source: "demo", axMg: 0, ayMg: 0, azMg: 1000, rollDeg: 0, pitchDeg: 0, yawDeg: 0 };
}

test("manual capture buffers retain each ingested sample timestamp", (t) => {
  const telemetry = recorder(t);
  telemetry.startManualRecording("Timing check");
  [1000, 5000, 2000].forEach((dtUs, index) => telemetry.ingest(sample(index, dtUs)));
  assert.deepEqual(telemetry.manualRecordingBuffer.map((point) => point.tUs), [1000, 6000, 8000]);
  assert.equal(telemetry.manualRecordingDurationUs, 8000);
});

test("the rolling capture retains at most thirty seconds even on a slow stream", (t) => {
  const telemetry = recorder(t);
  for (let index = 0; index < 311; index += 1) telemetry.ingest(sample(index, 100000));
  assert.equal(telemetry.history30s.at(-1).tUs - telemetry.history30s[0].tUs, 30000000);
  assert.equal(telemetry.history30s.length, 301);
});

test("disconnect freezes manual recordings and prevents reset or replacement until save or discard", (t) => {
  const telemetry = recorder(t);
  assert.equal(telemetry.startManualRecording("Keep this hold"), true);
  telemetry.ingest(sample(0, 10000));
  telemetry.bus.emit("status", { mode: "", text: "Disconnected" });
  telemetry.ingest(sample(3, 10000));
  assert.equal(telemetry.manualRecordingBuffer.length, 1);
  assert.equal(telemetry.manualRecordingEndLost, 0);
  assert.equal(telemetry.store.get().manualRecordingActive, true);
  assert.equal(telemetry.store.get().manualRecordingPaused, true);
  assert.match(telemetry.store.get().manualRecordMessage, /Save or discard/);
  assert.equal(telemetry.reset(), false);
  telemetry.store.set({ connected: true });
  assert.equal(telemetry.startManualRecording("Replacement"), false);
  assert.equal(telemetry.manualRecordingLabel, "Keep this hold");
  assert.equal(telemetry.discardManualRecording(), true);
  assert.equal(telemetry.reset(), true);
  assert.equal(telemetry.manualRecordingBuffer.length, 0);
});

test("pending recording saves reject discard, reset, replacement and duplicate save", async (t) => {
  const telemetry = recorder(t);
  telemetry.startManualRecording("Pending hold");
  telemetry.ingest(sample(0, 10000));
  telemetry.isSavingManual = true;
  assert.equal(telemetry.discardManualRecording(), false);
  assert.equal(telemetry.reset(), false);
  assert.equal(telemetry.startManualRecording("Replacement"), false);
  assert.equal(await telemetry.saveManualRecording(), null);
  assert.equal(telemetry.manualRecordingBuffer.length, 1);
});

test("manual start and discard complete despite synchronous and asynchronous log failures", async (t) => {
  const telemetry = recorder(t);
  telemetry.bus.on("log", () => { throw new Error("Log unavailable"); });
  telemetry.bus.on("log", async () => { throw new Error("Delayed log failure"); });
  assert.equal(telemetry.startManualRecording("Keep collecting"), true);
  telemetry.ingest(sample(0, 20000));
  assert.equal(telemetry.isRecordingManual, true);
  assert.equal(telemetry.manualRecordingBuffer.length, 1);
  assert.equal(telemetry.discardManualRecording(), true);
  assert.equal(telemetry.manualRecordingBuffer.length, 0);
  assert.equal(telemetry.store.get().manualRecordingActive, false);
  await Promise.resolve();
});

test("saving an empty recording retains collection and explains the missing data despite a log failure", async (t) => {
  const telemetry = recorder(t);
  telemetry.bus.on("log", () => { throw new Error("Log unavailable"); });
  telemetry.startManualRecording("Waiting for data");
  assert.equal(await telemetry.saveManualRecording(), null);
  assert.equal(telemetry.isRecordingManual, true);
  assert.ok(!telemetry.isSavingManual);
  assert.equal(telemetry.store.get().manualRecordingActive, true);
  assert.match(telemetry.store.get().manualRecordMessage, /No samples to save/);
  telemetry.ingest(sample(0, 20000));
  assert.equal(telemetry.manualRecordingBuffer.length, 1);
});

test("transport reset also waits for a committed manual capture's pending refresh", (t) => {
  const telemetry = recorder(t);
  telemetry.ingest(sample(0, 20000));
  telemetry.isSavingManual = true;
  telemetry.store.set({ manualRecordingActive: false, manualRecordingSaving: true });
  const epoch = telemetry.connectionEpoch;
  assert.equal(telemetry.reset(), false);
  assert.equal(telemetry.connectionEpoch, epoch);
  assert.equal(telemetry.history30s.length, 1);
  telemetry.isSavingManual = false;
  telemetry.store.set({ manualRecordingSaving: false });
  assert.equal(telemetry.reset(), true);
  assert.equal(telemetry.history30s.length, 0);
});

test("delayed browser captures retain their original connection buffers", async (t) => {
  const telemetry = recorder(t);
  let freeze;
  let context;
  t.mock.method(globalThis, "setTimeout", (callback) => { freeze = callback; return 1; });
  telemetry.saveBrowserShotTrace = async (...args) => { context = args.at(-1); };
  telemetry.ingest(sample(0, 20000));
  telemetry.scheduleBrowserShotTraceCapture("saved", 1, 20000, {}, 1500, 52, 0);
  telemetry.ingest(sample(1, 20000));
  const originalMotion = telemetry.shotTraceBuffer;
  const originalMic = telemetry.micRingBuffer;
  telemetry.reset();
  telemetry.ingest(sample(0, 90000));
  await freeze();
  assert.equal(context.motion, originalMotion);
  assert.equal(context.mic, originalMic);
  assert.notEqual(context.epoch, telemetry.connectionEpoch);
  assert.deepEqual(context.motion.map((point) => point.tUs), [20000, 40000]);
  assert.deepEqual(telemetry.shotTraceBuffer.map((point) => point.tUs), [90000]);
});

test("concurrent device frames share one save and a failed attempt can retry", async (t) => {
  const telemetry = recorder(t);
  let release;
  let calls = 0;
  telemetry.saveDeviceShot = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    throw new Error("Storage unavailable");
  };
  const first = telemetry.onShot({ shotId: 42 });
  const second = telemetry.onShot({ shotId: 42 });
  assert.equal(calls, 1);
  release();
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  assert.equal(telemetry.pendingShotSaves.size, 0);
  telemetry.saveDeviceShot = async () => "retry-saved";
  assert.equal(await telemetry.onShot({ shotId: 42 }), "retry-saved");
});

test("an old connection's save cannot clear the new connection's pending shot", async (t) => {
  const telemetry = recorder(t);
  const releases = [];
  telemetry.saveDeviceShot = () => new Promise((resolve) => releases.push(resolve));
  const first = telemetry.onShot({ shotId: 42 });
  telemetry.bus.emit("status", { mode: "off", text: "Disconnected" });
  const second = telemetry.onShot({ shotId: 42 });
  releases[0]("old-capture");
  await first;
  assert.equal(telemetry.pendingShotSaves.size, 1);
  releases[1]("new-capture");
  assert.equal(await second, "new-capture");
  assert.equal(telemetry.pendingShotSaves.size, 0);
});

test("invalid firmware chunks do not allocate pending trace buffers", async (t) => {
  const telemetry = recorder(t);
  for (const [chunkIndex, totalChunks] of [[-1, 3], [3, 3], [0, 0], [0, 1.5], [NaN, 2]]) {
    await telemetry.onTraceChunk({ shotId: 42, chunkIndex, totalChunks });
  }
  assert.equal(telemetry.pendingTraces.size, 0);
});

test("firmware progress, conflict and invalid-frame handling survive failing log listeners", async (t) => {
  const telemetry = recorder(t);
  telemetry.bus.on("log", () => { throw new Error("Log unavailable"); });
  telemetry.bus.on("log", async () => { throw new Error("Delayed log failure"); });
  const chunk = { shotId: 42, chunkIndex: 0, totalChunks: 2, pointStride: 7,
    payload: new Uint8Array([0, 0, 0, 0, 0, 0, 12]) };
  await telemetry.onTraceChunk(chunk);
  assert.equal(telemetry.pendingTraces.get(42).chunks.size, 1);
  await telemetry.onTraceChunk({ ...chunk, payload: new Uint8Array([0, 0, 0, 0, 0, 0, 13]) });
  assert.equal(telemetry.pendingTraces.size, 0, "A conflicting frame must clear the partial transfer");
  await telemetry.onTraceChunk({ ...chunk, chunkIndex: -1 });
  assert.equal(telemetry.pendingTraces.size, 0, "Invalid frames must not allocate a new transfer");
});

test("a missing browser trace stays a no-op when its explanatory log fails", async (t) => {
  const telemetry = recorder(t);
  let notified = 0, syncs = 0;
  telemetry.bus.on("log", () => { throw new Error("Log unavailable"); });
  telemetry.bus.on("shot-trace-saved", () => { notified += 1; });
  telemetry.syncAdapter = { triggerSync() { syncs += 1; } };
  await telemetry.saveBrowserShotTrace("missing-samples", 42, 10000, {}, 52);
  assert.equal(notified, 0);
  assert.equal(syncs, 0);
  assert.equal(telemetry.shotTraceBuffer.length, 0);
});

test("firmware assembly bounds payload bytes, chunk counts and supported protocols", async (t) => {
  const telemetry = recorder(t);
  const chunk = { shotId: 42, chunkIndex: 0, totalChunks: 2, pointStride: 7, payload: new Uint8Array(15), protocol: 2 };
  for (const invalid of [
    { totalChunks: 535 }, { shotId: -1 }, { shotId: 0x100000000 },
    { protocol: 3 }, { pointStride: 11 }, { payload: new Uint8Array(16) },
    { payload: [] }, { payload: [256] }, { payload: [NaN] }, { payload: [1.2] },
  ]) await telemetry.onTraceChunk({ ...chunk, ...invalid });
  assert.equal(telemetry.pendingTraces.size, 0);
});

test("automatic reconnect starts fresh trace buffers and sequence tracking", (t) => {
  const telemetry = recorder(t);
  telemetry.ingest(sample(100, 20000));
  const beforeDrop = telemetry.shotTraceBuffer;
  telemetry.bus.emit("status", { mode: "off", text: "Disconnected" });
  telemetry.bus.emit("status", { mode: "live", text: "Connected" });
  telemetry.ingest(sample(0, 20000));
  assert.equal(beforeDrop.length, 1);
  assert.notEqual(telemetry.shotTraceBuffer, beforeDrop);
  assert.equal(telemetry.shotTraceBuffer.length, 1);
  assert.equal(telemetry.lost, 0, "Sequence restart must not report billions of lost frames");
});
