import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../app/core/store.js";
import { createReplayController, replayPosition, traceTimeline, timelineIndexAt } from "../app/ui/replay.js";
import { drawTraceChart, reviewChartTimeRangeUs } from "../app/ui/trace-chart.js";

const gappedTrace = [0, 10000, 20000, 4000000].map((tUs, index) => ({ tUs, roll: index, pitch: 0, az: 1 }));

test("replay uses measured duration and holds the last known point through a gap", () => {
  assert.deepEqual(replayPosition(gappedTrace, 0.5, 52), { timeUs: 2000000, durationUs: 4000000, index: 2 });
  assert.equal(replayPosition(gappedTrace, 0).index, 0);
  assert.equal(replayPosition(gappedTrace, 0.999).index, 2);
  assert.equal(replayPosition(gappedTrace, 1).index, 3);
  const centered = [-3500000, -3400000, 0, 1500000].map((tUs) => ({ tUs }));
  assert.deepEqual(replayPosition(centered, 0.5), { timeUs: -1000000, durationUs: 5000000, index: 1 });
});

test("legacy and unusable imported timing use one uniform sample-rate clock", () => {
  const legacy = Array.from({ length: 105 }, () => ({}));
  assert.deepEqual(replayPosition(legacy, 0.5, 52), { timeUs: 1000000, durationUs: 2000000, index: 52 });
  for (const times of [[null, 100, 200], [0, undefined, 200], [0, 300, 200], [0, 0, 0]]) {
    assert.deepEqual(traceTimeline(times.map((tUs) => ({ tUs })), 2).times, [0, 500000, 1000000]);
  }
  assert.equal(traceTimeline([{ tUs: "-5" }, { tUs: "5" }]).durationUs, 10);
  assert.equal(traceTimeline([{}, {}], 0).durationUs, 1000000 / 52);
  assert.equal(replayPosition([], 0).index, -1);
  assert.equal(traceTimeline([{ tUs: 10 }]).durationUs, 0);
});

test("microphone samples and marker coordinates share the motion time axis", () => {
  const motion = [-3500000, 0, 1500000].map((tUs) => ({ tUs }));
  const mic = [-500000, 100000, 900000, 1800000].map((tUs) => ({ tUs }));
  const timeline = traceTimeline(mic);
  assert.equal(timelineIndexAt(timeline, replayPosition(motion, 0.1).timeUs), -1);
  assert.equal(timelineIndexAt(timeline, replayPosition(motion, 0.7).timeUs), 0);
  assert.equal(timelineIndexAt(timeline, replayPosition(motion, 1).timeUs), 2, "Future audio must not appear early");
  assert.deepEqual(reviewChartTimeRangeUs({ reviewTrace: motion, reviewMicSeries: mic }), { start: -3500000, end: 1800000 });
  assert.deepEqual(reviewChartTimeRangeUs({ reviewTrace: [{}, {}, {}], reviewSampleRateHz: 2 }), { start: 0, end: 1000000 });
});

function playback(t) {
  let now = 0;
  let nextId = 0;
  const callbacks = new Map();
  t.mock.method(performance, "now", () => now);
  globalThis.requestAnimationFrame = (callback) => { callbacks.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
  t.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; });
  const store = createStore({ reviewMode: true, chartView: "target", reviewShotId: "one", reviewTrace: gappedTrace,
    reviewSampleRateHz: 52, replaySpeed: 1, replayProgress: 1, replayActive: false, replayPaused: false });
  const controls = createReplayController(store);
  const advance = (ms) => {
    now += ms;
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(now));
  };
  return { store, controls, callbacks, advance };
}

test("1x replay follows recorded seconds, speed changes apply live, and pause excludes elapsed wall time", (t) => {
  const { store, controls, callbacks, advance } = playback(t);
  controls.toggle();
  advance(1000);
  assert.equal(store.get().replayProgress, 0.25);
  store.set({ replaySpeed: 2 });
  advance(500);
  assert.equal(store.get().replayProgress, 0.5);
  controls.toggle();
  assert.equal(callbacks.size, 0);
  advance(20000);
  assert.equal(store.get().replayProgress, 0.5);
  controls.toggle();
  advance(1000);
  assert.equal(store.get().replayProgress, 1);
  assert.equal(store.get().replayActive, false);
  assert.equal(callbacks.size, 0);
});

