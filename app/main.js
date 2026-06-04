// App entry point: build the shared bus + store, wire telemetry and UI, and
// own the transport lifecycle (connect / disconnect / demo).

import { createStore, EventBus } from "./core/store.js";
import { TelemetryStore } from "./telemetry/telemetry.js?v=shot-store-7";
import { createAdapter } from "./device/adapters.js?v=shot-store-7";
import { mountDashboard, mountLog } from "./ui/dashboard.js?v=shot-store-7";
import { initDb, getAll, get } from "./core/db.js";
import { CloudSyncAdapter } from "./telemetry/sync.js?v=shot-store-7";

const APP_BUILD = "shot-store-7";

const ELEMENT_IDS = [
  "statusBadge", "statusText", "transportSelect",
  "connectBtn", "disconnectBtn", "demoBtn",
  "protocolValue", "typeValue", "sourceValue", "seqValue", "lossValue",
  "dtValue", "hzValue", "accelMagValue", "gyroMagValue", "frameCountValue",
  "shotCountValue", "axValue", "ayValue", "azValue", "gxValue", "gyValue",
  "gzValue", "sampleTimeValue", "eventLog", "traceCanvas",
  "syncBadge", "syncText", "cloudModal", "closeCloudModalBtn",
  "sbUrlInput", "sbKeyInput", "saveCloudSettingsBtn", "clearCloudSettingsBtn",
  "saveManualBtn",
  "chartTitle", "reviewBanner", "reviewInfo", "exitReviewBtn",
  "showLogTabBtn", "showHistoryTabBtn", "shotHistoryTab", "historyList",
  "thresholdSlider", "thresholdValue",
  "wakeSlider", "wakeValue",
  "sleepTimeoutSlider", "sleepTimeoutValue",
  "sleepSensSlider", "sleepSensValue",
  "viewTraceBtn", "viewTargetBtn",
  "formScoreValue", "coachTitle", "coachText", "holdStabilityValue",
  "releaseQualityValue", "followThroughValue", "cantValue",
  "lastShotTimeValue", "lastShotScoreValue", "lastPeakValue",
  "lastCantValue", "lastPitchValue",
  "reviewTraceControls", "replayTraceBtn", "zoomOutBtn", "zoomInBtn",
  "zoomValue",
  "zeroBtn", "cantOffsetVal", "pitchOffsetVal", "batteryBadge", "batteryText",
  "bufferRateSlider", "bufferRateValue", "bufferNVSToggle",
  "streamRateSlider", "streamRateValue"
];


const el = {};
for (const id of ELEMENT_IDS) el[id] = document.getElementById(id);

const bus = new EventBus();
const store = createStore({
  statusMode: "",
  statusText: "Disconnected",
  connected: false,
  hz: 0,
  lost: 0,
  frameCount: 0,
  accelG: 0,
  gyroMag: 0,
  shotCount: 0,
  wakeSensitivity: 2.0,
  sample: null,
  syncStatus: "local",
  syncText: "Local-Only",
  syncQueueCount: 0,
  cloudUser: null,
  reviewMode: false,
  reviewTrace: null,
  reviewInfo: "",
  chartView: "line",
  formScore: null,
  holdStability: null,
  releaseQuality: null,
  followThrough: null,
  coachTitle: "Waiting for movement",
  coachText: "Connect a sensor or run the demo to start reading hold stability.",
  roll: 0,
  pitch: 0,
  lastShotSummary: null,
  traceZoom: 1,
  replayActive: false,
  replayProgress: 1,
  batteryLevel: null,
  cantOffset: 0.0,
  pitchOffset: 0.0,
  bufferRate: 52,
  streamRate: 1110
});


// Initialize database
initDb().then(() => {
  bus.emit("log", "Local IndexedDB initialized successfully.");
}).catch((err) => {
  bus.emit("log", `Database initialization failed: ${err.message}`);
});

const telemetry = new TelemetryStore(bus, store);
const syncAdapter = new CloudSyncAdapter(bus, store);
telemetry.syncAdapter = syncAdapter; // Register sync on telemetry store

mountDashboard({ store, telemetry, el });
mountLog(bus, el.eventLog);

