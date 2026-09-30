// Pure training analysis and scoring helpers. Keeping this module free of DOM
// and storage dependencies makes the coaching rules transparent and testable.

import { scoreValue } from "../telemetry/score.js?v=shot-store-150";

export const TRAINING_DRILLS = Object.freeze({
  steady: Object.freeze({
    id: "steady",
    name: "Steady Aim",
    label: "Steady Aim Hold",
    defaultDuration: 10,
    defaultTarget: 80,
    description: "Build a smaller, quieter float through the full aiming window.",
    cue: "Set your structure, soften the bow hand, and let the pin float without chasing it.",
  }),
  level: Object.freeze({
    id: "level",
    name: "Level Lock",
    label: "Level Lock Hold",
    defaultDuration: 10,
    defaultTarget: 85,
    description: "Keep calibrated bow cant inside your level tolerance.",
    cue: "Set the bubble before the hold, then maintain pressure without steering from the grip.",
  }),
  settle: Object.freeze({
    id: "settle",
    name: "Settle & Hold",
    label: "Settle and Hold",
    defaultDuration: 15,
    defaultTarget: 80,
    description: "Finish the hold at least as controlled as you started it.",
    cue: "Come into anchor smoothly, settle into alignment, and keep the last third quiet.",
  }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)));
}

function finiteMetric(shot, key) {
  return scoreValue(shot?.[key]);
}

function averageMetric(shots, key) {
  const values = shots
    .map((shot) => finiteMetric(shot, key))
    .filter((value) => value != null);
  return {
    count: values.length,
    average: values.length ? average(values) : null,
  };
}

function validTimestamp(shot) {
  const timestamp = Date.parse(shot?.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function analyzeTrainingHistory(shots, { limit = 30 } = {}) {
  const recent = [...(shots || [])]
    .filter((shot) => shot && shot.sample !== true && shot.device_id !== "OpenFloat-Demo")
    .filter((shot) => finiteMetric(shot, "hold_stability") != null || finiteMetric(shot, "level_consistency") != null)
    .sort((a, b) => validTimestamp(b) - validTimestamp(a))
    .slice(0, Math.max(1, limit));

  const hold = averageMetric(recent, "hold_stability");
  const level = averageMetric(recent, "level_consistency");
  const available = [
    { key: "hold_stability", label: "Hold stability", drillId: "steady", ...hold },
    { key: "level_consistency", label: "Level consistency", drillId: "level", ...level },
  ].filter((metric) => metric.count > 0);

  if (!available.length) {
    return {
      drillId: "steady",
      title: "Build your training baseline",
      reason: "Complete and save a hold with your sensor to compare stability and bow-level control. Demo captures do not affect your baseline.",
      focusLabel: "Baseline",
      baseline: null,
      target: TRAINING_DRILLS.steady.defaultTarget,
      shotCount: 0,
    };
  }

  available.sort((a, b) => a.average - b.average || b.count - a.count);
  const focus = available[0];
  const baseline = Math.round(focus.average);
  const target = Math.min(95, baseline + 5);
  const title = focus.drillId === "level" ? "Lock in bow level" : "Tighten your aiming hold";
  const reason = `${focus.label} is your clearest dry-practice opportunity at ${baseline} across ${focus.count} recent scored capture${focus.count === 1 ? "" : "s"}.`;

  return {
    drillId: focus.drillId,
    title,
    reason,
    focusLabel: focus.label,
    baseline,
    target,
    shotCount: focus.count,
  };
}

function maxFloatSpan(samples) {
  if (samples.length < 2) return 0;
  // Bound work for full-rate BLE holds while retaining the trajectory shape.
  const step = Math.max(1, Math.floor(samples.length / 500));
  const points = samples.filter((_, index) => index % step === 0);
  let maxDistance = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      maxDistance = Math.max(
        maxDistance,
        Math.hypot(points[i].roll - points[j].roll, points[i].pitch - points[j].pitch),
      );
    }
  }
  return maxDistance;
}

function segmentControl(samples) {
  if (!samples.length) return 0;
  const rollStd = standardDeviation(samples.map((sample) => sample.roll));
  const pitchStd = standardDeviation(samples.map((sample) => sample.pitch));
  const gyroAvg = average(samples.map((sample) => sample.gyro));
  return clamp(100 - (rollStd + pitchStd) * 18 - gyroAvg * 0.7, 0, 100);
}