test("rapid pause/resume and scrubbing cannot leave competing replay loops", (t) => {
  const { store, controls, callbacks, advance } = playback(t);
  controls.toggle();
  const stale = [...callbacks.values()][0];
  controls.toggle();
  controls.toggle();
  stale(500);
  assert.equal(callbacks.size, 1);
  advance(1000);
  assert.equal(store.get().replayProgress, 0.25);
  controls.seek(0.6);
  assert.equal(callbacks.size, 0);
  advance(2000);
  assert.equal(store.get().replayProgress, 0.6);
  assert.equal(store.get().replayActive, false);
});

test("switching the reviewed capture or leaving review stops the old animation", (t) => {
  const { store, controls, callbacks, advance } = playback(t);
  controls.toggle();
  store.set({ reviewShotId: "two", replayProgress: 1, replayActive: false });
  advance(1000);
  assert.equal(store.get().replayProgress, 1);
  assert.equal(callbacks.size, 0);
  controls.toggle();
  store.set({ reviewMode: false, replayActive: false });
  advance(1000);
  assert.equal(callbacks.size, 0);
});

test("target rendering uses the same timed sample as numeric and 3D review", (t) => {
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.document = { documentElement: {} };
  t.after(() => { delete globalThis.getComputedStyle; delete globalThis.document; });
  const dots = [];
  const ctx = new Proxy({}, { get: (_, key) => key === "arc" ? (x, y, r) => { if (r === 6) dots.push({ x, y }); } : () => {} });
  const canvas = { getBoundingClientRect: () => ({ width: 400, height: 400 }) };
  const store = createStore({ reviewMode: true, chartView: "target", reviewTrace: gappedTrace, replayProgress: 0.5 });
  drawTraceChart(ctx, canvas, store, {});
  const midwayDot = dots.at(-1);
  store.set({ replayProgress: 0.99 });
  drawTraceChart(ctx, canvas, store, {});
  assert.deepEqual(dots.at(-1), midwayDot, "Pin must hold still through the recorded gap");
  store.set({ replayProgress: 1 });
  drawTraceChart(ctx, canvas, store, {});
  assert.notDeepEqual(dots.at(-1), midwayDot, "Final sample must appear at its timestamp");
});

test("audio draws within the canvas and shares the marker axis in both review views", (t) => {
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.document = { documentElement: {} };
  t.after(() => { delete globalThis.getComputedStyle; delete globalThis.document; });
  const labels = [];
  const lines = [];
  const ctx = new Proxy({}, { get: (_, key) => {
    if (key === "moveTo" || key === "lineTo") return (x, y) => {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${key} received invalid coordinates`);
      lines.push({ x, y });
    };
    if (key === "fillText") return (text, x, y) => labels.push({ text, x, y });
    if (key === "measureText") return () => ({ width: 15 });
    return () => {};
  } });
  const canvas = { getBoundingClientRect: () => ({ width: 400, height: 400 }) };
  const trace = [-3000000, 0, 1000000].map((tUs) => ({ tUs, az: 1, micAmp: 10 }));
  for (const chartView of ["target", "line"]) {
    labels.length = 0;
    lines.length = 0;
    const store = createStore({ reviewMode: true, chartView, reviewTrace: trace,
      reviewMicSeries: [{ tUs: -1000000, micAmp: 10 }, { tUs: 2000000, micAmp: 30 }],
      reviewReleaseTimeMs: 0, reviewHitTimeMs: 1000, replayProgress: 1 });
    drawTraceChart(ctx, canvas, store, {});
    assert.ok(labels.some(({ text }) => text === "Audio"), "Audio band was not rendered");
    assert.equal(labels.find(({ text }) => text === "RELEASE")?.x, 236);
    assert.equal(labels.find(({ text }) => text === "HIT")?.x, 324);
    assert.ok(lines.some(({ x, y }) => x === 400 && y === 400), "Audio tail did not reach its timestamp");
  }
});
