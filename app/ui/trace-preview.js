// Mini Pin Float target previews for shot list cards.

import { tracePhases, phaseForIndex } from "./trace-phases.js?v=shot-store-155";

const TARGET_COLORS = ["#FFFFFF", "#1E1E1E", "#00B5E2", "#EE383E", "#FFE000"];
const PREVIEW_SCALE_FIT = 0.9;
const PREVIEW_RING_INSET = 0.43;
const PREVIEW_CANVAS_PAD = 3;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let inkColors = {
  release: "#FF5D73",
  break: "#FFBE5C",
  follow: "rgba(230, 244, 239, 0.5)",
  hold: "#30E39B",
};

function refreshInkColors() {
  inkColors = {
    release: cssVar("--red") || "#FF5D73",
    break: cssVar("--amber") || "#FFBE5C",
    follow: cssVar("--trace-follow") || "rgba(230, 244, 239, 0.5)",
    hold: cssVar("--green") || "#30E39B",
  };
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
  if (count > 0) return { roll: sumRoll / count, pitch: sumPitch / count };
  return { roll: data[0]?.roll || 0, pitch: data[0]?.pitch || 0 };
}

function phaseColor(phase) {
  if (phase === "release") return inkColors.release;
  if (phase === "break") return inkColors.break;
  if (phase === "follow") return inkColors.follow;
  return inkColors.hold;
}

function previewIndices(trace, releaseIdx, maxPoints = 140) {
  if (trace.length <= maxPoints) return trace.map((_, index) => index);
  const indices = new Set([releaseIdx]);
  const step = (trace.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    indices.add(Math.min(trace.length - 1, Math.round(i * step)));
  }
  return [...indices].sort((a, b) => a - b);
}

function drawTargetRings(ctx, cx, cy, maxRadius) {
  const radii = [maxRadius, maxRadius * 0.8, maxRadius * 0.6, maxRadius * 0.4, maxRadius * 0.2];
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = TARGET_COLORS[i];
    ctx.strokeStyle = "rgba(142, 166, 160, 0.28)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radii[i], 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function previewWrap(canvas) {
  return (
    canvas.closest(
      ".history-item-preview-wrap, .recent-shot-preview-wrap, .shot-card-preview-wrap",
    ) || canvas.parentElement
  );
}

function previewSidePx(canvas) {
  const wrap = previewWrap(canvas);
  let side = Math.round(wrap?.clientWidth || 0);
  if (side < 2) {
    side = Math.round(canvas.clientWidth || 0);
  }
  return Math.max(1, side);
}

function previewLayout(side) {
  return {
    side,
    cx: side / 2,
    cy: side / 2,
    maxRadius: Math.max(12, (side - PREVIEW_CANVAS_PAD * 2) * PREVIEW_RING_INSET),
  };
}

function prepareCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const layoutSide = previewSidePx(canvas);
  const { side, cx, cy, maxRadius } = previewLayout(layoutSide);
  const px = Math.round(side * dpr);
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${layoutSide}px`;
  canvas.style.height = `${layoutSide}px`;
  canvas.style.minHeight = "0";
  canvas.style.maxWidth = "100%";
  canvas.style.maxHeight = "100%";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, side, cx, cy, maxRadius };
}

const previewResizeObservers = new WeakMap();

export function watchTracePreviewResize(canvas, redraw) {
  if (previewResizeObservers.has(canvas)) return;

  const target = previewWrap(canvas) || canvas;
  const observer = new ResizeObserver(() => {
    requestAnimationFrame(redraw);
  });
  observer.observe(target);
  previewResizeObservers.set(canvas, observer);
}

function computePreviewMapScale(data, center, maxRadius) {
  let maxDev = 1.0;
  for (const pt of data) {
    const dist = Math.hypot((pt.roll || 0) - center.roll, (pt.pitch || 0) - center.pitch);
    if (dist > maxDev) maxDev = dist;
  }
  let scale = (maxRadius / maxDev) * PREVIEW_SCALE_FIT;
  let maxPx = 0;
  for (const pt of data) {
    const dx = ((pt.roll || 0) - center.roll) * scale;
    const dy = ((pt.pitch || 0) - center.pitch) * scale;
    maxPx = Math.max(maxPx, Math.hypot(dx, dy));
  }
  const limit = maxRadius * 0.94;
  if (maxPx > limit) {
    scale *= limit / maxPx;
  }
  return scale;
}

export function drawEmptyTargetPreview(canvas) {
  if (!canvas) return;
  const { ctx, side, cx, cy, maxRadius } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, side, side);
  drawTargetRings(ctx, cx, cy, maxRadius);
  ctx.strokeStyle = "rgba(142, 166, 160, 0.35)";
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(cx - maxRadius * 0.35, cy);
  ctx.lineTo(cx + maxRadius * 0.35, cy);
  ctx.moveTo(cx, cy - maxRadius * 0.35);
  ctx.lineTo(cx, cy + maxRadius * 0.35);
  ctx.stroke();
}

export function drawTraceTargetPreview(canvas, tracePayload, options = {}) {
  if (!canvas) return false;
  if (!tracePayload || tracePayload.length < 2) {
    drawEmptyTargetPreview(canvas);
    return false;
  }

  refreshInkColors();
  const data = tracePayload;
  const phases = tracePhases(data, options);
  const { releaseIdx, hasRelease } = phases;
  const indices = previewIndices(data, releaseIdx);
  const { ctx, side, cx, cy, maxRadius } = prepareCanvas(canvas);

  ctx.clearRect(0, 0, side, side);
  drawTargetRings(ctx, cx, cy, maxRadius);

  const holdData = holdWindow(data, releaseIdx, hasRelease);
  const center = reviewTraceCenter(data, releaseIdx, hasRelease, holdData);
  const scale = computePreviewMapScale(data, center, maxRadius);
  const mapPoint = (pt) => ({
    x: cx - ((pt.roll || 0) - center.roll) * scale,
    y: cy - ((pt.pitch || 0) - center.pitch) * scale,
  });

  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < indices.length; i++) {
    const p1 = mapPoint(data[indices[i - 1]]);
    const p2 = mapPoint(data[indices[i]]);
    const phase = phaseForIndex(indices[i], phases);
    ctx.strokeStyle = phaseColor(phase);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  if (hasRelease) {
    ctx.strokeStyle = "#FF5D73";
    ctx.fillStyle = "rgba(255, 93, 115, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(4, maxRadius * 0.1), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  return true;
}
