import test from "node:test";
import assert from "node:assert/strict";
import { arrowSpeedFps, calculateRangeFromTimes, findImpactTimeMs, formatRangeEstimate } from "../app/telemetry/range.js";

test("arrow speeds accept positive numbers and imported numeric strings without coercing missing data", () => {
  assert.equal(arrowSpeedFps(280), 280);
  assert.equal(arrowSpeedFps(" 240.5 "), 240.5);
  for (const value of [null, undefined, "", "  ", false, true, [], {}, "bad", NaN, Infinity, 0, -10]) {
    assert.equal(arrowSpeedFps(value), null);
  }
});

test("range estimates require finite release, impact, and speed measurements", () => {
  for (const value of [null, undefined, "", "0", false, NaN, Infinity]) {
    assert.equal(calculateRangeFromTimes(value, 659, 280), null);
    assert.equal(calculateRangeFromTimes(0, value, 280), null);
  }
  for (const speed of [null, false, 0, -1, NaN, Infinity, "bad"]) {
    assert.equal(calculateRangeFromTimes(0, 659, speed), null);
  }
  assert.equal(calculateRangeFromTimes(1000, 1000, 280), null);
  assert.equal(calculateRangeFromTimes(1000, 500, 280), null);
  assert.equal(calculateRangeFromTimes(-Number.MAX_VALUE, Number.MAX_VALUE, 280), null);
});

test("range estimates recover known distances from the existing flight and sound approximation", () => {
  for (const feet of [30, 60, 90, 150]) {
    for (const fps of [240, 280, 320]) {
      const elapsedMs = (feet / (fps - 0.075 * feet) + feet / 1125) * 1000;
      const range = calculateRangeFromTimes(-200, elapsedMs - 200, String(fps));
      assert.ok(Math.abs(range.feet - feet) < 1e-8);
      assert.ok(Math.abs(range.yards - feet / 3) < 1e-8);
    }
  }
});

test("range labels disclose assumed and current-bow speeds", () => {
  const range = calculateRangeFromTimes(0, 659, 280);
  assert.match(formatRangeEstimate(range, { fps: 280, source: "assumed" }), /@ 280 fps \(assumed\)$/);
  assert.match(formatRangeEstimate(range, { fps: 280, source: "active" }), /@ 280 fps \(current bow\)$/);
  assert.match(formatRangeEstimate(range, { fps: 280, source: "assigned" }), /@ 280 fps$/);
  assert.equal(formatRangeEstimate(null, null), "");
});

const mic = (tUs, micAmp) => ({ tUs, micAmp });

test("impact detection uses measured microphone times and the leading edge of the first later peak", () => {
  const series = [mic(-100000, 0), mic(100000, 100), mic(200000, 0), mic(659000, 0),
    mic(660000, 18), mic(661000, 40), mic(662000, 0), mic(900000, 200)];
  assert.equal(findImpactTimeMs(series, 0), 659);
  const shifted = series.map((point) => ({ tUs: point.tUs - 123000, micAmp: point.micAmp }));
  assert.equal(findImpactTimeMs(shifted, -123), 536);
  const imported = series.map((point) => ({ tUs: String(point.tUs), micAmp: String(point.micAmp) }));
  assert.equal(findImpactTimeMs(imported, 0), 659);
});

test("impact detection stays inside its post-release window and does not invent a missing peak", () => {
  assert.equal(findImpactTimeMs([mic(100000, 80), mic(200000, 0), mic(2201000, 80)], 0), null);
  assert.equal(findImpactTimeMs([mic(200000, 15), mic(500000, 10)], 0), null);
  assert.equal(findImpactTimeMs([mic(200000, 0), mic(2199000, 0), mic(2200000, 30)], 0), 2199);
  assert.equal(findImpactTimeMs([], 0), null);
  assert.equal(findImpactTimeMs([mic(200000, 30)], null), null);
});

test("invalid or unordered microphone timing cannot produce an impact marker", () => {
  for (const series of [
    [mic(500000, 0), mic(400000, 30)], [mic(NaN, 0), mic(659000, 30)],
    [mic(null, 0), mic(659000, 30)], [mic(500000, 0), mic(659000, Infinity)],
    [mic(500000, 0), mic(659000, -30)], [null, mic(659000, 30)],
  ]) assert.equal(findImpactTimeMs(series, 0), null);
});