// Sync UI states by subscribing to the store
store.subscribe((state) => {
  if (el.syncBadge && el.syncText) {
    el.syncText.textContent = state.syncText;
    
    // Clear and set class names
    el.syncBadge.className = "status clickable";
    if (state.syncStatus) {
      el.syncBadge.classList.add(`sync-${state.syncStatus}`);
    }
  }

  // Sync active states of the line vs target toggle buttons
  if (el.viewTraceBtn && el.viewTargetBtn) {
    el.viewTraceBtn.classList.toggle("active", state.chartView === "line");
    el.viewTargetBtn.classList.toggle("active", state.chartView === "target");
  }

  if (el.reviewTraceControls && el.replayTraceBtn && el.zoomValue) {
    const pinReviewActive = state.reviewMode && state.chartView === "target";
    el.reviewTraceControls.classList.toggle("hidden", !pinReviewActive);
    el.replayTraceBtn.textContent = state.replayActive ? "Playing" : "Replay";
    el.replayTraceBtn.disabled = !pinReviewActive || state.replayActive;
    el.zoomValue.textContent = `${(state.traceZoom || 1).toFixed(1)}x`;
  }

  if (el.batteryBadge && el.batteryText) {
    if (state.connected && state.batteryLevel !== null) {
      el.batteryBadge.classList.remove("hidden");
      el.batteryText.textContent = `${state.batteryLevel}%`;
    } else {
      el.batteryBadge.classList.add("hidden");
    }
  }

  if (el.zeroBtn) {
    el.zeroBtn.disabled = !state.connected || (adapter && adapter.name === "Demo");
  }

  if (el.cantOffsetVal && el.pitchOffsetVal) {
    el.cantOffsetVal.textContent = (state.cantOffset || 0.0).toFixed(1);
    el.pitchOffsetVal.textContent = (state.pitchOffset || 0.0).toFixed(1);
  }
});

// Modal Event Listeners for Cloud Config
el.syncBadge.addEventListener("click", () => {
  el.sbUrlInput.value = localStorage.getItem("openfloat_supabase_url") || "";
  el.sbKeyInput.value = localStorage.getItem("openfloat_supabase_key") || "";
  el.cloudModal.classList.remove("hidden");
});

el.closeCloudModalBtn.addEventListener("click", () => {
  el.cloudModal.classList.add("hidden");
});

el.saveCloudSettingsBtn.addEventListener("click", async () => {
  const url = el.sbUrlInput.value.trim();
  const key = el.sbKeyInput.value.trim();

  if (url && key) {
    localStorage.setItem("openfloat_supabase_url", url);
    localStorage.setItem("openfloat_supabase_key", key);
    bus.emit("log", "Saved cloud configuration. Connecting to Supabase...");
    el.cloudModal.classList.add("hidden");
    await syncAdapter.resetConfig();
  } else {
    alert("Please enter both your Supabase URL and Anon Key.");
  }
});

el.clearCloudSettingsBtn.addEventListener("click", async () => {
  localStorage.removeItem("openfloat_supabase_url");
  localStorage.removeItem("openfloat_supabase_key");
  el.sbUrlInput.value = "";
  el.sbKeyInput.value = "";
  bus.emit("log", "Cleared cloud configuration. Local-only mode active.");
  el.cloudModal.classList.add("hidden");
  await syncAdapter.resetConfig();
});


let adapter = null;

function transport() {
  return el.transportSelect.value;
}

async function disconnect() {
  if (!adapter) return;
  try {
    await adapter.disconnect();
  } catch (_) {}
  adapter = null;
}

async function connect() {
  await disconnect();
  telemetry.reset();
  adapter = createAdapter(transport(), bus);
  try {
    await adapter.connect();
    // Push the current UI threshold to the firmware on BLE connect so the
    // device matches the slider.
    if (transport() === "ble") {
      await adapter.sendControl(`thresh:${thresholdGrams().toFixed(1)}`);
      await adapter.sendControl(`wakesens:${wakeSensitivityGrams().toFixed(1)}`);
      await adapter.sendControl(`sleeptime:${sleepTimeoutSeconds()}`);
      await adapter.sendControl(`sleepsens:${sleepSensitivityG().toFixed(2)}`);
      await adapter.sendControl(`bufrate:${bufferRateHz()}`);
      await adapter.sendControl(`bufnvs:${bufferNvsEnabled()}`);
      await adapter.sendControl(`streamrate:${streamRateDivider()}`);
    }

  } catch (error) {
    bus.emit("log", `Connect failed: ${error.message}`);
    adapter = null;
  }
}

function thresholdGrams() {
  return Number(el.thresholdSlider.value);
}

function wakeSensitivityGrams() {
  return Number(el.wakeSlider.value);
}

function sleepSensitivityG() {
  return Number(el.sleepSensSlider.value);
}

function sleepTimeoutSeconds() {
  return Number(el.sleepTimeoutSlider.value);
}

function bufferNvsEnabled() {
  return el.bufferNVSToggle.checked ? 1 : 0;
}

function bufferRateHz() {
  const val = Number(el.bufferRateSlider.value);
  if (val === 0) return 0;
  if (val === 1) return 52;
  if (val === 2) return 104;
  return 208;
}

