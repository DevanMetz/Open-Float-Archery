// UI layer: renders the dashboard from store state and paints the live trace.
// Pure view code — it reads from the store and telemetry, never the device.

import { get } from "../core/db.js";
import { drawTraceChart, reviewTimeRangeUs } from "./trace-chart.js?v=shot-store-127";
import {
  calibratedAngle,
  initOrientationVisualizer,
  wrapAngleDeg,
} from "./bow-3d.js?v=shot-store-126";

async function getActiveArrowSpeed() {
  const activeBowId = localStorage.getItem("openfloat_active_bow_id");
  if (activeBowId) {
    try {
      const profile = await get("bow_profiles", activeBowId);
      if (profile && profile.arrow_speed != null) {
        return Number(profile.arrow_speed);
      }
    } catch (error) {
      console.error("Error getting active bow speed:", error);
    }
  }
  return 280; // Fallback default speed
}

function calculateRangeFromTimes(releaseTimeMs, hitTimeMs, bowSpeedFps) {
  if (releaseTimeMs === null || hitTimeMs === null) return null;
  const totalTimeSec = (hitTimeMs - releaseTimeMs) / 1000.0;
  if (totalTimeSec <= 0) return null;

  const V_sound = 1125.0; // fps
  const b = 0.075;
  const A = b;
  const B = -(V_sound + bowSpeedFps + totalTimeSec * b * V_sound);
  const C = totalTimeSec * bowSpeedFps * V_sound;

  const discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return null;

  const distanceFt = (-B - Math.sqrt(discriminant)) / (2 * A);
  if (distanceFt <= 0) return null;

  return {
    yards: distanceFt / 3.0,
    feet: distanceFt
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renderBubbleLevel(el, roll, rangeSetting, toleranceSetting) {
  if (!el.levelCard || !el.levelBubble || !el.levelAlertText) return;

  const cant = Number.isFinite(roll) ? roll : 0;
  const maxCantDeg = rangeSetting || 12;
  const levelToleranceDeg = toleranceSetting || 2;
  const warnToleranceDeg = levelToleranceDeg * 3;
  const normalized = clamp(cant / maxCantDeg, -1, 1);
  const bubbleLeftPercent = 50 + normalized * 42;
  const absCant = Math.abs(cant);

  el.levelBubble.style.left = `${bubbleLeftPercent}%`;
  el.levelCard.classList.toggle("level-ok", absCant <= levelToleranceDeg);
  el.levelCard.classList.toggle(
    "level-warn",
    absCant > levelToleranceDeg && absCant <= warnToleranceDeg,
  );
  el.levelCard.classList.toggle("level-danger", absCant > warnToleranceDeg);

  if (absCant <= levelToleranceDeg) {
    el.levelAlertText.textContent = "Level";
  } else {
    const side = cant > 0 ? "right" : "left";
    el.levelAlertText.textContent = `${side} cant`;
  }
}

export function mountDashboard({ store, telemetry, el }) {
  const ctx = el.traceCanvas.getContext("2d");
  initOrientationVisualizer(el, store);

  // Interactive RELEASE & HIT Marker Dragging
  let draggedMarker = null;

  const getMarkerClickTarget = (xClient, yClient) => {
    const state = store.get();
    if (!state.reviewMode || !state.reviewTrace) return null;

    const canvas = el.traceCanvas;
    const rect = canvas.getBoundingClientRect();
    const clientWidth = rect.width;
    const clientHeight = rect.height;

    const isTargetView = state.chartView === "target";
    const bandHeight = isTargetView ? 0.2 : 0.3;
    const bandTopClient = clientHeight * (1 - bandHeight);

    if (yClient < bandTopClient) return null;

    const timeRangeUs = reviewTimeRangeUs(state, state.reviewTrace);
    const maxIdx = state.reviewTrace.length - 1;
    if (maxIdx <= 0) return null;

    const getXForTime = (timeMs, idx) => {
      if (
        timeRangeUs &&
        timeRangeUs.end > timeRangeUs.start &&
        timeMs !== null &&
        timeMs !== undefined
      ) {
        const tUs = timeMs * 1000;
        return ((tUs - timeRangeUs.start) / (timeRangeUs.end - timeRangeUs.start)) * clientWidth;
      }
      if (idx !== null && idx !== undefined && idx >= 0) {
        return (idx / maxIdx) * clientWidth;
      }
      return null;
    };

    const xRelease = getXForTime(state.reviewReleaseTimeMs, state.reviewReleaseIdx);
    const xHit = getXForTime(state.reviewHitTimeMs, state.reviewHitIdx);

    const threshold = 15;
    let target = null;
    let minDist = Infinity;

    if (xRelease !== null) {
      const dist = Math.abs(xClient - xRelease);
      if (dist <= threshold && dist < minDist) {
        minDist = dist;
        target = "release";
      }
    }

    if (xHit !== null) {
      const dist = Math.abs(xClient - xHit);
      if (dist <= threshold && dist < minDist) {
        minDist = dist;
        target = "hit";
      }
    }

    return target;
  };

  const handleDragMove = (xClient) => {
    if (!draggedMarker) return;
    const state = store.get();
    if (!state.reviewMode || !state.reviewTrace) return;

    const canvas = el.traceCanvas;
    const rect = canvas.getBoundingClientRect();
    const clientWidth = rect.width;
    const frac = Math.max(0, Math.min(1, xClient / clientWidth));

    const timeRangeUs = reviewTimeRangeUs(state, state.reviewTrace);
    const maxIdx = state.reviewTrace.length - 1;
    if (maxIdx <= 0) return;

    let timeMs = 0;
    let idx = 0;

    if (timeRangeUs && timeRangeUs.end > timeRangeUs.start) {
      const tUs = timeRangeUs.start + frac * (timeRangeUs.end - timeRangeUs.start);
      timeMs = tUs / 1000;
      idx = Math.max(0, Math.min(maxIdx, Math.round(frac * maxIdx)));
    } else {
      idx = Math.max(0, Math.min(maxIdx, Math.round(frac * maxIdx)));
      const f = state.reviewTrace[idx];
      if (f.tUs !== undefined) {
        timeMs = f.tUs / 1000;
      } else {
        const hz = state.reviewSampleRateHz || 52;
        timeMs = (idx * 1000) / hz;
      }
    }

    const updates = {};
    if (draggedMarker === "release") {
      updates.reviewReleaseIdx = idx;
      updates.reviewReleaseTimeMs = timeMs;
    } else if (draggedMarker === "hit") {
      updates.reviewHitIdx = idx;
      updates.reviewHitTimeMs = timeMs;
    }

    const newRelease = draggedMarker === "release" ? timeMs : state.reviewReleaseTimeMs;
    const newHit = draggedMarker === "hit" ? timeMs : state.reviewHitTimeMs;

    getActiveArrowSpeed().then((speedVal) => {
      const range = calculateRangeFromTimes(newRelease, newHit, speedVal);
      const rangeText = range
        ? `| Est. Range: ${range.yards.toFixed(1)} yds (${Math.round(range.feet)} ft) @ ${speedVal} fps`
        : "";

      updates.reviewRangeEst = rangeText;
      store.set(updates);
    });
  };

  el.traceCanvas.addEventListener("mousedown", (e) => {
    const target = getMarkerClickTarget(e.offsetX, e.offsetY);
    if (target) {
      draggedMarker = target;
    }
  });

  el.traceCanvas.addEventListener("mousemove", (e) => {
    if (draggedMarker) {
      handleDragMove(e.offsetX);
    } else {
      const target = getMarkerClickTarget(e.offsetX, e.offsetY);
      el.traceCanvas.style.cursor = target ? "ew-resize" : "";
    }
  });

  const endDrag = () => {
    draggedMarker = null;
    if (el.traceCanvas) {
      el.traceCanvas.style.cursor = "";
    }
  };

  el.traceCanvas.addEventListener("mouseup", endDrag);
  el.traceCanvas.addEventListener("mouseleave", endDrag);

  // Touch Drag Support
  el.traceCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = el.traceCanvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const target = getMarkerClickTarget(x, y);
      if (target) {
        draggedMarker = target;
      }
    }
  });

  el.traceCanvas.addEventListener("touchmove", (e) => {
    if (draggedMarker && e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = el.traceCanvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      handleDragMove(x);
      e.preventDefault(); // Disable scroll/pinch gesture while dragging a marker
    }
  }, { passive: false });

  el.traceCanvas.addEventListener("touchend", endDrag);

  let filteredRoll = null;
  let lastUpdateTime = null;

  store.subscribe((s) => {
    el.statusBadge.className = `status clickable ${s.statusMode || ""}`.trim();
    el.statusBadge.title = s.connected ? "Disconnect Sensor" : "Connect Sensor";
    el.statusText.textContent = s.statusText;

    // Toggle Review Mode layout components reactively
    if (el.reviewBanner && el.reviewInfo && el.chartTitle) {
      if (s.reviewMode) {
        el.reviewBanner.classList.remove("hidden");
        el.chartTitle.textContent = "Trace Review Mode";
        el.reviewInfo.textContent = s.reviewInfo || "";
        if (el.reviewRangeEst) {
          el.reviewRangeEst.textContent = s.reviewRangeEst || "";
        }
      } else {
        el.reviewBanner.classList.add("hidden");
        el.chartTitle.textContent = "Shot Sequence Trace";
        if (el.reviewRangeEst) {
          el.reviewRangeEst.textContent = "";
        }
      }
    }

    let roll = s.roll;
    let pitch = s.pitch;
    let yaw = s.yaw || 0;
    let accelG = s.accelG || 0;
    let gyroMag = s.gyroMag || 0;

    if (s.reviewMode && s.reviewTrace && s.reviewTrace.length > 0) {
      const progress = Math.max(0, Math.min(1, s.replayProgress ?? 1));
      const idx = Math.min(s.reviewTrace.length - 1, Math.floor(progress * (s.reviewTrace.length - 1)));
      const pt = s.reviewTrace[idx];
      roll = pt.roll || 0;
      pitch = pt.pitch || 0;
      yaw = pt.yaw || 0;
      
      accelG = Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0);
      gyroMag = Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
    }

    el.hzValue.textContent = s.reviewMode ? "--" : String(s.hz || 0);
    el.lossValue.textContent = s.reviewMode ? "--" : String(s.lost || 0);
    el.frameCountValue.textContent = s.reviewMode ? "--" : String(s.frameCount || 0);
    el.shotCountValue.textContent = String(s.shotCount || 0);

    let hasMic = s.connected && !s.reviewMode && s.sample && s.sample.micAmp !== undefined;
    let micPct = hasMic ? Math.round((s.sample.micAmp / 255) * 100) : 0;
    if (s.reviewMode && s.reviewMicSeries?.length) {
      hasMic = true;
      const replayProgress = Math.max(0, Math.min(1, s.replayProgress ?? 1));
      const endIdx = Math.max(
        0,
        Math.min(s.reviewMicSeries.length - 1, Math.floor(replayProgress * (s.reviewMicSeries.length - 1))),
      );
      const peak = s.reviewMicSeries
        .slice(0, endIdx + 1)
        .reduce((max, point) => Math.max(max, point.micAmp || 0), 0);
      micPct = Math.round((peak / 255) * 100);
    } else if (s.reviewMode && s.reviewTrace?.length) {
      const peak = s.reviewTrace.reduce((max, point) => Math.max(max, point.micAmp || 0), 0);
      if (peak > 0) {
        hasMic = true;
        micPct = Math.round((peak / 255) * 100);
      }
    }
    if (el.micVolumeItem) {
      el.micVolumeItem.classList.toggle("hidden", !hasMic);
      if (hasMic && el.volBar) {
        el.volBar.style.width = `${micPct}%`;
      }
    }

    const uploadPending = s.reviewMode ? 0 : s.uploadPending || 0;
    if (el.uploadStatusItem) {
      el.uploadStatusItem.classList.toggle("hidden", uploadPending <= 0);
    }
    if (el.uploadCountValue) {
      el.uploadCountValue.textContent = String(uploadPending);
    }

    const now = performance.now();
    const calibratedRoll = calibratedAngle(roll, s.cantOffset);
    
    if (s.reviewMode) {
      filteredRoll = null;
      lastUpdateTime = null;
    }

    if (filteredRoll === null || lastUpdateTime === null) {
      filteredRoll = calibratedRoll;
    } else {
      const dt = (now - lastUpdateTime) / 1000;
      if (dt > 0.5) {
        filteredRoll = calibratedRoll;
      } else {
        const timeConstant = 0.08; // 80ms filter time constant (vial fluid viscosity)
        const alpha = 1 - Math.exp(-dt / timeConstant);
        filteredRoll = alpha * calibratedRoll + (1 - alpha) * filteredRoll;
      }
    }
    lastUpdateTime = now;

    el.cantValue.textContent = `${filteredRoll.toFixed(1)}`;
    renderBubbleLevel(el, filteredRoll, s.levelRange, s.levelTolerance);
    if (el.orientationYawValue) {
      const calibratedYaw = wrapAngleDeg(calibratedAngle(yaw, s.yawOffset));
      el.orientationYawValue.textContent = calibratedYaw.toFixed(1);
    }

    if (el.formScoreValue) el.formScoreValue.textContent = s.formScore == null ? "--" : String(s.formScore);
    if (el.holdStabilityValue) el.holdStabilityValue.textContent = s.holdStability == null ? "--" : `${s.holdStability}%`;
    if (el.releaseQualityValue) el.releaseQualityValue.textContent = s.releaseQuality == null ? "--" : `${s.releaseQuality}%`;
    if (el.followThroughValue) el.followThroughValue.textContent = s.followThrough == null ? "--" : `${s.followThrough}%`;
    if (el.coachTitle) el.coachTitle.textContent = s.coachTitle || "Waiting for movement";
    if (el.coachText) el.coachText.textContent = s.coachText || "Connect a sensor or run the demo to start reading hold stability.";

    if (s.reviewMode || s.sample) {
      if (el.protocolValue) el.protocolValue.textContent = s.reviewMode ? "IndexedDB" : String(s.sample.protocol);
      if (el.typeValue) el.typeValue.textContent = s.reviewMode ? "Trace Point" : String(s.sample.type);
      if (el.sourceValue) el.sourceValue.textContent = s.reviewMode ? "Replay" : s.sample.source;
      if (el.seqValue) el.seqValue.textContent = s.reviewMode ? "N/A" : String(s.sample.sequence);
      if (el.dtValue) el.dtValue.textContent = s.reviewMode ? "--" : String(s.sample.dtUs);
    }
  });

  function resize() {
    const rect = el.traceCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.traceCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    el.traceCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    drawTraceChart(ctx, el.traceCanvas, store, telemetry);
    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  draw();
}

export function mountLog(bus, logEl) {
  bus.on("log", (message) => {
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent = `[${stamp}] ${message}\n` + logEl.textContent;
  });
}
