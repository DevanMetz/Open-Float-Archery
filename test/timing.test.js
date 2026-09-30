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
  return new TelemetryStore(new EventBus(), createStore({ liveTraceDuration: 3 }));
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
