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

    ctx.strokeStyle = "rgba(142, 166, 160, 0.22)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const data = telemetry.getTrace();
    drawSeries(ctx, data, "ax", cssVar("--green"), w, h);
    drawSeries(ctx, data, "ay", cssVar("--cyan"), w, h);
    drawSeries(ctx, data, "az", cssVar("--amber"), w, h);

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
  for (let i = 0; i < data.length; i += 1) {
    const x = (i / (MAX_TRACE_POINTS - 1)) * w;
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
