// 2D shot-trace chart renderer: paints the live/review trace canvas (target
// view with phase-colored Pin Float trace, or the line view with accel /
// quaternion series and the mic band) from store state each frame.

import { micChartPointsFromSeries } from "../protocol/trace.js?v=shot-store-118";
import { cssVar } from "./bow-3d.js?v=shot-store-126";

function reviewMicChartData(state) {
  if (!state.reviewMode) return null;
  if (state.reviewMicSeries?.length) {
    return micChartPointsFromSeries(state.reviewMicSeries);
  }
  const payload = state.reviewTrace || [];
  if (payload.some((point) => (point.micAmp || 0) > 0)) {
    return payload.map((point) => ({
      tUs: Number.isFinite(Number(point.tUs)) ? Number(point.tUs) : undefined,
      micAmp: point.micAmp || 0,
    }));
  }
  return null;
}

function reviewTraceTimeRangeUs(state, trace) {
  if (!Array.isArray(trace) || trace.length < 2) return null;
  const values = trace
    .map((point) => Number(point.tUs))
    .filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  let start = Math.min(...values);
  let end = Math.max(...values);
  if (end <= start) return null;
  return { start, end };
}

function fallbackReviewTimeRangeUs(state, trace) {
  if (!Array.isArray(trace) || trace.length < 2) return null;
  const sampleRateHz = Number(state.reviewSampleRateHz) > 0 ? Number(state.reviewSampleRateHz) : 52;
  const dtUs = 1000000 / sampleRateHz;
  const thresholdG = state.reviewThresholdG != null ? Number(state.reviewThresholdG) : 12;
  const { releaseIdx } = findReleaseIndex(trace, true, thresholdG);
  return {
    start: -releaseIdx * dtUs,
    end: (trace.length - 1 - releaseIdx) * dtUs,
  };
}

export function reviewTimeRangeUs(state, trace) {
  return reviewTraceTimeRangeUs(state, trace) || fallbackReviewTimeRangeUs(state, trace);
}

// Shared x-axis for the review line chart: the union of the motion trace and the
// mic series real-timestamp ranges. The mic is captured over a different window
// than the motion (shorter pre-roll, longer post-pad) and at a higher sample
// rate, so using the motion range alone squished the audio into part of the
// chart and clipped its tail. Returns null when neither series has real tUs, so
// both fall back to index mapping and stay aligned.
function reviewLineTimeRangeUs(state, motionData, micData) {
  const motionRange = reviewTraceTimeRangeUs(state, motionData);
  const micRange = Array.isArray(micData) ? reviewTraceTimeRangeUs(state, micData) : null;
  if (motionRange && micRange) {
    return {
      start: Math.min(motionRange.start, micRange.start),
      end: Math.max(motionRange.end, micRange.end),
    };
  }
  return motionRange || micRange || null;
}

// Chart draw colors that must flip with the page theme (light marks on the
// classic dark canvas, ink marks on light themes). A theme stylesheet can
// redefine the --trace-* variables; without them we fall back to the classic
// dark-theme palette. Refreshed once per frame so theme toggles apply live.
const CANVAS_INK_DEFAULTS = {
  follow: "rgba(230, 244, 239, 0.58)",
  dotRing: "#FFFFFF",
  crosshair: "rgba(255, 255, 255, 0.65)",
  label: "rgba(230, 244, 239, 0.72)",
  marker: "rgba(230, 244, 239, 0.44)",
  release: "#FF5D73",
  break: "#FFBE5C",
  hold: "#30E39B",
  cyan: "#35C7E8",
};
let canvasInk = { ...CANVAS_INK_DEFAULTS };

