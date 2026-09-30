// Arrow-result analytics. These helpers are intentionally local and
// deterministic so target scores never require an account or cloud service.

export const OUTCOME_METRICS = Object.freeze([
  Object.freeze({ key: "hold_stability", label: "Hold stability" }),
  Object.freeze({ key: "release_quality", label: "Release quality" }),
  Object.freeze({ key: "follow_through", label: "Follow-through" }),
  Object.freeze({ key: "level_consistency", label: "Level consistency" }),
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteValue(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pearsonCorrelation(pairs) {
  if (pairs.length < 2) return null;
  const xs = pairs.map((pair) => pair.x);
  const ys = pairs.map((pair) => pair.y);
  const xMean = average(xs);
  const yMean = average(ys);
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;

  for (const pair of pairs) {
    const xDelta = pair.x - xMean;
    const yDelta = pair.y - yMean;
    covariance += xDelta * yDelta;
    xVariance += xDelta * xDelta;
    yVariance += yDelta * yDelta;
  }

  const denominator = Math.sqrt(xVariance * yVariance);
  if (denominator === 0) return null;
  return clamp(covariance / denominator, -1, 1);
}

export function normalizeArrowOutcome(shot) {
  const rawScore = finiteValue(shot?.arrow_score);
  if (!Number.isInteger(rawScore) || rawScore < 0 || rawScore > 10) return null;
  const score = rawScore;
  const isX = score === 10 && shot?.arrow_is_x === true;
  const distance = finiteValue(shot?.target_distance);
  const faceCm = finiteValue(shot?.target_face_cm);
  const unit = shot?.target_distance_unit === "m" ? "m" : "yd";

  return {
    score,
    isX,
    label: isX ? "X" : score === 0 ? "M" : String(score),
    distance: distance != null && distance > 0 ? distance : null,
    distanceUnit: unit,
    faceCm: faceCm != null && faceCm > 0 ? faceCm : null,
  };
}

export function formatOutcomeContext(outcome) {
  if (!outcome) return "";
  const parts = [];
  if (outcome.distance != null) {
    parts.push(`${Number(outcome.distance.toFixed(1))} ${outcome.distanceUnit}`);
  }
  if (outcome.faceCm != null) {
    parts.push(`${Number(outcome.faceCm.toFixed(1))} cm face`);
  }
  return parts.join(" / ");
}

// Compare stored values, not rounded display labels. Unknown setups must never
// silently inherit the known setup of other arrows in a session.
function targetContext(shots) {
  const outcomes = shots.map(normalizeArrowOutcome);
  const keys = new Set(outcomes.map((outcome) => JSON.stringify([
    outcome?.distance ?? null,
    outcome?.distance == null ? null : outcome.distanceUnit,
    outcome?.faceCm ?? null,
  ])));
  return {
    mixed: keys.size > 1,
    complete: outcomes.length > 0 && outcomes.every((outcome) =>
      outcome?.distance != null && outcome?.faceCm != null),
    label: keys.size === 1 ? formatOutcomeContext(outcomes[0]) : "",
  };
}

function contextInsight(shots, sampleCount, minimumPairs) {
  const context = targetContext(shots);
  if (!context.mixed && context.complete) return null;
  return {
    status: "unclear",
    title: context.mixed ? "Keep the target setup consistent" : "Record the target setup",
    detail: context.mixed
      ? "These arrows have different or missing target setups. Use the same distance and face size before looking for a telemetry relationship."
      : "Add distance and face size to these arrows before looking for a telemetry relationship.",
    sampleCount,
    minimumPairs,
    metricKey: null,
    metricLabel: null,
    correlation: null,
  };
}

export function formatShotOutcome(shot, { includeContext = false } = {}) {
  const outcome = normalizeArrowOutcome(shot);
  if (!outcome) return "--";
  if (!includeContext) return outcome.label;
  const context = formatOutcomeContext(outcome);
  return context ? `${outcome.label} at ${context}` : outcome.label;
}

export function canRecordArrowOutcome(shot) {
  if (!shot) return false;
  const label = String(shot.label || "");
  if (/hold|training|manual recording|manual capture/i.test(label)) return false;
  return (
    shot.sample === true ||
    shot.device_shot_id != null ||
    Number(shot.peak_g || 0) >= 4
  );
}

// Ends are display groups in capture order. Missing results keep their place
// and contribute no score; they are never converted to misses or sorted away.
export function buildScorecard(shots, arrowsPerEnd = 3) {
  const endSize = Number(arrowsPerEnd) === 6 ? 6 : 3;
  const arrows = (shots || []).filter(canRecordArrowOutcome).sort(
    (a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0),
  );
  const ends = [];
  let total = 0;
  let scoredCount = 0;
  for (let offset = 0; offset < arrows.length; offset += endSize) {
    const entries = arrows.slice(offset, offset + endSize).map((shot, index) => ({
      shot,
      number: offset + index + 1,
      outcome: normalizeArrowOutcome(shot),
    }));
    const scored = entries.filter((entry) => entry.outcome);
    const endTotal = scored.reduce((sum, entry) => sum + entry.outcome.score, 0);
    total += endTotal;
    scoredCount += scored.length;
    ends.push({
      number: ends.length + 1,
      entries,
      total: endTotal,
      scoredCount: scored.length,
      complete: entries.length === endSize && scored.length === endSize,
      runningTotal: total,
    });
  }
  return { arrowsPerEnd: endSize, arrows, ends, total, scoredCount };
}

export function normalizeImpact(shot) {
  const x = finiteValue(shot?.impact_x);
  const y = finiteValue(shot?.impact_y);
  if (x == null || y == null || Math.abs(x) > 1.5 || Math.abs(y) > 1.5) return null;
  return {
    x,
    y,
    radius: Math.hypot(x, y),
  };
}

export function scoreForImpact(x, y) {
  const radius = Math.hypot(Number(x), Number(y));
  if (!Number.isFinite(radius) || radius > 1) return 0;
  if (radius === 0) return 10;
  return clamp(11 - Math.ceil(radius * 10), 1, 10);
}

export function impactDirectionLabel(impact) {
  if (!impact || !Number.isFinite(impact.x) || !Number.isFinite(impact.y)) return "";
  if (Math.hypot(impact.x, impact.y) <= 0.08) return "centered";
  const horizontal = impact.x > 0.08 ? "right" : impact.x < -0.08 ? "left" : "";
  const vertical = impact.y > 0.08 ? "high" : impact.y < -0.08 ? "low" : "";
  return [vertical, horizontal].filter(Boolean).join("-") || "centered";
}

export function correlateDirectionalImpacts(shots, { minimumPairs = 6 } = {}) {
  const definitions = [
    {
      key: "cant_angle_deg",
      fallbackKey: "roll_angle_deg",
      axis: "x",
      metricLabel: "Bow cant",
      axisLabel: "horizontal impact",
      positiveDirection: "rightward",
      negativeDirection: "leftward",
    },
    {
      key: "pitch_angle_deg",
      fallbackKey: null,
      axis: "y",
      metricLabel: "Bow pitch",
      axisLabel: "vertical impact",
      positiveDirection: "higher",
      negativeDirection: "lower",
    },
  ];

  const results = definitions.map((definition) => {
    const pairs = [];
    for (const shot of shots || []) {
      const impact = normalizeImpact(shot);
      const primary = finiteValue(shot?.[definition.key]);
      const fallback = definition.fallbackKey ? finiteValue(shot?.[definition.fallbackKey]) : null;
      const metric = primary ?? fallback;
      if (!impact || metric == null) continue;
      pairs.push({ x: metric, y: impact[definition.axis] });
    }
    return {
      ...definition,
      sampleCount: pairs.length,
      correlation: pearsonCorrelation(pairs),
    };
  });

  const pairedCount = results.reduce(
    (largest, result) => Math.max(largest, result.sampleCount),
    0,
  );
  const eligible = results
    .filter((result) => result.sampleCount >= minimumPairs)
    .filter((result) => result.correlation != null)
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  if (pairedCount < minimumPairs) {
    return {
      status: "collecting",
      title: "Build the directional picture",
      detail: `${pairedCount}/${minimumPairs} plotted arrows have matching orientation telemetry. Plot ${Math.max(0, minimumPairs - pairedCount)} more before OpenFloat calls out a direction pattern.`,
      sampleCount: pairedCount,
      correlation: null,
      metricKey: null,
    };
  }

  const setupIssue = contextInsight(
    (shots || []).filter((shot) => normalizeImpact(shot)), pairedCount, minimumPairs,
  );
  if (setupIssue) return setupIssue;
  if (!eligible.length) {
    return {
      status: "unclear",
      title: "Not enough variation for a direction link",
      detail: `${pairedCount} plotted arrows have matching telemetry, but the values do not vary enough to calculate a direction relationship. Keep recording normal practice.`,
      sampleCount: pairedCount,
      correlation: null,
      metricKey: null,
    };
  }

  const best = eligible[0];
  if (Math.abs(best.correlation) < 0.4) {
    return {
      status: "unclear",
      title: "No directional telemetry link yet",
      detail: `Across ${best.sampleCount} plotted arrows, cant and pitch do not yet show a stable relationship with impact direction.`,
      sampleCount: best.sampleCount,
      correlation: best.correlation,
      metricKey: null,
    };
  }

  const direction = best.correlation > 0
    ? best.positiveDirection
    : best.negativeDirection;
  return {
    status: "signal",
    title: `${best.metricLabel} is tracking ${best.axisLabel}`,
    detail: `Early signal: more positive ${best.metricLabel.toLowerCase()} aligns with ${direction} arrows (r=${best.correlation >= 0 ? "+" : ""}${best.correlation.toFixed(2)}, n=${best.sampleCount}). Check calibration and target setup before treating this as a form cue.`,
    sampleCount: best.sampleCount,
    correlation: best.correlation,
    metricKey: best.key,
  };
}

export function summarizeImpactGroup(shots) {
  const entries = (shots || [])
    .map((shot) => ({ shot, impact: normalizeImpact(shot) }))
    .filter((entry) => entry.impact);

  if (!entries.length) {
    return {
      count: 0,
      centerX: null,
      centerY: null,
      centerDirection: "",
      maxSpread: null,
      spreadCm: null,
      ellipse: null,
      mixedContext: false,
      insight: correlateDirectionalImpacts(shots),
    };
  }

  const xs = entries.map((entry) => entry.impact.x);
  const ys = entries.map((entry) => entry.impact.y);
  const centerX = average(xs);
  const centerY = average(ys);
  const context = targetContext(entries.map((entry) => entry.shot));
  const faceValues = entries
    .map((entry) => finiteValue(entry.shot?.target_face_cm))
    .filter((value) => value != null && value > 0);
  const faceSizes = new Set(faceValues);

  let maxSpread = 0;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      maxSpread = Math.max(
        maxSpread,
        Math.hypot(
          entries[i].impact.x - entries[j].impact.x,
          entries[i].impact.y - entries[j].impact.y,
        ),
      );
    }
  }

  let ellipse = null;
  if (entries.length >= 2) {
    let varianceX = 0;
    let varianceY = 0;
    let covariance = 0;
    for (const { impact } of entries) {
      const dx = impact.x - centerX;
      const dy = impact.y - centerY;
      varianceX += dx * dx;
      varianceY += dy * dy;
      covariance += dx * dy;
    }
    varianceX /= entries.length;
    varianceY /= entries.length;
    covariance /= entries.length;
    const trace = varianceX + varianceY;
    const delta = Math.sqrt(Math.max(0, ((varianceX - varianceY) / 2) ** 2 + covariance ** 2));
    ellipse = {
      radiusMajor: Math.sqrt(Math.max(0, trace / 2 + delta)),
      radiusMinor: Math.sqrt(Math.max(0, trace / 2 - delta)),
      angleRad: Math.atan2(2 * covariance, varianceX - varianceY) / 2,
    };
  }

  const mixedContext = context.mixed;
  const insight = mixedContext
    ? {
        status: "unclear",
        title: "Keep the target setup consistent",
        detail: `These ${entries.length} impacts mix distances or face sizes. OpenFloat will wait for a consistent setup before linking orientation to direction.`,
        sampleCount: entries.length,
        correlation: null,
        metricKey: null,
      }
    : correlateDirectionalImpacts(entries.map((entry) => entry.shot));
  const faceCm = faceValues.length === entries.length && faceSizes.size === 1
    ? [...faceSizes][0]
    : null;

  return {
    count: entries.length,
    centerX,
    centerY,
    centerDirection: impactDirectionLabel({ x: centerX, y: centerY }),
    maxSpread,
    spreadCm: faceCm == null ? null : maxSpread * (faceCm / 2),
    ellipse,
    mixedContext,
    insight,
  };
}

export function correlateOutcomesWithForm(shots, { minimumPairs = 6 } = {}) {
  const ranked = OUTCOME_METRICS.map((metric) => {
    const pairs = [];
    for (const shot of shots || []) {
      const outcome = normalizeArrowOutcome(shot);
      const metricValue = finiteValue(shot?.[metric.key]);
      if (!outcome || metricValue == null) continue;
      pairs.push({ x: metricValue, y: outcome.score });
    }
    return {
      ...metric,
      sampleCount: pairs.length,
      correlation: pearsonCorrelation(pairs),
    };
  });

  const pairedCount = ranked.reduce(
    (largest, result) => Math.max(largest, result.sampleCount),
    0,
  );
  const eligible = ranked
    .filter((result) => result.sampleCount >= minimumPairs)
    .filter((result) => result.correlation != null)
    .sort((a, b) => b.correlation - a.correlation);

  if (pairedCount < minimumPairs) {
    return {
      status: "collecting",
      title: "Build the form-to-score picture",
      detail: `${pairedCount}/${minimumPairs} scored arrows have matching telemetry. Log ${Math.max(0, minimumPairs - pairedCount)} more before OpenFloat calls out a relationship.`,
      sampleCount: pairedCount,
      minimumPairs,
      metricKey: null,
      metricLabel: null,
      correlation: null,
    };
  }

  const setupIssue = contextInsight(
    (shots || []).filter((shot) => normalizeArrowOutcome(shot)), pairedCount, minimumPairs,
  );
  if (setupIssue) return setupIssue;
  if (!eligible.length) {
    return {
      status: "unclear",
      title: "Not enough variation for a score link",
      detail: `${pairedCount} scored arrows have matching telemetry, but the values do not vary enough to calculate a relationship. Keep recording normal practice.`,
      sampleCount: pairedCount,
      minimumPairs,
      metricKey: null,
      metricLabel: null,
      correlation: null,
    };
  }

  const best = eligible[0];
  if (best.correlation < 0.25) {
    return {
      status: "unclear",
      title: "No clear telemetry driver yet",
      detail: `Across ${best.sampleCount} scored arrows, no form metric has a reliable positive relationship with score yet. Keep the target setup consistent and collect another end.`,
      sampleCount: best.sampleCount,
      minimumPairs,
      metricKey: null,
      metricLabel: null,
      correlation: best.correlation,
    };
  }

  const confidence = best.sampleCount >= 18 ? "Established signal" : "Early signal";
  return {
    status: "signal",
    title: `${best.label} is tracking score`,
    detail: `${confidence}: higher ${best.label.toLowerCase()} aligns with higher arrow scores (r=${best.correlation >= 0 ? "+" : ""}${best.correlation.toFixed(2)}, n=${best.sampleCount}). Treat this as a training lead, not proof of causation.`,
    sampleCount: best.sampleCount,
    minimumPairs,
    metricKey: best.key,
    metricLabel: best.label,
    correlation: best.correlation,
  };
}

export function summarizeSessionOutcomes(shots) {
  const scored = (shots || [])
    .map((shot) => ({ shot, outcome: normalizeArrowOutcome(shot) }))
    .filter((entry) => entry.outcome);

  if (!scored.length) {
    return {
      count: 0,
      total: 0,
      average: null,
      xCount: 0,
      tenCount: 0,
      missCount: 0,
      trend: null,
      context: "",
      mixedContext: false,
      insight: correlateOutcomesWithForm(shots),
    };
  }

  const chronological = [...scored].sort(
    (a, b) => new Date(a.shot.timestamp) - new Date(b.shot.timestamp),
  );
  const scores = chronological.map((entry) => entry.outcome.score);
  const context = targetContext(chronological.map((entry) => entry.shot));
  const half = Math.max(1, Math.floor(scores.length / 2));
  const early = average(scores.slice(0, half));
  const late = average(scores.slice(-half));
  const insight = context.mixed
    ? {
        status: "unclear",
        title: "Keep the target setup consistent",
        detail: `These ${scores.length} results have different or missing target setups. OpenFloat will wait for a consistent setup before linking form to score.`,
        sampleCount: scores.length,
        minimumPairs: 6,
        metricKey: null,
        metricLabel: null,
        correlation: null,
      }
    : correlateOutcomesWithForm(chronological.map((entry) => entry.shot));

  return {
    count: scores.length,
    total: scores.reduce((sum, score) => sum + score, 0),
    average: average(scores),
    xCount: chronological.filter((entry) => entry.outcome.isX).length,
    tenCount: scores.filter((score) => score === 10).length,
    missCount: scores.filter((score) => score === 0).length,
    trend: scores.length >= 4 && !context.mixed && context.complete ? late - early : null,
    context: context.label,
    mixedContext: context.mixed,
    insight,
  };
}
