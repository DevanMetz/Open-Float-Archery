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
  // Only trust a caller-supplied stride if it is one the firmware can actually
  // emit. A corrupted stride byte (e.g. clobbered on the wire) would otherwise
  // be used verbatim and misalign every point, so fall back to auto-detection.
  // 8 covers padded (non-__packed) trace_point structs from older firmware.
  const VALID_STRIDES = new Set([4, FIRMWARE_TRACE_STRIDE_LEGACY,
    FIRMWARE_TRACE_STRIDE_WITH_MIC, 8]);
  let stride = VALID_STRIDES.has(bytesPerPoint) ? bytesPerPoint : 0;

  if (!stride) {
    if (len % 8 === 0 && len % FIRMWARE_TRACE_STRIDE_WITH_MIC !== 0 &&
        len % FIRMWARE_TRACE_STRIDE_LEGACY !== 0) {
      stride = 8;
    } else if (len % FIRMWARE_TRACE_STRIDE_WITH_MIC === 0 &&
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

export function micSeriesFromPayload(payload, sampleRateHz = 52) {
  if (!Array.isArray(payload) || payload.length === 0) return [];
  const dtUs = sampleRateHz > 0 ? Math.round(1000000 / sampleRateHz) : 19230;
  return payload.map((point, index) => ({
    tUs: Number.isFinite(Number(point.tUs)) ? Number(point.tUs) : index * dtUs,
    micAmp: point.micAmp || 0,
  }));
}

export function resolveReviewMicSeries(trace, sampleRateHz = 52) {
  if (!trace) return [];
  if (Array.isArray(trace.mic_series) && trace.mic_series.length > 0) {
    return trace.mic_series;
  }
  return micSeriesFromPayload(trace.payload, sampleRateHz);
}

export function micChartPointsFromSeries(micSeries) {
  if (!Array.isArray(micSeries) || micSeries.length === 0) return [];
  return micSeries.map((point) => ({
    tUs: Number.isFinite(Number(point.tUs)) ? Number(point.tUs) : undefined,
    micAmp: point.micAmp || 0,
  }));
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
  let resolvedMicSeries = Array.isArray(micSeries) ? micSeries : [];
  if (resolvedMicSeries.length === 0 && hasMicInPayload) {
    resolvedMicSeries = micSeriesFromPayload(payload, sampleRateHz);
  }
  const hasMicSeries = resolvedMicSeries.length > 0;

  return {
    shot_id: localShotId,
    sample_rate_hz: sampleRateHz,
    payload,
    source,
    has_mic: hasMicInPayload || hasMicSeries,
    mic_sample_rate_hz: hasMicSeries ? estimateMicSampleRateHz(resolvedMicSeries) : 0,
    mic_series: hasMicSeries ? resolvedMicSeries : null,
  };
}