function refreshCanvasInk() {
  canvasInk = {
    follow: cssVar("--trace-follow") || CANVAS_INK_DEFAULTS.follow,
    dotRing: cssVar("--trace-dot-ring") || CANVAS_INK_DEFAULTS.dotRing,
    crosshair: cssVar("--trace-crosshair") || CANVAS_INK_DEFAULTS.crosshair,
    label: cssVar("--trace-label") || CANVAS_INK_DEFAULTS.label,
    marker: cssVar("--trace-marker") || CANVAS_INK_DEFAULTS.marker,
    release: cssVar("--red") || CANVAS_INK_DEFAULTS.release,
    break: cssVar("--amber") || CANVAS_INK_DEFAULTS.break,
    hold: cssVar("--green") || CANVAS_INK_DEFAULTS.hold,
    cyan: cssVar("--cyan") || CANVAS_INK_DEFAULTS.cyan,
  };
}

function hasQuaternionSeries(data) {
  return Array.isArray(data) && data.some((point) =>
    ["qw", "qx", "qy", "qz"].every((key) => Number.isFinite(Number(point[key]))),
  );
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function phaseColor(phase) {
  if (phase === "release") return canvasInk.release;
  if (phase === "break") return canvasInk.break;
  if (phase === "follow") return canvasInk.follow;
  return canvasInk.hold;
}

function findReleaseIndex(data, inferWhenMissing = false, thresholdG = 12.0) {
  let releaseIdx = 0;
  let maxG = 0;
  for (let i = 0; i < data.length; i++) {
    const pt = data[i];
    const g = Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0);
    if (g > maxG) {
      maxG = g;
      releaseIdx = i;
    }
  }
  if (maxG <= thresholdG && inferWhenMissing && data.length >= 20) {
    return {
      releaseIdx: Math.round(data.length * 0.62),
      hasRelease: true,
    };
  }
  return {
    releaseIdx,
    hasRelease: maxG > thresholdG,
  };
}

function phaseForIndex(index, releaseIdx, hasRelease, length) {
  if (!hasRelease) return "hold";
  const releaseStart = Math.max(2, releaseIdx - Math.max(4, Math.round(length * 0.025)));
  const releaseEnd = Math.min(length - 1, releaseIdx + Math.max(8, Math.round(length * 0.055)));
  if (index < releaseStart) return "hold";
  if (index < releaseIdx) return "break";
  if (index <= releaseEnd) return "release";
  return "follow";
}

function holdWindow(data, releaseIdx, hasRelease) {
  if (!data.length) return [];
  if (!hasRelease) return data;
  const releaseStart = Math.max(5, releaseIdx - Math.max(6, Math.round(data.length * 0.03)));
  return data.slice(0, releaseStart);
}

function reviewTraceCenter(data, releaseIdx, hasRelease, holdData) {
  if (hasRelease && data[releaseIdx]) {
    return {
      roll: data[releaseIdx].roll || 0,
      pitch: data[releaseIdx].pitch || 0,
    };
  }

  let sumRoll = 0;
  let sumPitch = 0;
  let count = 0;
  for (const pt of holdData) {
    sumRoll += pt.roll || 0;
    sumPitch += pt.pitch || 0;
    count++;
  }
  if (count > 0) {
    return { roll: sumRoll / count, pitch: sumPitch / count };
  }
  return { roll: data[0]?.roll || 0, pitch: data[0]?.pitch || 0 };
}

function maxDeviationAround(scaleData, rollCenter, pitchCenter) {
  let maxDev = 1.0;
  for (const pt of scaleData) {
    const dx = (pt.roll || 0) - rollCenter;
    const dy = (pt.pitch || 0) - pitchCenter;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDev) maxDev = dist;
  }
  return maxDev;
}

// Points used to size the target scale (hold-focused; excludes follow-through spikes).
function reviewScalePoints(traceData, releaseIdx, hasRelease) {
  const holdData = holdWindow(traceData, releaseIdx, hasRelease);
  if (holdData.length >= 5) return holdData;
  if (!hasRelease) return traceData;
  const releaseEnd = Math.min(
    traceData.length - 1,
    releaseIdx + Math.max(8, Math.round(traceData.length * 0.055)),
  );
  return traceData.slice(0, releaseEnd + 1);
}

const REVIEW_TARGET_SCALE_FIT = 0.85;

