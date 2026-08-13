import test from "node:test";
import assert from "node:assert/strict";

import { generateSampleData } from "../app/data/sample-data.js";
import {
  buildSessionImpactReview,
  buildSessionOutcomeReview,
  buildSessionReview,
} from "../app/ui/session-review.js";

test("target-result review stays absent until an arrow is scored", () => {
  assert.equal(buildSessionOutcomeReview([{ id: "shot", arrow_score: null }]), "");
});

test("sample session renders target totals and a cautious form-to-score insight", () => {
  const { shots } = generateSampleData(Date.UTC(2026, 0, 1));
  const html = buildSessionOutcomeReview(shots);

  assert.match(html, /Target Results/);
  assert.match(html, /42<small> \/ 6 arrows/);
  assert.match(html, /Average/);
  assert.match(html, /7\.0/);
  assert.match(html, /Follow-through is tracking score/);
  assert.match(html, /not proof of causation/);
});

test("sample session renders a plotted group and cautious directional signal", () => {
  const { shots } = generateSampleData(Date.UTC(2026, 0, 1));
  const html = buildSessionImpactReview(shots);

  assert.match(html, /Impact Group/);
  assert.match(html, /6 plotted arrows/);
  assert.match(html, /Max spread/);
  assert.match(html, /cm/);
  assert.match(html, /Bow cant is tracking horizontal impact/);
  assert.match(html, /Check calibration and target setup/);
  assert.match(html, /session-impact-marker/);
});

test("impact group stays absent until an arrow is plotted", () => {
  assert.equal(buildSessionImpactReview([{ id: "shot", impact_x: null, impact_y: null }]), "");
});

test("null manual-shot components are not misreported as zero-score issues", () => {
  const html = buildSessionReview([{
    id: "hold-1",
    timestamp: "2026-01-01T00:00:00Z",
    label: "Steady Aim Hold (10s)",
    shot_score: 80,
    hold_stability: 80,
    release_quality: null,
    follow_through: null,
    level_consistency: 85,
  }]);

  assert.match(html, /Hold steadiness/);
  assert.doesNotMatch(html, /Release disturbance/);
});
