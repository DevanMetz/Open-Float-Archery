import test from "node:test";
import assert from "node:assert/strict";

import { generateSampleData } from "../app/data/sample-data.js";
import {
  buildSessionImpactReview,
  buildSessionOutcomeReview,
  buildSessionReview,
  buildSessionFloatPlot,
  buildSessionScorecard,
  shotHistoryLabel,
} from "../app/ui/session-review.js";

test("saved demo captures stay visibly distinct from personal holds", () => {
  assert.equal(shotHistoryLabel({ label: "Level Lock Hold", sample: true }), "Demo: Level Lock Hold");
  assert.equal(shotHistoryLabel({ label: "Manual Recording", device_id: "OpenFloat-Demo" }), "Demo: Manual Recording");
  assert.equal(shotHistoryLabel({ label: "Sample shot", sample: true }), "Sample shot");
  assert.equal(shotHistoryLabel({ label: "My practice", sample: false }), "My practice");
});

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

test("sessions without Float Scores do not rank or plot missing measurements as zero", () => {
  const shots = [{ id: "missing" }, { id: "invalid", shot_score: false }, { id: "pending", score_version: "v1", stability_score: 90 }];
  assert.match(buildSessionReview(shots), /No Float Scores available/);
  assert.doesNotMatch(buildSessionReview(shots), /Best Shot|Needs Work|Recurring Issue/);
  assert.equal(buildSessionFloatPlot(shots), "");
});

test("partial sessions retain zero scores, skip invalid components, and show gaps in their trend", () => {
  const shots = [
    { id: "zero", shot_score: "0", hold_stability: "80", release_quality: -1 },
    { id: "missing", shot_score: null, hold_stability: false, release_quality: "" },
    { id: "high", shot_score: "100", hold_stability: 90, release_quality: 101 },
  ].map((shot, index) => ({ ...shot, timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }));
  const review = buildSessionReview(shots);
  assert.match(review, /<strong>50<\/strong>/);
  assert.match(review, /2 of 3 captures scored/);
  assert.match(review, /data-review-shot-id="zero"/);
  assert.match(review, /data-review-shot-id="high"/);
  assert.doesNotMatch(review, /data-review-shot-id="missing"|Release disturbance/);
  const plot = buildSessionFloatPlot(shots);
  assert.match(plot, /Float scores from 2 of 3 session captures/);
  assert.equal((plot.match(/<circle /g) || []).length, 2);
  assert.match(plot, /d="M 18\.0 76\.0\s+M 302\.0 14\.0" class="session-float-line"/);
  assert.doesNotMatch(plot, /session-float-area|NaN/);
});

test("scorecard renders chronological arrow links and the first unscored result", () => {
  const { shots } = generateSampleData(Date.UTC(2026, 0, 1));
  shots[1].arrow_score = null;
  const html = buildSessionScorecard([...shots].reverse());
  assert.match(html, /5\/6 scored/);
  assert.match(html, /36 points/);
  assert.match(html, /Arrow 2, not scored/);
  assert.match(html, /data-review-shot-id="sample-shot-2">Score next arrow/);
  assert.ok(html.indexOf("Arrow 1, score") < html.indexOf("Arrow 6, score"));
  assert.match(buildSessionScorecard(shots, 6), /value="6" selected/);
});

test("scorecard escapes shot identifiers and is absent for hold-only practice", () => {
  const html = buildSessionScorecard([{ id: '\"><img src=x>', peak_g: 20, arrow_score: 0 }]);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /score M/);
  assert.match(html, /1\/1 scored/);
  assert.equal(buildSessionScorecard([{ id: "hold", label: "Level Lock Hold", peak_g: 20 }]), "");
});

test("impact markers use the same shooting order as the scorecard", () => {
  const { shots } = generateSampleData(Date.UTC(2026, 0, 1));
  const html = buildSessionImpactReview([...shots].reverse());
  assert.match(html, /<title>6 - arrow 1<\/title>/);
  assert.match(html, /<title>5 - arrow 6<\/title>/);
});