// Overlay a compare shot using the same normalization as the primary review trace:
// subtract the detected release roll/pitch so the shot point maps to target center.
function drawCompareReviewTrace(ctx, {
  traceData,
  releaseIdx,
  hasRelease,
  rollCenter,
  pitchCenter,
  displayScale,
  normMaxDev,
  cx,
  cy,
  replayProgress,
}) {
  if (traceData.length < 2) return;

  const replayCount = Math.max(2, Math.ceil(traceData.length * replayProgress));
  const visible = traceData.slice(0, replayCount);
  const mapPoint = (pt) => ({
    x: cx - (((pt.roll || 0) - rollCenter) / normMaxDev) * displayScale,
    y: cy - (((pt.pitch || 0) - pitchCenter) / normMaxDev) * displayScale,
  });

  ctx.save();
  ctx.strokeStyle = canvasInk.cyan;
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.88;
  ctx.beginPath();
  for (let i = 0; i < visible.length; i++) {
    const p = mapPoint(visible[i]);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  // Release reticle at target center — same anchoring as the primary trace.
  if (hasRelease && visible.length > releaseIdx) {
    ctx.save();
    ctx.strokeStyle = canvasInk.cyan;
    ctx.fillStyle = canvasInk.cyan;
    ctx.lineWidth = 1.5;

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy);
    ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  const finalPt = mapPoint(visible[visible.length - 1]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = canvasInk.cyan;
  ctx.beginPath();
  ctx.arc(finalPt.x, finalPt.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = canvasInk.dotRing;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawSigmaEllipse(ctx, points, mapPoint) {
  if (points.length < 8) return;

  const rolls = points.map((pt) => pt.roll || 0);
  const pitches = points.map((pt) => pt.pitch || 0);
  const rollMean = mean(rolls);
  const pitchMean = mean(pitches);
  let covRoll = 0;
  let covPitch = 0;
  let covCross = 0;

  for (let i = 0; i < points.length; i++) {
    const dx = rolls[i] - rollMean;
    const dy = pitches[i] - pitchMean;
    covRoll += dx * dx;
    covPitch += dy * dy;
    covCross += dx * dy;
  }

  covRoll /= points.length;
  covPitch /= points.length;
  covCross /= points.length;

  const trace = covRoll + covPitch;
  const delta = Math.sqrt(Math.max(0, ((covRoll - covPitch) / 2) ** 2 + covCross ** 2));
  const lambda1 = Math.max(0.0001, trace / 2 + delta);
  const lambda2 = Math.max(0.0001, trace / 2 - delta);
  const angle = Math.atan2(2 * covCross, covRoll - covPitch) / 2;
  const center = mapPoint({ roll: rollMean, pitch: pitchMean });
  const unitX = mapPoint({ roll: rollMean + 1, pitch: pitchMean }).x - center.x;
  const unitY = center.y - mapPoint({ roll: rollMean, pitch: pitchMean + 1 }).y;
  const avgScale = Math.max(1, (Math.abs(unitX) + Math.abs(unitY)) / 2);
  const radiusX = Math.max(8, Math.sqrt(lambda1) * avgScale);
  const radiusY = Math.max(6, Math.sqrt(lambda2) * avgScale);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  ctx.fillStyle = canvasInk.hold;
  ctx.strokeStyle = canvasInk.hold;

  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.beginPath();
  ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

// One frame of the shot-sequence chart. The caller owns the rAF loop and
// canvas sizing; review-marker drag interaction also lives with the caller.
export function drawTraceChart(ctx, canvas, store, telemetry) {
  refreshCanvasInk();
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const state = store.get();
  const data = state.reviewMode ? (state.reviewTrace || []) : telemetry.getTrace();

  if (state.chartView === "target") {
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = Math.min(w, h) * 0.45;

    // Draw concentric archery target rings outer-to-inner (White, Black, Blue, Red, Yellow)
    const colors = ["#FFFFFF", "#1E1E1E", "#00B5E2", "#EE383E", "#FFE000"];
    const radii = [maxRadius, maxRadius * 0.8, maxRadius * 0.6, maxRadius * 0.4, maxRadius * 0.2];

    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = colors[i];
      ctx.strokeStyle = "rgba(142, 166, 160, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radii[i], 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();

      // Sub-ring detailed line
      ctx.beginPath();
      ctx.arc(cx, cy, radii[i] - (radii[i] - (radii[i + 1] || 0)) / 2, 0, 2 * Math.PI);
      ctx.stroke();
    }

    if (data.length >= 2) {
      const replayProgress = state.reviewMode ? Math.max(0, Math.min(1, state.replayProgress ?? 1)) : 1;
      const replayCount = Math.max(2, Math.ceil(data.length * replayProgress));
      const visibleData = state.reviewMode ? data.slice(0, replayCount) : data;
      const targetZoom = state.reviewMode ? state.traceZoom || 1 : 1;
      let rollCenter = 0;
      let pitchCenter = 0;

      const thresholdG = state.reviewMode && state.reviewThresholdG != null
        ? state.reviewThresholdG
        : (state.threshold ?? 12.0);
      const { releaseIdx, hasRelease } = findReleaseIndex(data, state.reviewMode, thresholdG);
      const holdData = holdWindow(data, releaseIdx, hasRelease);

      if (state.reviewMode) {
        const center = reviewTraceCenter(data, releaseIdx, hasRelease, holdData);
        rollCenter = center.roll;
        pitchCenter = center.pitch;
      } else {
        // Centering around hold average in live streaming view
        let sumRoll = 0;
        let sumPitch = 0;
        for (let i = 0; i < data.length; i++) {
          sumRoll += data[i].roll || 0;
          sumPitch += data[i].pitch || 0;
        }
        rollCenter = sumRoll / data.length;
        pitchCenter = sumPitch / data.length;
      }

      const primaryScalePts = reviewScalePoints(data, releaseIdx, hasRelease);
      const primaryNormMaxDev = maxDeviationAround(primaryScalePts, rollCenter, pitchCenter);

      let compareOverlay = null;
      let compareNormMaxDev = 1.0;
      if (state.reviewMode && state.compareTrace && state.compareTrace.length >= 2) {
        const compareData = state.compareTrace;
        const compareThreshold = state.compareThresholdG ?? 12;
        const compareRelease = findReleaseIndex(compareData, true, compareThreshold);
        const compareHoldData = holdWindow(
          compareData,
          compareRelease.releaseIdx,
          compareRelease.hasRelease,
        );
        const compareCenter = reviewTraceCenter(
          compareData,
          compareRelease.releaseIdx,
          compareRelease.hasRelease,
          compareHoldData,
        );
        const compareScalePts = reviewScalePoints(
          compareData,
          compareRelease.releaseIdx,
          compareRelease.hasRelease,
        );
        compareNormMaxDev = maxDeviationAround(
          compareScalePts,
          compareCenter.roll,
          compareCenter.pitch,
        );
        compareOverlay = {
          traceData: compareData,
          releaseIdx: compareRelease.releaseIdx,
          hasRelease: compareRelease.hasRelease,
          rollCenter: compareCenter.roll,
          pitchCenter: compareCenter.pitch,
        };
      }

      // Solo review: one shared scale from the primary trace extent.
      // Compare mode: each trace is normalized to its own movement extent, then
      // drawn with the same display scale so neither looks compressed on the face.
      const displayScale = maxRadius * REVIEW_TARGET_SCALE_FIT * targetZoom;
      const primaryDrawScale = displayScale / primaryNormMaxDev;
      const mapPoint = (pt) => ({
        x: cx - ((pt.roll || 0) - rollCenter) * primaryDrawScale,
        y: cy - ((pt.pitch || 0) - pitchCenter) * primaryDrawScale,
      });

      if (compareOverlay) {
        drawCompareReviewTrace(ctx, {
          traceData: compareOverlay.traceData,
          releaseIdx: compareOverlay.releaseIdx,
          hasRelease: compareOverlay.hasRelease,
          rollCenter: compareOverlay.rollCenter,
          pitchCenter: compareOverlay.pitchCenter,
          displayScale,
          normMaxDev: compareNormMaxDev,
          cx,
          cy,
          replayProgress,
        });
      }

      drawSigmaEllipse(ctx, holdData, mapPoint);

      // Decimate visibleData for drawing when the point count exceeds the
      // canvas pixel width — sub-pixel segments are invisible, so we keep
      // at most ~2× the pixel width for smooth curves plus all phase-boundary
      // and release points which must remain precise.
      const maxDrawPts = Math.max(200, Math.round(w * 2));
      let drawData = visibleData;
      if (visibleData.length > maxDrawPts) {
        const step = visibleData.length / maxDrawPts;
        drawData = [];
        let nextSlot = 0;
        for (let i = 0; i < visibleData.length; i++) {
          if (i >= nextSlot || i === visibleData.length - 1 || i === releaseIdx) {
            drawData.push({ _origIdx: i, ...visibleData[i] });
            nextSlot = i + step;
          }
        }
      }

      // Batch trace segments by phase colour — one beginPath/stroke per
      // phase run instead of per-segment (~4 draw calls vs ~6000).
      ctx.lineWidth = 2.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      let curPhase = null;
      for (let i = 1; i < drawData.length; i++) {
        const origIdx = drawData[i]._origIdx ?? i;
        const phase = phaseForIndex(origIdx, releaseIdx, hasRelease, data.length);
        if (phase !== curPhase) {
          // Flush previous run
          if (curPhase !== null) ctx.stroke();
          curPhase = phase;
          ctx.strokeStyle = phaseColor(phase);
          ctx.beginPath();
          const prev = mapPoint(drawData[i - 1]);
          ctx.moveTo(prev.x, prev.y);
        }
        const p = mapPoint(drawData[i]);
        ctx.lineTo(p.x, p.y);
      }
      if (curPhase !== null) ctx.stroke();

      if (hasRelease && visibleData.length > releaseIdx) {
        const releasePoint = mapPoint(data[releaseIdx]);
        ctx.save();
        ctx.strokeStyle = "#FF5D73";
        ctx.fillStyle = "rgba(255, 93, 115, 0.18)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(releasePoint.x, releasePoint.y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(releasePoint.x - 16, releasePoint.y);
        ctx.lineTo(releasePoint.x + 16, releasePoint.y);
        ctx.moveTo(releasePoint.x, releasePoint.y - 16);
        ctx.lineTo(releasePoint.x, releasePoint.y + 16);
        ctx.stroke();
        ctx.restore();
      }

      // Draw current pin dot or release position marker
      const finalPt = visibleData[visibleData.length - 1];
      const finalPoint = mapPoint(finalPt);
      const finalPhase = phaseForIndex(visibleData.length - 1, releaseIdx, hasRelease, data.length);

      ctx.fillStyle = phaseColor(finalPhase);
      ctx.beginPath();
      ctx.arc(finalPoint.x, finalPoint.y, 6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = canvasInk.dotRing;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.strokeStyle = canvasInk.crosshair;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(finalPoint.x - 11, finalPoint.y);
      ctx.lineTo(finalPoint.x + 11, finalPoint.y);
      ctx.moveTo(finalPoint.x, finalPoint.y - 11);
      ctx.lineTo(finalPoint.x, finalPoint.y + 11);
      ctx.stroke();

      if (state.reviewMode) {
        ctx.fillStyle = canvasInk.label;
        ctx.font = "700 11px ui-monospace, Consolas, monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(`zoom ${targetZoom.toFixed(1)}x`, w - 12, h - 12);
        ctx.textAlign = "left";
        const phaseHint = "green hold  red release  gray follow";
        const compareHint = compareOverlay
          ? "  |  cyan = compare (release centered, matched scale)"
          : "";
        ctx.fillText(phaseHint + compareHint, 12, h - 12);
      }
    }

    const reviewMic = reviewMicChartData(state);
    if (reviewMic?.length) {
      // Share the union of the motion-trace and mic-series time ranges, same
      // as the line/motion view. Using the motion range alone squished the
      // audio and clipped its tail because the mic is captured over a wider
      // window at a higher rate.
      const timeRangeUs = reviewLineTimeRangeUs(state, state.reviewTrace, reviewMic);
      drawMicSeries(
        ctx,
        reviewMic,
        "micAmp",
        "rgba(53, 199, 232, 0.55)",
        "rgba(53, 199, 232, 0.22)",
        w,
        h,
        {
          bandHeight: 0.2,
          label: "Audio",
          timeRangeUs,
          releaseTimeMs: state.reviewReleaseTimeMs,
          hitTimeMs: state.reviewHitTimeMs,
          releaseIdx: state.reviewReleaseIdx,
          hitIdx: state.reviewHitIdx,
        },
      );
    }
  } else {
    ctx.strokeStyle = "rgba(142, 166, 160, 0.22)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const state = store.get();
    const data = state.reviewMode ? (state.reviewTrace || []) : telemetry.getTrace();
    const micData = state.reviewMode ? (reviewMicChartData(state) || data) : data;
    // Share one x-axis between the accel lines and the mic band: the union of
    // both series' real-timestamp ranges. With real tUs (browser captures)
    // both map by time even though the mic samples at ~1110 Hz and the motion
    // trace at 52-208 Hz over a different window; the union keeps the audio
    // from being squished or clipped. Without real tUs (firmware traces) it
    // returns null and both fall back to index mapping, still aligned because
    // the mic series is derived from the same payload.
    const timeRangeUs = state.reviewMode
      ? reviewLineTimeRangeUs(state, data, micData)
      : null;

    // Draw raw mic channel in the background (bottom band)
    drawMicSeries(
      ctx,
      micData,
      "micAmp",
      "rgba(53, 199, 232, 0.45)",
      "rgba(53, 199, 232, 0.15)",
      w,
      h,
      state.reviewMode ? {
        bandHeight: 0.3,
        label: "Audio",
        timeRangeUs,
        releaseTimeMs: state.reviewReleaseTimeMs,
        hitTimeMs: state.reviewHitTimeMs,
        releaseIdx: state.reviewReleaseIdx,
        hitIdx: state.reviewHitIdx,
      } : undefined,
    );

    if (hasQuaternionSeries(data)) {
      drawSeries(ctx, data, "qw", cssVar("--green"), w, h, timeRangeUs, 1);
      drawSeries(ctx, data, "qx", cssVar("--cyan"), w, h, timeRangeUs, 1);
      drawSeries(ctx, data, "qy", cssVar("--amber"), w, h, timeRangeUs, 1);
      drawSeries(ctx, data, "qz", "#ff5d73", w, h, timeRangeUs, 1);
      drawChartLegend(ctx, [
        ["qw", cssVar("--green")],
        ["qx", cssVar("--cyan")],
        ["qy", cssVar("--amber")],
        ["qz", "#ff5d73"],
      ], w);
    } else {
      drawSeries(ctx, data, "ax", cssVar("--green"), w, h, timeRangeUs);
      drawSeries(ctx, data, "ay", cssVar("--cyan"), w, h, timeRangeUs);
      drawSeries(ctx, data, "az", cssVar("--amber"), w, h, timeRangeUs);
      drawChartLegend(ctx, [
        ["ax", cssVar("--green")],
        ["ay", cssVar("--cyan")],
        ["az", cssVar("--amber")],
      ], w);
    }
    drawSequenceMarkers(ctx, data, w, h, state.reviewMode);
  }
}

function drawChartLegend(ctx, items, w) {
  ctx.save();
  ctx.font = "700 11px ui-monospace, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let x = 10;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillText(label, x, 10);
    x += Math.max(28, ctx.measureText(label).width + 14);
    if (x > w - 32) break;
  }
  ctx.restore();
}

function drawSeries(ctx, data, key, color, w, h, timeRangeUs = null, limit = 2) {
  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const maxIdx = data.length - 1;
  const useTime = !!(timeRangeUs && timeRangeUs.end > timeRangeUs.start);

  // When the dataset is much wider than the canvas, decimate with a min/max
  // bucket strategy that preserves visual peaks while skipping sub-pixel detail.
  const maxVerts = Math.max(200, Math.round(w * 2));
  const step = data.length > maxVerts ? data.length / maxVerts : 1;

  if (step <= 1) {
    // No decimation needed — draw every point
    for (let i = 0; i < data.length; i += 1) {
      const tUs = Number(data[i].tUs);
      const x =
        useTime && Number.isFinite(tUs)
          ? Math.max(
              0,
              Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w),
            )
          : (i / maxIdx) * w;
      const value = Number(data[i][key]);
      const clamped = Number.isFinite(value)
        ? Math.max(-limit, Math.min(limit, value))
        : 0;
      const y = h / 2 - (clamped / (limit * 2)) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    // Min-max bucket decimation: for each pixel-width bucket, emit the point
    // with the minimum and maximum Y value to preserve peaks/troughs.
    const xForIdx = (idx) => {
      if (useTime) {
        const tUs = Number(data[idx].tUs);
        if (Number.isFinite(tUs)) {
          return Math.max(0, Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w));
        }
      }
      return (idx / maxIdx) * w;
    };
    const yForIdx = (idx) => {
      const value = Number(data[idx][key]);
      const clamped = Number.isFinite(value)
        ? Math.max(-limit, Math.min(limit, value))
        : 0;
      return h / 2 - (clamped / (limit * 2)) * h;
    };

    // First point
    ctx.moveTo(xForIdx(0), yForIdx(0));

    for (let b = 0; b < maxVerts; b++) {
      const bStart = Math.round(b * step);
      const bEnd = Math.min(data.length - 1, Math.round((b + 1) * step) - 1);
      if (bStart > maxIdx) break;

      let minY = Infinity, maxY = -Infinity, minIdx = bStart, maxIdx2 = bStart;
      for (let j = bStart; j <= bEnd; j++) {
        const y = yForIdx(j);
        if (y < minY) { minY = y; minIdx = j; }
        if (y > maxY) { maxY = y; maxIdx2 = j; }
      }

      // Emit min then max in index order to preserve waveform direction
      const first = minIdx <= maxIdx2 ? minIdx : maxIdx2;
      const second = minIdx <= maxIdx2 ? maxIdx2 : minIdx;
      ctx.lineTo(xForIdx(first), yForIdx(first));
      if (first !== second) {
        ctx.lineTo(xForIdx(second), yForIdx(second));
      }
    }
  }

  ctx.stroke();
}

function drawMicSeries(ctx, data, key, baseColor, w, h, options = {}) {
  if (data.length < 2) return;

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const val = data[i][key];
    if (val !== undefined && val > peak) peak = val;
  }
  if (peak <= 0) return;

  const bandHeight = options.bandHeight ?? 0.3;
  const bandTop = options.bandTop ?? h * (1 - bandHeight);
  const bandBottom = bandTop + h * bandHeight;
  const bandPixelHeight = bandBottom - bandTop;

  ctx.save();
  ctx.lineWidth = 1.5;

  const maxIdx = data.length - 1;
  const timeRangeUs = options.timeRangeUs || null;
  const xForPoint = (point, index) => {
    const tUs = Number(point.tUs);
    if (
      timeRangeUs &&
      Number.isFinite(tUs) &&
      timeRangeUs.end > timeRangeUs.start
    ) {
      return Math.max(
        0,
        Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w),
      );
    }
    return (index / maxIdx) * w;
  };

  const yForMicIdx = (index) => {
    const val = data[index][key] || 0;
    const ratio = val / peak;
    return bandBottom - ratio * bandPixelHeight;
  };

  // 1. Draw fill
  ctx.fillStyle = baseColor;
  ctx.save();
  ctx.globalAlpha = options.fillOpacity ?? 0.15;
  ctx.beginPath();
  ctx.moveTo(xForPoint(data[0], 0), bandBottom);
  const maxVerts = Math.max(200, Math.round(w * 2));
  const micStep = data.length > maxVerts ? data.length / maxVerts : 1;
  if (micStep <= 1) {
    for (let i = 0; i < data.length; i += 1) {
      ctx.lineTo(xForPoint(data[i], i), yForMicIdx(i));
    }
  } else {
    for (let b = 0; b < maxVerts; b++) {
      const bStart = Math.round(b * micStep);
      const bEnd = Math.min(data.length - 1, Math.round((b + 1) * micStep) - 1);
      if (bStart > maxIdx) break;
      let bestIdx = bStart, bestY = Infinity;
      for (let j = bStart; j <= bEnd; j++) {
        const y = yForMicIdx(j);
        if (y < bestY) { bestY = y; bestIdx = j; }
      }
      ctx.lineTo(xForPoint(data[bestIdx], bestIdx), bestY);
    }
  }
  ctx.lineTo(w, bandBottom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 2. Draw stroke
  ctx.strokeStyle = baseColor;
  ctx.save();
  ctx.globalAlpha = options.strokeOpacity ?? 0.45;
  ctx.beginPath();
  if (micStep <= 1) {
    for (let i = 0; i < data.length; i += 1) {
      const x = xForPoint(data[i], i);
      const y = yForMicIdx(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    ctx.moveTo(xForPoint(data[0], 0), yForMicIdx(0));
    for (let b = 0; b < maxVerts; b++) {
      const bStart = Math.round(b * micStep);
      const bEnd = Math.min(data.length - 1, Math.round((b + 1) * micStep) - 1);
      if (bStart > maxIdx) break;
      let bestIdx = bStart, bestY = Infinity;
      for (let j = bStart; j <= bEnd; j++) {
        const y = yForMicIdx(j);
        if (y < bestY) { bestY = y; bestIdx = j; }
      }
      ctx.lineTo(xForPoint(data[bestIdx], bestIdx), bestY);
    }
  }
  ctx.stroke();
  ctx.restore();

  if (options.label) {
    ctx.fillStyle = canvasInk.label;
    ctx.font = "600 10px ui-monospace, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(options.label, 8, bandTop + 4);
  }

  // Draw release and target hit markers if available
  const getXForTime = (timeMs, idx) => {
    if (
      timeRangeUs &&
      timeRangeUs.end > timeRangeUs.start &&
      timeMs !== null &&
      timeMs !== undefined
    ) {
      const tUs = timeMs * 1000;
      return Math.max(
        0,
        Math.min(w, ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * w),
      );
    }
    return idx !== null && idx !== undefined && idx >= 0
      ? (idx / maxIdx) * w
      : null;
  };

  const xRelease = getXForTime(options.releaseTimeMs, options.releaseIdx);
  const xHit = getXForTime(options.hitTimeMs, options.hitIdx);

  if (xRelease !== null && xRelease >= 0 && xRelease <= w) {
    ctx.save();
    ctx.strokeStyle = canvasInk.release;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xRelease, bandTop);
    ctx.lineTo(xRelease, bandBottom);
    ctx.stroke();

    ctx.fillStyle = canvasInk.release;
    ctx.font = "700 9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("RELEASE", xRelease - 4, bandTop + 4);
    ctx.restore();
  }

  if (xHit !== null && xHit >= 0 && xHit <= w) {
    ctx.save();
    ctx.strokeStyle = canvasInk.cyan;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xHit, bandTop);
    ctx.lineTo(xHit, bandBottom);
    ctx.stroke();

    ctx.fillStyle = canvasInk.cyan;
    ctx.font = "700 9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("HIT", xHit + 4, bandTop + 4);
    ctx.restore();
  }

  ctx.restore();
}

function drawSequenceMarkers(ctx, data, w, h, reviewMode) {
  if (data.length < 20) return;

  const markerColor = canvasInk.marker;
  const labels = reviewMode
    ? [
        { x: 0.2, text: "hold" },
        { x: 0.62, text: "release" },
        { x: 0.84, text: "follow" },
      ]
    : [
        { x: 0.33, text: "hold" },
        { x: 0.67, text: "float" },
      ];

  ctx.save();
  ctx.font = "700 10px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const marker of labels) {
    const x = marker.x * w;
    ctx.strokeStyle = markerColor;
    ctx.setLineDash([4, 7]);
    ctx.beginPath();
    ctx.moveTo(x, 10);
    ctx.lineTo(x, h - 10);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = canvasInk.label;
    ctx.fillText(marker.text, x, 12);
  }
  ctx.restore();
}