export function scoreTrainingHold(samples, { drillId = "steady", levelTolerance = 2 } = {}) {
  const usable = (samples || [])
    .map((sample) => {
      const roll = Number(sample?.roll);
      const pitch = Number(sample?.pitch);
      if (!Number.isFinite(roll) || !Number.isFinite(pitch)) return null;
      return {
        ...sample,
        roll,
        pitch,
        gyro: Math.hypot(
          Number(sample?.gx) || 0,
          Number(sample?.gy) || 0,
          Number(sample?.gz) || 0,
        ),
      };
    })
    .filter(Boolean);

  if (!usable.length) {
    return {
      drillId: TRAINING_DRILLS[drillId] ? drillId : "steady",
      score: 0,
      avgCantDev: 0,
      avgPitchDev: 0,
      maxFloat: 0,
      withinTolerancePct: 0,
      settleChange: 0,
    };
  }

  const resolvedDrillId = TRAINING_DRILLS[drillId] ? drillId : "steady";
  const rolls = usable.map((sample) => sample.roll);
  const pitches = usable.map((sample) => sample.pitch);
  const gyros = usable.map((sample) => sample.gyro);
  const avgCantDev = standardDeviation(rolls);
  const avgPitchDev = standardDeviation(pitches);
  const gyroAverage = average(gyros);
  const tolerance = Math.max(0.1, Number(levelTolerance) || 2);
  const withinTolerancePct =
    (usable.filter((sample) => Math.abs(sample.roll) <= tolerance).length / usable.length) * 100;
  const meanAbsCant = average(rolls.map(Math.abs));
  let settleChange = 0;
  let score;

  if (resolvedDrillId === "level") {
    const cantControl = clamp(
      100 - (meanAbsCant / tolerance) * 50 - avgCantDev * 10,
      0,
      100,
    );
    score = withinTolerancePct * 0.7 + cantControl * 0.3;
  } else if (resolvedDrillId === "settle") {
    const segmentLength = Math.max(1, Math.floor(usable.length * 0.35));
    const openingControl = segmentControl(usable.slice(0, segmentLength));
    const finishingControl = segmentControl(usable.slice(-segmentLength));
    settleChange = finishingControl - openingControl;
    const maintenance = clamp(100 - Math.max(0, -settleChange) * 2, 0, 100);
    score = finishingControl * 0.8 + maintenance * 0.2;
  } else {
    score = 100 - (avgCantDev + avgPitchDev) * 18 - gyroAverage * 0.7;
  }

  return {
    drillId: resolvedDrillId,
    score: Math.round(clamp(score, 0, 100)),
    avgCantDev,
    avgPitchDev,
    maxFloat: maxFloatSpan(usable),
    withinTolerancePct: Math.round(withinTolerancePct),
    settleChange,
  };
}

export function downsampleTrainingTrace(samples, targetHz = 52) {
  const points = [...(samples || [])];
  const hz = Number(targetHz);
  if (points.length < 3 || !Number.isFinite(hz) || hz <= 0) return points;

  const firstTime = Number(points[0]?.timestamp);
  const lastTime = Number(points[points.length - 1]?.timestamp);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime <= firstTime) {
    return points;
  }

  const intervalMs = 1000 / hz;
  const output = [points[0]];
  let nextTime = firstTime + intervalMs;

  for (let index = 1; index < points.length - 1; index += 1) {
    const timestamp = Number(points[index]?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < nextTime) continue;
    output.push(points[index]);
    while (nextTime <= timestamp) nextTime += intervalMs;
  }

  if (output[output.length - 1] !== points[points.length - 1]) {
    output.push(points[points.length - 1]);
  }
  return output;
}

export function trainingFeedback(result, target) {
  const drill = TRAINING_DRILLS[result?.drillId] || TRAINING_DRILLS.steady;
  const resolvedTarget = Number.isFinite(Number(target))
    ? clamp(Math.round(Number(target)), 0, 100)
    : drill.defaultTarget;
  const score = Math.round(Number(result?.score) || 0);
  const metTarget = score >= resolvedTarget;

  if (drill.id === "level") {
    return {
      title: metTarget ? "Level target met" : "Set the level before the hold",
      text: `${Math.round(result.withinTolerancePct || 0)}% of the hold stayed inside tolerance. ${metTarget ? "Repeat that bow-hand pressure." : "Establish the bubble first, then resist correcting with the grip."}`,
      metTarget,
      target: resolvedTarget,
    };
  }

  if (drill.id === "settle") {
    const change = Number(result.settleChange) || 0;
    return {
      title: metTarget ? "You finished in control" : "Let the hold settle",
      text: `Finishing control was ${Math.abs(change).toFixed(1)} points ${change >= 0 ? "better than" : "below"} the opening. ${metTarget ? "Keep that patient expansion." : "Avoid forcing the aim as the hold develops."}`,
      metTarget,
      target: resolvedTarget,
    };
  }

  return {
    title: metTarget ? "Steadiness target met" : "Quiet the aiming platform",
    text: `Your float spanned ${Number(result?.maxFloat || 0).toFixed(2)} deg. ${metTarget ? "Keep the same relaxed structure on the next repetition." : "Settle into skeletal alignment and let the pin move without chasing it."}`,
    metTarget,
    target: resolvedTarget,
  };
}
