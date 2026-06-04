// UI layer: renders the dashboard from store state and paints the live trace.
// Pure view code — it reads from the store and telemetry, never the device.

import { MAX_TRACE_POINTS } from "../telemetry/telemetry.js";

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function mountDashboard({ store, telemetry, el }) {
  const ctx = el.traceCanvas.getContext("2d");

  store.subscribe((s) => {
    el.statusBadge.className = `status ${s.statusMode || ""}`.trim();
    el.statusText.textContent = s.statusText;
    el.connectBtn.disabled = s.connected;
    el.disconnectBtn.disabled = !s.connected;
    el.saveManualBtn.disabled = !s.connected;

    // Toggle Review Mode layout components reactively
    if (el.reviewBanner && el.reviewInfo && el.chartTitle) {
      if (s.reviewMode) {
        el.reviewBanner.classList.remove("hidden");
        el.chartTitle.textContent = "Trace Review Mode";
        el.reviewInfo.textContent = s.reviewInfo || "";
      } else {
        el.reviewBanner.classList.add("hidden");
        el.chartTitle.textContent = "Shot Sequence Trace";
      }
    }

    el.hzValue.textContent = String(s.hz || 0);
    el.lossValue.textContent = String(s.lost || 0);
    el.frameCountValue.textContent = String(s.frameCount || 0);
    el.accelMagValue.textContent = (s.accelG || 0).toFixed(2);
    el.gyroMagValue.textContent = (s.gyroMag || 0).toFixed(0);
    el.shotCountValue.textContent = String(s.shotCount || 0);
    el.cantValue.textContent = `${(s.roll || 0).toFixed(1)}`;

    el.formScoreValue.textContent = s.formScore == null ? "--" : String(s.formScore);
    el.holdStabilityValue.textContent = s.holdStability == null ? "--" : `${s.holdStability}%`;
    el.releaseQualityValue.textContent = s.releaseQuality == null ? "--" : `${s.releaseQuality}%`;
    el.followThroughValue.textContent = s.followThrough == null ? "--" : `${s.followThrough}%`;
    el.coachTitle.textContent = s.coachTitle || "Waiting for movement";
    el.coachText.textContent = s.coachText || "Connect a sensor or run the demo to start reading hold stability.";

    const last = s.lastShotSummary;
    if (last) {
      el.lastShotTimeValue.textContent = new Date(last.timestamp).toLocaleTimeString();
      el.lastShotScoreValue.textContent = last.score ? String(Math.round(last.score)) : "--";
      el.lastPeakValue.textContent = `${last.peakG.toFixed(1)} g`;
      el.lastCantValue.textContent = `${last.cant.toFixed(1)} deg`;
      el.lastPitchValue.textContent = `${last.pitch.toFixed(1)} deg`;
    } else {
      el.lastShotTimeValue.textContent = "No shots yet";
      el.lastShotScoreValue.textContent = "--";
      el.lastPeakValue.textContent = "--";
      el.lastCantValue.textContent = "--";
      el.lastPitchValue.textContent = "--";
    }

    const f = s.sample;
    if (f) {
      el.protocolValue.textContent = String(f.protocol);
      el.typeValue.textContent = String(f.type);
      el.sourceValue.textContent = f.source;
      el.seqValue.textContent = String(f.sequence);
      el.dtValue.textContent = String(f.dtUs);
      el.axValue.textContent = `${f.axMg} mg`;
      el.ayValue.textContent = `${f.ayMg} mg`;
      el.azValue.textContent = `${f.azMg} mg`;
      el.gxValue.textContent = `${f.gxDps.toFixed(1)} dps`;
      el.gyValue.textContent = `${f.gyDps.toFixed(1)} dps`;
      el.gzValue.textContent = `${f.gzDps.toFixed(1)} dps`;
      el.sampleTimeValue.textContent = new Date().toLocaleTimeString();
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
    const rect = el.traceCanvas.getBoundingClientRect();
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

        if (state.reviewMode) {
          // Center around the average of the hold portion (excluding release recoil)
          let sumRoll = 0;
          let sumPitch = 0;
          let count = 0;
          const holdEndIdx = Math.max(5, releaseIdx - 10);
          for (let i = 0; i < holdEndIdx && i < data.length; i++) {
            sumRoll += data[i].roll || 0;
            sumPitch += data[i].pitch || 0;
            count++;
          }
          if (count > 0) {
            rollCenter = sumRoll / count;
            pitchCenter = sumPitch / count;
          } else {
            rollCenter = data[0].roll || 0;
            pitchCenter = data[0].pitch || 0;
          }
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

        // Normalize scale: find the maximum deviation inside the hold portion (ignoring release spike)
        let maxDev = 1.0; // Minimum 1.0 degree window to prevent infinite zoom on tiny movements
        const scaleEndIdx = state.reviewMode ? Math.max(5, releaseIdx - 5) : data.length;
        for (let i = 0; i < scaleEndIdx && i < data.length; i++) {
          const pt = data[i];
          const dx = (pt.roll || 0) - rollCenter;
          const dy = (pt.pitch || 0) - pitchCenter;
          const dist = Math.hypot(dx, dy);
          if (dist > maxDev) {
            maxDev = dist;
          }
        }

        // Map the maximum deviation exactly to the outer ring of the target face (maxRadius)
        const scale = (maxRadius / maxDev) * targetZoom;
        ctx.lineWidth = 2.5;

        for (let i = 1; i < visibleData.length; i++) {
          const pt1 = visibleData[i - 1];
          const pt2 = visibleData[i];

          const x1 = cx + ((pt1.roll || 0) - rollCenter) * scale;
          const y1 = cy - ((pt1.pitch || 0) - pitchCenter) * scale;
          const x2 = cx + ((pt2.roll || 0) - rollCenter) * scale;
          const y2 = cy - ((pt2.pitch || 0) - pitchCenter) * scale;

          const ratio = i / data.length;
          let color;
          if (ratio < 0.5) {
            const r = Math.round(255 - (255 - 53) * (ratio * 2));
            const g = Math.round(93 + (199 - 93) * (ratio * 2));
            const b = Math.round(115 + (232 - 115) * (ratio * 2));
            color = `rgb(${r}, ${g}, ${b})`;
          } else {
            const t = (ratio - 0.5) * 2;
            const r = Math.round(53 - (53 - 48) * t);
            const g = Math.round(199 + (227 - 199) * t);
            const b = Math.round(232 - (232 - 155) * t);
            color = `rgb(${r}, ${g}, ${b})`;
          }

          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }

        // Draw current pin dot or release position marker
        const finalPt = visibleData[visibleData.length - 1];
        const fx = cx + ((finalPt.roll || 0) - rollCenter) * scale;
        const fy = cy - ((finalPt.pitch || 0) - pitchCenter) * scale;

        ctx.fillStyle = state.reviewMode && replayProgress >= 1 ? "#FF5D73" : "#30E39B";
        ctx.beginPath();
        ctx.arc(fx, fy, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (state.reviewMode) {
          ctx.fillStyle = "rgba(230, 244, 239, 0.78)";
          ctx.font = "700 11px ui-monospace, Consolas, monospace";
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(`zoom ${targetZoom.toFixed(1)}x`, w - 12, h - 12);
        }
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

      drawSeries(ctx, data, "ax", cssVar("--green"), w, h);
      drawSeries(ctx, data, "ay", cssVar("--cyan"), w, h);
      drawSeries(ctx, data, "az", cssVar("--amber"), w, h);
      drawSequenceMarkers(ctx, data, w, h, state.reviewMode);
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  draw();
}

function drawSeries(ctx, data, key, color, w, h) {
  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const maxIdx = data.length - 1;
  for (let i = 0; i < data.length; i += 1) {
    const x = (i / maxIdx) * w;
    const clamped = Math.max(-2, Math.min(2, data[i][key]));
    const y = h / 2 - (clamped / 4) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawSequenceMarkers(ctx, data, w, h, reviewMode) {
  if (data.length < 20) return;

  const markerColor = "rgba(230, 244, 239, 0.44)";
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
    ctx.fillStyle = "rgba(230, 244, 239, 0.72)";
    ctx.fillText(marker.text, x, 12);
  }
  ctx.restore();
}

export function mountLog(bus, logEl) {
  bus.on("log", (message) => {
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent = `[${stamp}] ${message}\n` + logEl.textContent;
  });
}
