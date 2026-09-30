import test from "node:test";
import assert from "node:assert/strict";
import { tracePhases, phaseForIndex } from "../app/ui/trace-phases.js";
import { drawTraceChart } from "../app/ui/trace-chart.js";
import { drawTraceTargetPreview } from "../app/ui/trace-preview.js";
import { createStore } from "../app/core/store.js";

const points = (count = 100, peak = -1) => Array.from({ length: count }, (_, index) => ({
  tUs: (index - 20) * 20000, ax: 0, ay: 0, az: index === peak ? 16 : 1,
  roll: Math.sin(index / 10), pitch: Math.cos(index / 10), yaw: 0,
}));

test("long holds and current firmware traces never invent a release", () => {
  for (const [trace, options] of [
    [points(), {}],
    [points(100, 40), { captureKind: "hold" }],
    [points(100, 99), { source: "firmware", thresholdG: 4 }],
  ]) {
    const phases = tracePhases(trace, options);
    assert.equal(phases.hasRelease, false);
    assert.deepEqual(phases.segments, { hold: 100, break: 0, release: 0, follow: 0 });
    assert.equal(phaseForIndex(62, phases), "hold");
  }
});

test("measured impulses respect the capture threshold and missing axes stay unavailable", () => {
  const trace = points(100, 35);
  assert.equal(tracePhases(trace, { thresholdG: 12 }).releaseIdx, 35);
  assert.equal(tracePhases(trace, { thresholdG: 18 }).hasRelease, false);
  assert.equal(tracePhases(trace.map(({ ax, ay, az, ...point }) => point)).hasRelease, false);
  assert.equal(tracePhases([{ ax: null, ay: false, az: "50" }, {}]).hasRelease, false);
});

test("automatic browser captures use their recorded event time when the impulse was downsampled", () => {
  const phases = tracePhases(points(100, 75), { source: "browser", captureKind: "arrow" });
  assert.equal(phases.hasRelease, true);
  assert.equal(phases.releaseIdx, 20);
  assert.equal(tracePhases(points(), { source: "browser", captureKind: "hold" }).hasRelease, false);
  assert.equal(tracePhases(points().map(({ tUs, ...point }) => point), { source: "browser", captureKind: "arrow" }).hasRelease, false);
});

test("timed device captures mark the exact release between samples without inventing acceleration", () => {
  const trace = points().map(({ ax, ay, az, ...point }) => ({ ...point, tUs: point.tUs + 3000 }));
  const options = { source: "firmware-timed", captureKind: "arrow" };
  const phases = tracePhases(trace, options);
  assert.equal(phases.hasRelease, true);
  assert.equal(phases.releaseIdx, 20);
  assert.equal(phases.releaseTimeMs, 0);
  assert.ok(Math.abs(Object.values(phases.segments).reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
  assert.equal(tracePhases(trace, { ...options, captureKind: "hold" }).hasRelease, false);
  assert.equal(tracePhases(trace, { ...options, source: "firmware" }).hasRelease, false);
  assert.equal(tracePhases(trace.slice(30), options).hasRelease, false, "Release outside the recorded window must stay hidden");
});

test("phase rail proportions follow sample timestamps and remain bounded at trace edges", () => {
  const trace = points(20, 8).map((point, index) => ({ ...point, tUs: index < 8 ? index * 10000 : 2000000 + index * 10000 }));
  const phases = tracePhases(trace);
  assert.ok(phases.segments.break > 90, "Recorded gap was replaced with a sample-count duration");
  for (const peak of [0, 19]) {
    const edge = tracePhases(points(20, peak));
    assert.ok(Object.values(edge.segments).every((value) => value >= 0 && value <= 100));
    assert.ok(Math.abs(Object.values(edge.segments).reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
    assert.equal(phaseForIndex(peak, edge), "release");
  }
});

function drawing(t) {
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.document = { documentElement: {} };
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => { delete globalThis.getComputedStyle; delete globalThis.document; delete globalThis.window; });
  const arcs = [], labels = [], strokes = [];
  const ctx = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === "arc") return (x, y, radius) => arcs.push({ x, y, radius, color: target.strokeStyle });
    if (key === "fillText") return (text) => labels.push(text);
    if (key === "stroke") return () => strokes.push(target.strokeStyle);
    if (key === "measureText") return () => ({ width: 20 });
    return () => {};
  } });
  const canvas = { style: {}, clientWidth: 120, closest: () => ({ clientWidth: 120 }),
    getContext: () => ctx, getBoundingClientRect: () => ({ width: 400, height: 400 }) };
  return { ctx, canvas, arcs, labels, strokes };
}

test("review and thumbnail rendering suppress hold reticles but retain narrow recorded releases", (t) => {
  const { ctx, canvas, arcs, labels } = drawing(t);
  const trace = points(1000, 501);
  const store = createStore({ reviewMode: true, chartView: "target", reviewTrace: trace, reviewCaptureKind: "hold", replayProgress: 1 });
  drawTraceChart(ctx, canvas, store, {});
  assert.ok(!arcs.some(({ radius }) => radius === 12), "Hold acquired a release reticle");
  assert.ok(labels.includes("green = hold recording"));
  arcs.length = 0;
  drawTraceTargetPreview(canvas, trace, { captureKind: "hold" });
  assert.ok(!arcs.some(({ color }) => color === "#FF5D73"), "Hold thumbnail acquired a release reticle");
  arcs.length = 0;
  drawTraceTargetPreview(canvas, trace, { captureKind: "arrow" });
  assert.ok(arcs.some(({ color }) => color === "#FF5D73"), "Thumbnail decimation removed the recorded release");
});

test("firmware motion view plots recorded angles instead of old acceleration placeholders", (t) => {
  const { ctx, canvas, labels } = drawing(t);
  const store = createStore({ reviewMode: true, chartView: "line", reviewTrace: points(100, 99), reviewTraceSource: "firmware" });
  drawTraceChart(ctx, canvas, store, {});
  assert.ok(labels.includes("roll (deg)") && labels.includes("pitch (deg)"));
  assert.ok(!labels.includes("ax") && !labels.includes("az"));
  assert.ok(!labels.includes("release") && !labels.includes("follow"));
});
