// OpenFloat scoring is intentionally transparent and locally computed.
// The score is not modeled on any commercial product; it blends movement
// features that are visible in the stored trace and useful for coaching.

export const FLOAT_SCORE_VERSION = "openfloat-float-score-v1";

const LIVE_SCORE_WINDOW = 120;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function maxAbs(values) {
  if (!values.length) return 0;
  return values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function traceSlice(trace, start, end) {
  return trace.slice(Math.max(0, start), Math.max(0, end));
}

function releaseIndexForTrace(trace) {
  if (!trace.length) return 0;

  let bestIdx = Math.max(0, Math.round(trace.length * 0.62));
  let bestMotion = -Infinity;
  for (let i = 0; i < trace.length; i++) {
    const pt = trace[i];
    const accelDelta = Math.abs(Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0) - 1);
    const gyroMag = Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
    const motion = accelDelta * 35 + gyroMag;
    if (motion > bestMotion) {
      bestMotion = motion;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function computeFloatScoreFromTrace(trace, options = {}) {
  const points = (trace || []).filter(Boolean);
  if (points.length === 0) {
    return {
      scoreVersion: FLOAT_SCORE_VERSION,
      formScore: 0,
      holdStability: 0,
      releaseQuality: 0,
      followThrough: 0,
      levelConsistency: 0,
    };
  }

  const releaseIdx =
    Number.isInteger(options.releaseIndex) && options.releaseIndex >= 0
      ? Math.min(points.length - 1, options.releaseIndex)
      : releaseIndexForTrace(points);
  const sampleRateHz = Number(options.sampleRateHz) > 0 ? Number(options.sampleRateHz) : 52;
  const preSamples = Math.max(8, Math.round(sampleRateHz * 1.5));
  const releaseSamples = Math.max(4, Math.round(sampleRateHz * 0.18));
  const followSamples = Math.max(8, Math.round(sampleRateHz * 0.75));

  const hold = traceSlice(points, releaseIdx - preSamples, releaseIdx);
  const release = traceSlice(points, releaseIdx - Math.round(releaseSamples / 2), releaseIdx + releaseSamples);
  const follow = traceSlice(points, releaseIdx + 1, releaseIdx + followSamples + 1);
  const holdWindow = hold.length ? hold : points.slice(-Math.min(points.length, LIVE_SCORE_WINDOW));
  const releaseWindow = release.length ? release : points.slice(-Math.min(points.length, releaseSamples));
  const followWindow = follow.length ? follow : points.slice(-Math.min(points.length, followSamples));

  const holdRollStd = stdDev(holdWindow.map((pt) => pt.roll || 0));
  const holdPitchStd = stdDev(holdWindow.map((pt) => pt.pitch || 0));
  const holdGyroAvg = average(
    holdWindow.map((pt) => Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0)),
  );
  const holdStability = clamp(100 - (holdRollStd + holdPitchStd) * 18 - holdGyroAvg * 0.55, 0, 100);

  const releaseGyroPeak = maxAbs(
    releaseWindow.map((pt) => Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0)),
  );
  const releaseAccelPeak = maxAbs(
    releaseWindow.map((pt) => Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0) - 1),
  );
  const releaseQuality = clamp(100 - releaseGyroPeak * 0.9 - releaseAccelPeak * 18, 0, 100);

  const followGyroAvg = average(
    followWindow.map((pt) => Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0)),
  );
  const followRollTravel = maxAbs(followWindow.map((pt) => (pt.roll || 0) - (points[releaseIdx]?.roll || 0)));
  const followPitchTravel = maxAbs(followWindow.map((pt) => (pt.pitch || 0) - (points[releaseIdx]?.pitch || 0)));
  const followThrough = clamp(100 - followGyroAvg * 0.65 - (followRollTravel + followPitchTravel) * 8, 0, 100);

  const avgAbsCant = average(holdWindow.map((pt) => Math.abs(pt.roll || 0)));
  const cantSpread = stdDev(holdWindow.map((pt) => pt.roll || 0));
  const levelConsistency = clamp(100 - avgAbsCant * 6 - cantSpread * 12, 0, 100);

  const formScore = clamp(
    holdStability * 0.4 +
      releaseQuality * 0.24 +
      followThrough * 0.22 +
      levelConsistency * 0.14,
    0,
    100,
  );

  return {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: Math.round(formScore),
    holdStability: Math.round(holdStability),
    releaseQuality: Math.round(releaseQuality),
    followThrough: Math.round(followThrough),
    levelConsistency: Math.round(levelConsistency),
    releaseIndex: releaseIdx,
  };
}

export function computeLiveFloatScore({ roll = 0, pitch = 0, gyroMag = 0, accelG = 1, trace = [] }) {
  const window = (trace || []).slice(-LIVE_SCORE_WINDOW);
  const traceScore = computeFloatScoreFromTrace(window.length ? window : [{ roll, pitch, gx: gyroMag, ax: 0, ay: 0, az: accelG }]);
  const releaseQuality = clamp(100 - gyroMag * 1.35 - Math.abs(accelG - 1) * 12, 0, 100);
  const levelConsistency = clamp(100 - Math.abs(roll) * 6 - Math.abs(pitch) * 1.5, 0, 100);
  const formScore = clamp(
    traceScore.holdStability * 0.45 +
      releaseQuality * 0.18 +
      traceScore.followThrough * 0.17 +
      levelConsistency * 0.2,
    0,
    100,
  );

  return {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: Math.round(formScore),
    holdStability: traceScore.holdStability,
    releaseQuality: Math.round(releaseQuality),
    followThrough: traceScore.followThrough,
    levelConsistency: Math.round(levelConsistency),
  };
}
