import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShotTraceRecord,
  decodeFirmwareTraceBytes,
  estimateMicSampleRateHz,
  extractMicWindow,
  micChartPointsFromSeries,
  micSeriesFromPayload,
  resolveReviewMicSeries,
} from "../app/protocol/trace.js";

function bytesForPoints(points, stride) {
  const bytes = new Uint8Array(points.length * stride);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < points.length; i++) {
    const offset = i * stride;
    view.setInt16(offset, points[i].rollCdeg, true);
    view.setInt16(offset + 2, points[i].pitchCdeg, true);
    if (stride >= 6) view.setInt16(offset + 4, points[i].yawCdeg || 0, true);
    if (stride >= 7) view.setUint8(offset + 6, points[i].micAmp || 0);
  }
  return bytes;
}

test("decodeFirmwareTraceBytes decodes current 7-byte trace points with mic envelope", () => {
  const bytes = bytesForPoints([
    { rollCdeg: 123, pitchCdeg: -456, yawCdeg: 789, micAmp: 17 },
    { rollCdeg: -50, pitchCdeg: 25, yawCdeg: -125, micAmp: 99 },
  ], 7);

  assert.deepEqual(decodeFirmwareTraceBytes(bytes), {
    bytesPerPoint: 7,
    trace: [
      { ax: 0, ay: 0, az: 1, roll: 1.23, pitch: -4.56, yaw: 7.89, micAmp: 17 },
      { ax: 0, ay: 0, az: 5, roll: -0.5, pitch: 0.25, yaw: -1.25, micAmp: 99 },
    ],
  });
});

test("decodeFirmwareTraceBytes honors valid legacy and compact strides", () => {
  const legacy = bytesForPoints([
    { rollCdeg: 100, pitchCdeg: 200, yawCdeg: 300 },
  ], 6);
  assert.deepEqual(decodeFirmwareTraceBytes(legacy, 6), {
    bytesPerPoint: 6,
    trace: [
      { ax: 0, ay: 0, az: 5, roll: 1, pitch: 2, yaw: 3, micAmp: 0 },
    ],
  });

  const compact = bytesForPoints([
    { rollCdeg: -100, pitchCdeg: 50 },
  ], 4);
  assert.deepEqual(decodeFirmwareTraceBytes(compact, 4), {
    bytesPerPoint: 4,
    trace: [
      { ax: 0, ay: 0, az: 5, roll: -1, pitch: 0.5, yaw: 0, micAmp: 0 },
    ],
  });
});

test("decodeFirmwareTraceBytes ignores invalid requested stride and auto-detects a valid one", () => {
  const bytes = bytesForPoints([
    { rollCdeg: 100, pitchCdeg: 200, yawCdeg: 300, micAmp: 10 },
    { rollCdeg: -100, pitchCdeg: -200, yawCdeg: -300, micAmp: 20 },
  ], 7);

  assert.deepEqual(decodeFirmwareTraceBytes(bytes, 5), {
    bytesPerPoint: 7,
    trace: [
      { ax: 0, ay: 0, az: 1, roll: 1, pitch: 2, yaw: 3, micAmp: 10 },
      { ax: 0, ay: 0, az: 5, roll: -1, pitch: -2, yaw: -3, micAmp: 20 },
    ],
  });
});

test("mic helper functions derive windows, rates, chart points, and fallback series", () => {
  const micRing = [
    { tUs: 900, micAmp: 1 },
    { tUs: 1000, micAmp: 2 },
    { tUs: 1100, micAmp: 3 },
    { tUs: 1200, micAmp: 4 },
  ];

  assert.deepEqual(extractMicWindow(micRing, 1100, 0.1, 0.1), [
    { tUs: -100, micAmp: 2 },
    { tUs: 0, micAmp: 3 },
    { tUs: 100, micAmp: 4 },
  ]);
  assert.equal(estimateMicSampleRateHz(micRing), 10000);
  assert.equal(estimateMicSampleRateHz([{ tUs: 1, micAmp: 1 }]), 0);

  assert.deepEqual(micSeriesFromPayload([
    { tUs: -1000, micAmp: 7 },
    { micAmp: 8 },
  ], 1000), [
    { tUs: -1000, micAmp: 7 },
    { tUs: 1000, micAmp: 8 },
  ]);

  assert.deepEqual(resolveReviewMicSeries({
    mic_series: [{ tUs: 5, micAmp: 9 }],
    payload: [{ micAmp: 1 }],
  }), [{ tUs: 5, micAmp: 9 }]);

  assert.deepEqual(micChartPointsFromSeries([{ tUs: "12", micAmp: 6 }, { micAmp: 0 }]), [
    { tUs: 12, micAmp: 6 },
    { tUs: undefined, micAmp: 0 },
  ]);
});

test("buildShotTraceRecord records mic metadata without browser dependencies", () => {
  assert.deepEqual(buildShotTraceRecord({
    localShotId: "shot-1",
    sampleRateHz: 2,
    payload: [{ tUs: 0, micAmp: 2 }, { tUs: 500000, micAmp: 4 }],
    source: "test",
  }), {
    shot_id: "shot-1",
    sample_rate_hz: 2,
    payload: [{ tUs: 0, micAmp: 2 }, { tUs: 500000, micAmp: 4 }],
    source: "test",
    has_mic: true,
    mic_sample_rate_hz: 2,
    mic_series: [{ tUs: 0, micAmp: 2 }, { tUs: 500000, micAmp: 4 }],
  });

  assert.deepEqual(buildShotTraceRecord({
    localShotId: "shot-2",
    sampleRateHz: 52,
    payload: [{ roll: 1 }],
  }), {
    shot_id: "shot-2",
    sample_rate_hz: 52,
    payload: [{ roll: 1 }],
    source: "browser",
    has_mic: false,
    mic_sample_rate_hz: 0,
    mic_series: null,
  });
});
