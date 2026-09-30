import test from "node:test";
import assert from "node:assert/strict";

import {
  TRAINING_DRILLS,
  analyzeTrainingHistory,
  downsampleTrainingTrace,
  scoreTrainingHold,
  trainingFeedback,
} from "../app/ui/training-coach.js";

function smoothHold(count = 20, amplitude = 0.1) {
  return Array.from({ length: count }, (_, index) => ({
    roll: Math.sin(index) * amplitude,
    pitch: Math.cos(index) * amplitude,
    gx: 0,
    gy: 0,
    gz: 0,
  }));
}

test("adaptive coach starts with a transparent baseline recommendation", () => {
  assert.deepEqual(analyzeTrainingHistory([]), {
    drillId: "steady",
    title: "Build your training baseline",
    reason: "Complete and save a hold with your sensor to compare stability and bow-level control. Demo captures do not affect your baseline.",
    focusLabel: "Baseline",
    baseline: null,
    target: TRAINING_DRILLS.steady.defaultTarget,
    shotCount: 0,
  });
});

test("adaptive coach prescribes the weakest available recent metric", () => {
  const analysis = analyzeTrainingHistory([
    { timestamp: "2026-01-01T00:00:00Z", hold_stability: 78, level_consistency: 70 },
    { timestamp: "2026-01-02T00:00:00Z", hold_stability: 82, level_consistency: 60 },
    { timestamp: "2025-01-01T00:00:00Z", hold_stability: 5, level_consistency: 99 },
  ], { limit: 2 });

  assert.equal(analysis.drillId, "level");
  assert.equal(analysis.baseline, 65);
  assert.equal(analysis.target, 70);
  assert.equal(analysis.shotCount, 2);
});

test("adaptive coach ignores missing component scores and caps stretch targets", () => {
  const analysis = analyzeTrainingHistory([
    { timestamp: "2026-01-02T00:00:00Z", hold_stability: 99, level_consistency: null },
    { timestamp: "2026-01-01T00:00:00Z", hold_stability: 97 },
  ]);

  assert.equal(analysis.drillId, "steady");
  assert.equal(analysis.baseline, 98);
  assert.equal(analysis.target, 95);
});

test("sample and synthetic captures never change the personal training baseline", () => {
  const demo = [
    { sample: true, hold_stability: 0, level_consistency: 100 },
    { device_id: "OpenFloat-Demo", hold_stability: 0, level_consistency: 100 },
  ];
  assert.deepEqual(analyzeTrainingHistory(demo), analyzeTrainingHistory([]));
  const real = { timestamp: "2026-01-01", hold_stability: 90, level_consistency: 80 };
  assert.deepEqual(analyzeTrainingHistory([real, ...demo]), analyzeTrainingHistory([real]));
});

test("unscored captures do not displace usable history from the recent window", () => {
  const real = { timestamp: "2026-01-01", hold_stability: 80, level_consistency: 70 };
  const invalid = [null, undefined, "", "  ", false, true, [], {}, "bad"];
  const newer = invalid.map((value) => ({
    timestamp: "2026-02-01", hold_stability: value, level_consistency: value,
  }));
  assert.deepEqual(analyzeTrainingHistory([...newer, real], { limit: 1 }), analyzeTrainingHistory([real]));
  assert.equal(analyzeTrainingHistory([{ hold_stability: "0" }]).baseline, 0);
});

test("steady drill rewards a quiet hold with deterministic motion metrics", () => {
  const result = scoreTrainingHold(smoothHold());

  assert.equal(result.drillId, "steady");
  assert.equal(result.score, 97);
  assert.equal(result.withinTolerancePct, 100);
  assert.ok(result.maxFloat > 0.19 && result.maxFloat < 0.2);
});

test("level drill scores calibrated time inside the configured tolerance", () => {
  const samples = [
    ...Array.from({ length: 8 }, () => ({ roll: 0.5, pitch: 0 })),
    ...Array.from({ length: 2 }, () => ({ roll: 3, pitch: 0 })),
  ];
  const result = scoreTrainingHold(samples, { drillId: "level", levelTolerance: 2 });
  const feedback = trainingFeedback(result, 85);

  assert.equal(result.score, 76);
  assert.equal(result.withinTolerancePct, 80);
  assert.equal(feedback.metTarget, false);
  assert.match(feedback.text, /80%/);
});

test("settle drill detects a hold that becomes quieter", () => {
  const samples = [
    ...smoothHold(10, 0.8).map((sample) => ({ ...sample, gx: 5 })),
    ...smoothHold(20, 0.1),
  ];
  const result = scoreTrainingHold(samples, { drillId: "settle" });

  assert.equal(result.drillId, "settle");
  assert.equal(result.score, 98);
  assert.ok(result.settleChange > 20);
  assert.equal(trainingFeedback(result, 80).metTarget, true);
});

test("training scoring handles empty and malformed samples", () => {
  assert.deepEqual(scoreTrainingHold([null, { roll: "bad", pitch: 0 }]), {
    drillId: "steady",
    score: 0,
    avgCantDev: 0,
    avgPitchDev: 0,
    maxFloat: 0,
    withinTolerancePct: 0,
    settleChange: 0,
  });
});

test("saved training traces are bounded to their declared sample rate", () => {
  const fullRate = Array.from({ length: 1000 }, (_, index) => ({
    timestamp: index,
    roll: index,
  }));
  const downsampled = downsampleTrainingTrace(fullRate, 50);

  assert.ok(downsampled.length >= 50 && downsampled.length <= 52);
  assert.equal(downsampled[0], fullRate[0]);
  assert.equal(downsampled.at(-1), fullRate.at(-1));

  const alreadySlow = fullRate.slice(0, 10).map((point, index) => ({
    ...point,
    timestamp: index * 100,
  }));
  assert.deepEqual(downsampleTrainingTrace(alreadySlow, 52), alreadySlow);
});
