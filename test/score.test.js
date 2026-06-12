import test from "node:test";
import assert from "node:assert/strict";

import {
  FLOAT_SCORE_VERSION,
  computeFloatScoreFromTrace,
  computeLiveFloatScore,
} from "../app/telemetry/score.js";

const RELEASE_INDEX = 100;

function makeTrace({
  points = 160,
  releaseIndex = RELEASE_INDEX,
  holdNoise = 0,
  releaseKick = 0,
  followDrift = 0,
  cant = 0,
  mic = true,
  gyro = true,
  accel = true,
} = {}) {
  return Array.from({ length: points }, (_, i) => {
    const inRelease = Math.abs(i - releaseIndex) <= 4;
    const afterRelease = i > releaseIndex;
    const wave = Math.sin(i * 0.71);
    const roll = cant + wave * holdNoise + (afterRelease ? followDrift * ((i - releaseIndex) / 40) : 0);
    const pitch = Math.cos(i * 0.53) * holdNoise + (afterRelease ? followDrift * 0.5 * ((i - releaseIndex) / 40) : 0);
    const motion =
      (gyro ? Math.abs(wave) * holdNoise * 2 : 0) +
      (inRelease ? releaseKick : 0) +
      (afterRelease ? Math.abs(followDrift) * 0.8 : 0);
    const point = {
      roll,
      pitch,
      tUs: Math.round((i * 1000000) / 52),
    };

    if (gyro) point.rotDps = motion;
    if (accel) {
      point.ax = inRelease ? releaseKick / 40 : 0;
      point.ay = 0;
      point.az = 1;
    }
    if (mic) point.micAmp = inRelease ? 180 : 12;
    return point;
  });
}

function score(trace, options = {}) {
  return computeFloatScoreFromTrace(trace, {
    sampleRateHz: 52,
    releaseIndex: RELEASE_INDEX,
    ...options,
  });
}

test("computeFloatScoreFromTrace returns a stable golden score for a perfect synthetic hold", () => {
  assert.deepEqual(score(makeTrace()), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 100,
    holdStability: 100,
    releaseQuality: 100,
    followThrough: 100,
    levelConsistency: 100,
    releaseIndex: RELEASE_INDEX,
  });
});

test("computeFloatScoreFromTrace golden fixtures make scoring changes loud", () => {
  assert.deepEqual(score(makeTrace({ holdNoise: 2.2 })), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 57,
    holdStability: 43,
    releaseQuality: 96,
    followThrough: 30,
    levelConsistency: 73,
    releaseIndex: RELEASE_INDEX,
  });

  assert.deepEqual(score(makeTrace({ releaseKick: 65 })), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 80,
    holdStability: 98,
    releaseQuality: 25,
    followThrough: 96,
    levelConsistency: 100,
    releaseIndex: RELEASE_INDEX,
  });

  assert.deepEqual(score(makeTrace({ followDrift: 4 })), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 89,
    holdStability: 100,
    releaseQuality: 97,
    followThrough: 51,
    levelConsistency: 100,
    releaseIndex: RELEASE_INDEX,
  });

  assert.deepEqual(score(makeTrace({ cant: 9 })), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 92,
    holdStability: 100,
    releaseQuality: 100,
    followThrough: 100,
    levelConsistency: 46,
    releaseIndex: RELEASE_INDEX,
  });
});

test("each blended component responds most strongly to its own degradation", () => {
  const baseline = score(makeTrace());
  const noisyHold = score(makeTrace({ holdNoise: 2.2 }));
  const roughRelease = score(makeTrace({ releaseKick: 65 }));
  const driftingFollow = score(makeTrace({ followDrift: 4 }));
  const canted = score(makeTrace({ cant: 9 }));

  assert.ok(noisyHold.holdStability < baseline.holdStability);
  assert.ok(noisyHold.holdStability < roughRelease.holdStability);
  assert.ok(roughRelease.releaseQuality < baseline.releaseQuality);
  assert.ok(roughRelease.releaseQuality < driftingFollow.releaseQuality);
  assert.ok(driftingFollow.followThrough < baseline.followThrough);
  assert.ok(driftingFollow.followThrough < canted.followThrough);
  assert.ok(canted.levelConsistency < baseline.levelConsistency);
  assert.ok(canted.levelConsistency < driftingFollow.levelConsistency);
  assert.ok(noisyHold.formScore < baseline.formScore);
});

test("edge cases return deterministic scores without throwing", () => {
  assert.deepEqual(computeFloatScoreFromTrace([]), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 0,
    holdStability: 0,
    releaseQuality: 0,
    followThrough: 0,
    levelConsistency: 0,
  });

  assert.deepEqual(computeFloatScoreFromTrace([{
    roll: 2,
    pitch: -1,
    ax: 0,
    ay: 0,
    az: 1,
    rotDps: 3,
  }]), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 97,
    holdStability: 98,
    releaseQuality: 97,
    followThrough: 98,
    levelConsistency: 88,
    releaseIndex: 0,
  });

  assert.deepEqual(score(makeTrace({ holdNoise: 0.4, releaseKick: 20, mic: false, gyro: false })), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 92,
    holdStability: 90,
    releaseQuality: 98,
    followThrough: 88,
    levelConsistency: 95,
    releaseIndex: RELEASE_INDEX,
  });

  assert.deepEqual(computeFloatScoreFromTrace(
    Array.from({ length: 32 }, () => ({
      roll: 0,
      pitch: 0,
      ax: 0,
      ay: 0,
      az: 0,
      gx: 0,
      gy: 0,
      gz: 0,
    })),
    { sampleRateHz: 52, releaseIndex: 0 },
  ), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 96,
    holdStability: 100,
    releaseQuality: 82,
    followThrough: 100,
    levelConsistency: 100,
    releaseIndex: 0,
  });
});

test("manual trace scoring only blends hold stability and level consistency", () => {
  assert.deepEqual(score(makeTrace({ holdNoise: 0.8, cant: 3 }), { isManual: true }), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 78,
    holdStability: 79,
    releaseQuality: null,
    followThrough: null,
    levelConsistency: 75,
    releaseIndex: RELEASE_INDEX,
  });
});

test("computeLiveFloatScore remains deterministic for a fixed live sample", () => {
  assert.deepEqual(computeLiveFloatScore({
    roll: 3,
    pitch: -2,
    gyroMag: 8,
    accelG: 1.12,
    trace: makeTrace({ holdNoise: 0.4 }).slice(-120),
  }), {
    scoreVersion: FLOAT_SCORE_VERSION,
    formScore: 87,
    holdStability: 89,
    releaseQuality: 88,
    followThrough: 88,
    levelConsistency: 79,
  });
});