function bufferRateLabelText(val) {
  if (val === 0) return "Off";
  if (val === 1) return "52 Hz (6s hold)";
  if (val === 2) return "104 Hz (3s hold)";
  return "208 Hz (1.5s hold)";
}

function streamRateDivider() {
  const val = Number(el.streamRateSlider.value);
  if (val === 0) return 20;
  if (val === 1) return 10;
  if (val === 2) return 5;
  if (val === 3) return 2;
  return 1;
}

function streamRateLabelText(val) {
  if (val === 0) return "55 Hz";
  if (val === 1) return "111 Hz";
  if (val === 2) return "222 Hz";
  if (val === 3) return "555 Hz";
  return "1110 Hz (Max)";
}


async function toggleDemo() {
  if (adapter && adapter.name === "Demo") {
    await disconnect();
    return;
  }
  await disconnect();
  telemetry.reset();
  adapter = createAdapter("demo", bus);
  await adapter.connect();
}

el.connectBtn.addEventListener("click", connect);
el.disconnectBtn.addEventListener("click", disconnect);
el.demoBtn.addEventListener("click", toggleDemo);
el.saveManualBtn.addEventListener("click", () => telemetry.saveManual30sCapture());
el.zeroBtn.addEventListener("click", () => {
  if (adapter) {
    adapter.sendControl("zero");
    const roll = store.get().roll || 0;
    const pitch = store.get().pitch || 0;
    store.set({
      cantOffset: roll,
      pitchOffset: pitch
    });
    bus.emit("log", `Zero calibration requested. Bow level set at Cant: ${roll.toFixed(1)}°, Pitch: ${pitch.toFixed(1)}°`);
  }
});

// Update the label live while dragging; only write to the device on release
// to avoid flooding the control characteristic.
el.thresholdSlider.addEventListener("input", () => {
  el.thresholdValue.textContent = thresholdGrams().toFixed(1);
});
el.thresholdSlider.addEventListener("change", () => {
  const command = `thresh:${thresholdGrams().toFixed(1)}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the shot threshold.");
});

// Update the label live while dragging; only write to the device on release
// to avoid flooding the control characteristic.
el.wakeSlider.addEventListener("input", () => {
  el.wakeValue.textContent = wakeSensitivityGrams().toFixed(1);
});
el.wakeSlider.addEventListener("change", () => {
  const command = `wakesens:${wakeSensitivityGrams().toFixed(1)}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the wake sensitivity.");
});

// Update the label live while dragging; only write to the device on release
// to avoid flooding the control characteristic.
el.sleepTimeoutSlider.addEventListener("input", () => {
  el.sleepTimeoutValue.textContent = sleepTimeoutSeconds();
});
el.sleepTimeoutSlider.addEventListener("change", () => {
  const command = `sleeptime:${sleepTimeoutSeconds()}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the sleep timeout.");
});

// Update the label live while dragging; only write to the device on release
// to avoid flooding the control characteristic.
el.sleepSensSlider.addEventListener("input", () => {
  el.sleepSensValue.textContent = sleepSensitivityG().toFixed(2);
});
el.sleepSensSlider.addEventListener("change", () => {
  const command = `sleepsens:${sleepSensitivityG().toFixed(2)}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the sleep sensitivity.");
});

el.bufferRateSlider.addEventListener("input", () => {
  const val = Number(el.bufferRateSlider.value);
  el.bufferRateValue.textContent = bufferRateLabelText(val);
});
el.bufferRateSlider.addEventListener("change", () => {
  const hz = bufferRateHz();
  const command = `bufrate:${hz}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the buffer rate.");
});

el.streamRateSlider.addEventListener("input", () => {
  const val = Number(el.streamRateSlider.value);
  el.streamRateValue.textContent = streamRateLabelText(val);
});
el.streamRateSlider.addEventListener("change", () => {
  const div = streamRateDivider();
  const command = `streamrate:${div}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the stream rate.");
});


