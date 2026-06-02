// App entry point: build the shared bus + store, wire telemetry and UI, and
// own the transport lifecycle (connect / disconnect / demo).

import { createStore, EventBus } from "./core/store.js";
import { TelemetryStore } from "./telemetry/telemetry.js";
import { createAdapter } from "./device/adapters.js";
import { mountDashboard, mountLog } from "./ui/dashboard.js";
import { initDb, getAll, get } from "./core/db.js";
import { CloudSyncAdapter } from "./telemetry/sync.js";

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
  "thresholdSlider", "thresholdValue"
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
  sample: null,
  syncStatus: "local",
  syncText: "Local-Only",
  syncQueueCount: 0,
  cloudUser: null,
  reviewMode: false,
  reviewTrace: null,
  reviewInfo: ""
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
    }
  } catch (error) {
    bus.emit("log", `Connect failed: ${error.message}`);
    adapter = null;
  }
}

function thresholdGrams() {
  return Number(el.thresholdSlider.value);
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
      const title = shot.peak_g > 15 ? "Arrows Release" : "Stability Capture";

      item.innerHTML = `
        <div class="history-meta">
          <div class="history-title">${title}</div>
          <div class="history-subtitle">${timestampStr}</div>
        </div>
        <div class="history-metrics">
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
    const info = `Peak Force: ${shot.peak_g.toFixed(1)}g | Stability: ${shot.stability_score}% | Captured: ${timeStr}`;

    store.set({
      reviewMode: true,
      reviewTrace: trace.payload,
      reviewInfo: info
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
    reviewInfo: ""
  });
  bus.emit("log", "Exited review mode. Returned to live telemetry stream.");
});

bus.emit("log", "Ready. Pick a transport and connect, or run the demo stream.");

