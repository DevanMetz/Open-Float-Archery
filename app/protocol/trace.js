// Decode firmware-uploaded shot trace byte streams and build shot_traces records.

export const FIRMWARE_TRACE_STRIDE_LEGACY = 6;
export const FIRMWARE_TRACE_STRIDE_WITH_MIC = 7;

export function decodeFirmwareTraceBytes(rawBytes, bytesPerPoint = 0) {
  const view = new DataView(
    rawBytes.buffer,
    rawBytes.byteOffset,
    rawBytes.byteLength,
  );
  const len = rawBytes.byteLength;
  let stride = bytesPerPoint;

  if (!stride) {
    if (len % FIRMWARE_TRACE_STRIDE_WITH_MIC === 0 &&
        len % FIRMWARE_TRACE_STRIDE_LEGACY !== 0) {
      stride = FIRMWARE_TRACE_STRIDE_WITH_MIC;
    } else if (len % FIRMWARE_TRACE_STRIDE_LEGACY === 0) {
      stride = FIRMWARE_TRACE_STRIDE_LEGACY;
    } else if (len % 4 === 0) {
      stride = 4;
    } else {
      stride = FIRMWARE_TRACE_STRIDE_LEGACY;
    }
  }

  const numPoints = Math.floor(len / stride);
  const trace = [];

  for (let i = 0; i < numPoints; i++) {
    const offset = i * stride;
    const roll = view.getInt16(offset, true) / 100;
    const pitch = view.getInt16(offset + 2, true) / 100;
    const yaw = stride >= 6 ? view.getInt16(offset + 4, true) / 100 : 0;
    const micAmp = stride >= 7 ? view.getUint8(offset + 6) : 0;
    const isLast = i === numPoints - 1;

    trace.push({
      ax: 0,
      ay: 0,
      az: isLast ? 5.0 : 1.0,
      roll,
      pitch,
      yaw,
      micAmp,
    });
  }

  return { trace, bytesPerPoint: stride };
}

export function extractMicWindow(micRingBuffer, shotTimeUs, preMs, postMs) {
  const preUs = Math.max(0, preMs) * 1000;
  const postUs = Math.max(0, postMs) * 1000;
  const startUs = shotTimeUs - preUs;
  const endUs = shotTimeUs + postUs;

  return micRingBuffer
    .filter((point) => point.tUs >= startUs && point.tUs <= endUs)
    .map((point) => ({
      tUs: point.tUs - shotTimeUs,
      micAmp: point.micAmp || 0,
    }));
}

export function estimateMicSampleRateHz(micSeries) {
  if (!micSeries || micSeries.length < 2) return 0;
  const spanUs = micSeries[micSeries.length - 1].tUs - micSeries[0].tUs;
  if (spanUs <= 0) return 0;
  return Math.round(((micSeries.length - 1) * 1000000) / spanUs);
}

export function buildShotTraceRecord({
  localShotId,
  sampleRateHz,
  payload,
  micSeries = null,
  source = "browser",
}) {
  const hasMicInPayload = Array.isArray(payload) &&
    payload.some((point) => (point.micAmp || 0) > 0);
  const hasMicSeries = Array.isArray(micSeries) && micSeries.length > 0;

  return {
    shot_id: localShotId,
    sample_rate_hz: sampleRateHz,
    payload,
    source,
    has_mic: hasMicInPayload || hasMicSeries,
    mic_sample_rate_hz: hasMicSeries ? estimateMicSampleRateHz(micSeries) : 0,
    mic_series: hasMicSeries ? micSeries : null,
  };
}