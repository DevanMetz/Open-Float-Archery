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
        el.chartTitle.textContent = "Live Motion Trace";
      }
    }

    el.hzValue.textContent = String(s.hz || 0);
    el.lossValue.textContent = String(s.lost || 0);
    el.frameCountValue.textContent = String(s.frameCount || 0);
    el.accelMagValue.textContent = (s.accelG || 0).toFixed(2);
    el.gyroMagValue.textContent = (s.gyroMag || 0).toFixed(0);
    el.shotCountValue.textContent = String(s.shotCount || 0);

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
        let rollCenter = 0;
        let pitchCenter = 0;

        if (state.reviewMode) {
          // Centering around release (index of max acceleration G-force magnitude)
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
          const refPt = data[releaseIdx] || { roll: 0, pitch: 0 };
          rollCenter = refPt.roll || 0;
          pitchCenter = refPt.pitch || 0;
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

        // Normalize scale: find the maximum deviation to ensure the path fits the target rings
        let maxDev = 1.0; // Minimum 1.0 degree window to prevent infinite zoom on tiny movements
        for (let i = 0; i < data.length; i++) {
          const pt = data[i];
          const dx = (pt.roll || 0) - rollCenter;
          const dy = (pt.pitch || 0) - pitchCenter;
          const dist = Math.hypot(dx, dy);
          if (dist > maxDev) {
            maxDev = dist;
          }
        }

        // Map the maximum deviation exactly to the outer ring of the target face (maxRadius)
        const scale = maxRadius / maxDev;
        ctx.lineWidth = 2.5;

        for (let i = 1; i < data.length; i++) {
          const pt1 = data[i - 1];
          const pt2 = data[i];

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
        const finalPt = data[data.length - 1];
        const fx = cx + ((finalPt.roll || 0) - rollCenter) * scale;
        const fy = cy - ((finalPt.pitch || 0) - pitchCenter) * scale;

        ctx.fillStyle = state.reviewMode ? "#FF5D73" : "#30E39B"; // Red release point, Green live pin
        ctx.beginPath();
        ctx.arc(fx, fy, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.5;
        ctx.stroke();
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

export function mountLog(bus, logEl) {
  bus.on("log", (message) => {
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent = `[${stamp}] ${message}\n` + logEl.textContent;
  });
}