el.bufferNVSToggle.addEventListener("change", () => {
  const val = bufferNvsEnabled();
  const command = `bufnvs:${val}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply NVS buffering.");
});

// Tab Switching Listeners
el.showLogTabBtn.addEventListener("click", () => {
  el.showLogTabBtn.classList.add("active");
  el.showHistoryTabBtn.classList.remove("active");
  el.eventLog.classList.remove("hidden");
  el.shotHistoryTab.classList.add("hidden");
});

el.showHistoryTabBtn.addEventListener("click", () => {
  el.showHistoryTabBtn.classList.add("active");
  el.showLogTabBtn.classList.remove("active");
  el.shotHistoryTab.classList.remove("hidden");
  el.eventLog.classList.add("hidden");
  loadShotHistoryList();
});

// Chart View Toggle Event Listeners
el.viewTraceBtn.addEventListener("click", () => {
  store.set({ chartView: "line", replayActive: false, replayProgress: 1 });
});

el.viewTargetBtn.addEventListener("click", () => {
  store.set({ chartView: "target" });
});

el.replayTraceBtn.addEventListener("click", () => {
  const state = store.get();
  if (!state.reviewMode || state.chartView !== "target" || state.replayActive) return;

  const durationMs = 1800;
  const startedAt = performance.now();
  store.set({ replayActive: true, replayProgress: 0 });

  function tick(now) {
    const current = store.get();
    if (!current.reviewMode || current.chartView !== "target") return;
    const progress = Math.min(1, (now - startedAt) / durationMs);
    store.set({
      replayProgress: progress,
      replayActive: progress < 1,
    });
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
});

el.zoomOutBtn.addEventListener("click", () => {
  const nextZoom = Math.max(0.4, Number(((store.get().traceZoom || 1) - 0.2).toFixed(1)));
  store.set({ traceZoom: nextZoom });
});

el.zoomInBtn.addEventListener("click", () => {
  const nextZoom = Math.min(3, Number(((store.get().traceZoom || 1) + 0.2).toFixed(1)));
  store.set({ traceZoom: nextZoom });
});

// Query local database for shots and render them
async function loadShotHistoryList() {
  el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">Loading saved history...</p>`;
  try {
    const shots = await getAll("shots");

    if (shots.length === 0) {
      el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet.</p>`;
      return;
    }

    // Sort chronologically (newest first)
    shots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    el.historyList.innerHTML = "";
    for (const shot of shots) {
      const item = document.createElement("div");
      item.className = "history-item";

      const timestampStr = new Date(shot.timestamp).toLocaleString();
      const title = shot.peak_g > 15 ? "Arrow Release" : "Hold Capture";
      const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);

      item.innerHTML = `
        <div class="history-meta">
          <div class="history-title">${title}</div>
          <div class="history-subtitle">${timestampStr}</div>
        </div>
        <div class="history-metrics">
          <div class="history-stat">
            <span class="history-stat-label">Score</span>
            <span class="history-stat-val score">${score}</span>
          </div>
          <div class="history-stat">
            <span class="history-stat-label">Stability</span>
            <span class="history-stat-val stability">${shot.stability_score}%</span>
          </div>
          <div class="history-stat">
            <span class="history-stat-label">Peak G</span>
            <span class="history-stat-val peak">${shot.peak_g.toFixed(1)}g</span>
          </div>
        </div>
      `;

      item.addEventListener("click", () => reviewShotTrace(shot));
      el.historyList.appendChild(item);
    }
  } catch (error) {
    console.error("Error loading shot history:", error);
    el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center; color: var(--red);">Failed to load history: ${error.message}</p>`;
  }
}

// Load trace and trigger review mode
async function reviewShotTrace(shot) {
  try {
    const trace = await get("shot_traces", shot.id);

    if (!trace || !trace.payload) {
      alert("Trace data for this shot could not be located in IndexedDB.");
      return;
    }

    const timeStr = new Date(shot.timestamp).toLocaleTimeString();
    const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
    const info = `Score: ${score} | Peak Force: ${shot.peak_g.toFixed(1)}g | Stability: ${shot.stability_score}% | Captured: ${timeStr}`;

    store.set({
      reviewMode: true,
      reviewTrace: trace.payload,
      reviewInfo: info,
      chartView: "target",
      replayActive: false,
      replayProgress: 1,
      traceZoom: 1,
      lastShotSummary: {
        timestamp: shot.timestamp,
        score,
        peakG: shot.peak_g,
        cant: shot.cant_angle_deg || shot.roll_angle_deg || 0,
        pitch: shot.pitch_angle_deg || 0,
      },
    });

    bus.emit("log", `Entering review mode for shot ${shot.id.slice(0, 8)}...`);
  } catch (error) {
    console.error("Failed to load trace:", error);
    alert("Error fetching trace payload: " + error.message);
  }
}

// Exit Review Mode
el.exitReviewBtn.addEventListener("click", () => {
  store.set({
    reviewMode: false,
    reviewTrace: null,
    reviewInfo: "",
    replayActive: false,
    replayProgress: 1,
    traceZoom: 1,
  });
  bus.emit("log", "Exited review mode. Returned to live telemetry stream.");
});

bus.emit("log", `Ready (${APP_BUILD}). Pick a transport and connect, or run the demo stream.`);
