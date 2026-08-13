import test from "node:test";
import assert from "node:assert/strict";

import {
  canRecordArrowOutcome,
  correlateDirectionalImpacts,
  correlateOutcomesWithForm,
  formatShotOutcome,
  impactDirectionLabel,
  normalizeArrowOutcome,
  normalizeImpact,
  scoreForImpact,
  summarizeImpactGroup,
  summarizeSessionOutcomes,
} from "../app/telemetry/outcome.js";

function scoredShot(index, overrides = {}) {
  return {
    id: `shot-${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 12, index)).toISOString(),
    peak_g: 20,
    arrow_score: index,
    arrow_is_x: false,
    target_distance: 20,
    target_distance_unit: "yd",
    target_face_cm: 40,
    hold_stability: 50 + index * 4,
    release_quality: 40 + index * 5,
    follow_through: 80 - index,
    level_consistency: 55 + index * 3,
    ...overrides,
  };
}

test("normalizes miss, ten, and X outcomes with optional target context", () => {
  assert.deepEqual(normalizeArrowOutcome({ arrow_score: 0 }), {
    score: 0,
    isX: false,
    label: "M",
    distance: null,
    distanceUnit: "yd",
    faceCm: null,
  });
  assert.equal(formatShotOutcome({ arrow_score: 10, arrow_is_x: false }), "10");
  assert.equal(formatShotOutcome({
    arrow_score: 10,
    arrow_is_x: true,
    target_distance: 18,
    target_distance_unit: "m",
    target_face_cm: 40,
  }, { includeContext: true }), "X at 18 m / 40 cm face");
  assert.equal(normalizeArrowOutcome({ arrow_score: 11 }), null);
  assert.equal(normalizeArrowOutcome({ arrow_score: null }), null);
});

test("outcomes apply to arrow captures, not dry-practice holds", () => {
  assert.equal(canRecordArrowOutcome({ sample: true, label: "Sample shot" }), true);
  assert.equal(canRecordArrowOutcome({ device_shot_id: 4, peak_g: 18 }), true);
  assert.equal(canRecordArrowOutcome({ peak_g: 20, label: "Steady Aim Hold (10s)" }), false);
  assert.equal(canRecordArrowOutcome({ peak_g: 20, label: "Manual Recording" }), false);
});

test("session outcome summary reports scoring totals, context, and trend", () => {
  const shots = [
    scoredShot(0),
    scoredShot(4),
    scoredShot(7),
    scoredShot(10, { arrow_is_x: true }),
  ];
  const summary = summarizeSessionOutcomes(shots);

  assert.equal(summary.count, 4);
  assert.equal(summary.total, 21);
  assert.equal(summary.average, 5.25);
  assert.equal(summary.xCount, 1);
  assert.equal(summary.tenCount, 1);
  assert.equal(summary.missCount, 1);
  assert.equal(summary.trend, 6.5);
  assert.equal(summary.context, "20 yd / 40 cm face");
  assert.equal(summary.mixedContext, false);
});

test("session outcome summary flags mixed target contexts", () => {
  const summary = summarizeSessionOutcomes([
    scoredShot(6),
    scoredShot(7, { target_distance: 50, target_distance_unit: "m" }),
  ]);
  assert.equal(summary.mixedContext, true);
  assert.equal(summary.context, "");
  assert.equal(summary.insight.status, "unclear");
  assert.match(summary.insight.title, /consistent/);
});

test("correlation waits for enough paired arrows before coaching", () => {
  const insight = correlateOutcomesWithForm([
    scoredShot(5),
    scoredShot(6),
    scoredShot(7),
  ]);
  assert.equal(insight.status, "collecting");
  assert.equal(insight.sampleCount, 3);
  assert.match(insight.detail, /3 more/);
});

test("correlation identifies the strongest positive form-to-score signal", () => {
  const shots = Array.from({ length: 8 }, (_, index) => scoredShot(index + 2, {
    hold_stability: [60, 63, 59, 62, 61, 64, 60, 62][index],
    follow_through: 90 - index * 2,
    level_consistency: 70,
  }));
  const insight = correlateOutcomesWithForm(shots);

  assert.equal(insight.status, "signal");
  assert.equal(insight.metricKey, "release_quality");
  assert.equal(insight.sampleCount, 8);
  assert.ok(insight.correlation > 0.99);
  assert.match(insight.detail, /not proof of causation/);
});

test("correlation reports an unclear result when positive signals are weak", () => {
  const scores = [5, 8, 4, 7, 6, 5];
  const shots = scores.map((score, index) => scoredShot(index, {
    arrow_score: score,
    hold_stability: 60,
    release_quality: [20, 80, 70, 30, 90, 40][index],
    follow_through: 75,
    level_consistency: 70,
  }));
  const insight = correlateOutcomesWithForm(shots);
  assert.equal(insight.status, "unclear");
  assert.equal(insight.metricKey, null);
});

test("empty sessions remain well-defined", () => {
  const summary = summarizeSessionOutcomes([{ arrow_score: null }]);
  assert.equal(summary.count, 0);
  assert.equal(summary.average, null);
  assert.equal(summary.insight.status, "collecting");
});

test("impact helpers use normalized target radius and archery ring boundaries", () => {
  assert.deepEqual(normalizeImpact({ impact_x: 0.3, impact_y: -0.4 }), {
    x: 0.3,
    y: -0.4,
    radius: 0.5,
  });
  assert.equal(normalizeImpact({ impact_x: 2, impact_y: 0 }), null);
  assert.equal(scoreForImpact(0, 0), 10);
  assert.equal(scoreForImpact(0.1, 0), 10);
  assert.equal(scoreForImpact(0.101, 0), 9);
  assert.equal(scoreForImpact(1, 0), 1);
  assert.equal(scoreForImpact(1.01, 0), 0);
  assert.equal(impactDirectionLabel({ x: -0.4, y: 0.2 }), "high-left");
  assert.equal(impactDirectionLabel({ x: 0.02, y: -0.01 }), "centered");
});

test("impact group reports center, normalized spread, physical spread, and ellipse", () => {
  const summary = summarizeImpactGroup([
    scoredShot(8, { impact_x: -0.1, impact_y: 0 }),
    scoredShot(9, { impact_x: 0, impact_y: 0 }),
    scoredShot(10, { impact_x: 0.1, impact_y: 0 }),
  ]);

  assert.equal(summary.count, 3);
  assert.ok(Math.abs(summary.centerX) < 1e-12);
  assert.equal(summary.centerY, 0);
  assert.equal(summary.centerDirection, "centered");
  assert.ok(Math.abs(summary.maxSpread - 0.2) < 1e-12);
  assert.ok(Math.abs(summary.spreadCm - 4) < 1e-12);
  assert.ok(summary.ellipse.radiusMajor > 0);
  assert.ok(summary.ellipse.radiusMinor < 1e-12);
});

test("physical group size requires a known face size on every plotted arrow", () => {
  const summary = summarizeImpactGroup([
    scoredShot(8, { impact_x: -0.1, impact_y: 0 }),
    scoredShot(9, { impact_x: 0.1, impact_y: 0, target_face_cm: null }),
  ]);
  assert.equal(summary.spreadCm, null);
});

test("directional analysis links cant to horizontal impacts only after six arrows", () => {
  const shots = Array.from({ length: 6 }, (_, index) => scoredShot(index + 4, {
    cant_angle_deg: index - 2.5,
    impact_x: (index - 2.5) * 0.1,
    impact_y: [0.1, -0.1, 0.05, -0.05, 0.08, -0.08][index],
  }));
  const insight = correlateDirectionalImpacts(shots);

  assert.equal(insight.status, "signal");
  assert.equal(insight.metricKey, "cant_angle_deg");
  assert.ok(insight.correlation > 0.99);
  assert.match(insight.detail, /rightward arrows/);
  assert.equal(correlateDirectionalImpacts(shots.slice(0, 5)).status, "collecting");
});

test("mixed target contexts suppress directional impact coaching", () => {
  const shots = Array.from({ length: 6 }, (_, index) => scoredShot(index + 4, {
    impact_x: index * 0.05,
    impact_y: 0,
    target_distance: index === 5 ? 50 : 20,
  }));
  const summary = summarizeImpactGroup(shots);
  assert.equal(summary.mixedContext, true);
  assert.equal(summary.insight.status, "unclear");
  assert.match(summary.insight.title, /consistent/);
});
