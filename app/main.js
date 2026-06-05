// App entry point: build the shared bus + store, wire telemetry and UI, and
// own the transport lifecycle (connect / disconnect / demo).

import { createStore, EventBus } from "./core/store.js";
import { TelemetryStore, coachForScore } from "./telemetry/telemetry.js?v=shot-store-57";
import { createAdapter } from "./device/adapters.js?v=shot-store-57";
import {
  cloneMountAxes,
  mountDashboard,
  mountLog,
  mountOrientationById,
  mountOrientationSettings,
  mountOrientationState,
  rotateMountAxes,
} from "./ui/dashboard.js?v=shot-store-57";
import { mountAnalysis } from "./ui/analysis.js?v=shot-store-57";
import { initDb, getAll, get, put, remove, generateUUID } from "./core/db.js";
import { CloudSyncAdapter } from "./telemetry/sync.js?v=shot-store-57";

const APP_BUILD = "shot-store-57";
const MODEL_ATTITUDE_VERSION = 3;

const ELEMENT_IDS = [
  "statusBadge", "statusText", "transportSelect",
  "connectBtn", "disconnectBtn", "demoBtn",
  "protocolValue", "typeValue", "sourceValue", "seqValue", "lossValue",
  "dtValue", "hzValue", "frameCountValue",
  "shotCountValue", "eventLog", "traceCanvas",
  "orientationCanvas", "orientationRollValue", "orientationPitchValue", "orientationYawValue",
  "syncBadge", "syncText", "cloudModal", "closeCloudModalBtn",
  "sbUrlInput", "sbKeyInput", "saveCloudSettingsBtn", "clearCloudSettingsBtn",
  "saveManualBtn",
  "chartTitle", "reviewBanner", "reviewInfo", "exitReviewBtn",
  "navDashboardBtn", "navRecordBtn", "navHistoryBtn", "navSettingsBtn",
  "tabDashboard", "tabRecord", "tabHistory", "tabSettings", "historyList",
  "recordLabelInput", "recordStatusBox", "recordStatusBadge", "recordStatusText",
  "recordTimeText", "recordSamplesText", "startRecordBtn", "stopRecordBtn", "discardRecordBtn",
  "thresholdSlider", "thresholdValue",
  "wakeSlider", "wakeValue",
  "sleepTimeoutSlider", "sleepTimeoutValue",
  "sleepSensSlider", "sleepSensValue", "sleepEnableToggle",
  "viewTraceBtn", "viewTargetBtn",
  "formScoreValue", "coachTitle", "coachText", "holdStabilityValue",
  "releaseQualityValue", "followThroughValue", "cantValue",
  "levelCard", "levelBubble", "levelAlertText",
  "reviewTraceControls", "replayTraceBtn", "zoomOutBtn", "zoomInBtn",
  "zoomValue", "traceScrubSlider", "traceScrubValue", "tracePhaseRail",
  "zeroBtn", "zeroYawBtn", "cantOffsetVal", "pitchOffsetVal", "batteryBadge", "batteryText",
  "mountOrientationSelect", "mountOrientationCanvas", "mountOrientationDescription",
  "mountViewRollSlider", "mountViewRollValue",
  "mountPositionXSlider", "mountPositionYSlider", "mountPositionZSlider",
  "mountPositionXValue", "mountPositionYValue", "mountPositionZValue",
  "mountAxisXValue", "mountAxisYValue", "mountAxisZValue", "mountFirmwareNote",
  "mountRotateXBtn", "mountRotateYBtn", "mountRotateZBtn", "mountResetBtn",
  "modelRotateXBtn", "modelRotateYBtn", "modelRotateZBtn", "modelResetBtn",
  "modelInvertRollToggle", "modelInvertPitchToggle", "modelSwapRollPitchToggle", "modelIgnoreYawToggle",
  "modelAxisXValue", "modelAxisYValue", "modelAxisZValue",
  "bufferRateSlider", "bufferRateValue", "bufferNVSToggle",
  "followThroughSlider", "followThroughValueMs",
  "streamRateSlider", "streamRateValue",
  "mobileAlertBanner", "mobileAlertText", "closeMobileAlertBtn",
  "bowProfileSelect", "bowModelInput", "drawWeightInput", "stabilizerSetupInput", "bowNotesInput",
  "saveBowProfileBtn", "deleteBowProfileBtn", "newBowProfileBtn",
  "sessionLocationInput", "sessionBowSelect", "sessionStatusText", "startSessionBtn", "endSessionBtn",
  "compareBowASelect", "compareShotASelect", "compareBowBSelect", "compareShotBSelect",
  "runCompareBtn", "compareStatsPanel", "compareHoldAVal", "compareHoldBVal",
  "compareReleaseAVal", "compareReleaseBVal", "compareFollowAVal", "compareFollowBVal",
  "compareFormAVal", "compareFormBVal", "compareChartCard", "compareViewFloatBtn",
  "compareViewTimelineBtn", "compareCanvas", "navAnalysisBtn", "tabAnalysis",
  "compareTraceControls", "compareReplayBtn", "compareScrubSlider", "compareScrubValue",
  "compareZoomOutBtn", "compareZoomValue", "compareZoomInBtn",
  "recentShotsPanel", "recentShotsList",
  "toggleLevelTuneBtn", "levelTuneSection", "levelRangeSlider",
  "levelRangeValue", "levelToleranceSlider", "levelToleranceValue"
];

const el = {};
for (const id of ELEMENT_IDS) el[id] = document.getElementById(id);

// Load cached settings from localStorage
const cached = (() => {
  try {
    return JSON.parse(localStorage.getItem("openfloat_settings") || "{}");
  } catch (_) {
    return {};
  }
})();

const bus = new EventBus();
const cachedMountOrientation = cached.mountOrientation === "custom"
  ? "custom"
  : mountOrientationById(cached.mountOrientation).id;
const cachedMountBase = mountOrientationById(cached.mountBaseOrientation).id;
const cachedMountPreset = mountOrientationById(cachedMountBase);
const cachedMountAxes = cached.mountAxes && typeof cached.mountAxes === "object"
  ? {
      x: String(cached.mountAxes.x || cachedMountPreset.axes.x),
      y: String(cached.mountAxes.y || cachedMountPreset.axes.y),
      z: String(cached.mountAxes.z || cachedMountPreset.axes.z),
    }
  : cloneMountAxes(cachedMountPreset.axes);
const cachedMountRotation = Array.isArray(cached.mountRotation) && cached.mountRotation.length === 3
  ? cached.mountRotation.map((value, index) => Number.isFinite(Number(value)) ? Number(value) : cachedMountPreset.rotation[index])
  : [...cachedMountPreset.rotation];
const cachedMountPositionOffset = Array.isArray(cached.mountPositionOffset) && cached.mountPositionOffset.length === 3
  ? cached.mountPositionOffset.map((value) => Number.isFinite(Number(value)) ? Number(value) : 0)
  : [0, 0, 0];
const cachedViewRoll = Number.isFinite(Number(cached.viewRoll)) ? Number(cached.viewRoll) : 0;
const cachedModelAlignmentRotation = Array.isArray(cached.modelAlignmentRotation) && cached.modelAlignmentRotation.length === 3
  ? cached.modelAlignmentRotation.map((value) => Number.isFinite(Number(value)) ? Number(value) : 0)
  : [0, 0, 0];
const modelAttitudeMigrated = Number(cached.modelAttitudeVersion || 0) < MODEL_ATTITUDE_VERSION;
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
  threshold: cached.threshold !== undefined ? Number(cached.threshold) : 12.0,
  sample: null,
  syncStatus: "local",
  syncText: "Local-Only",
  syncQueueCount: 0,
  cloudUser: null,
  reviewMode: false,
  reviewTrace: null,
  reviewSampleRateHz: 52,
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
  yaw: 0,
  lastShotSummary: null,
  traceZoom: 1,
  replayActive: false,
  replayPaused: false,
  replayProgress: 1,
  batteryLevel: null,
  cantOffset: cached.cantOffset !== undefined ? Number(cached.cantOffset) : 0.0,
  levelRange: cached.levelRange !== undefined ? Number(cached.levelRange) : 12.0,
  levelTolerance: cached.levelTolerance !== undefined ? Number(cached.levelTolerance) : 2.0,
  pitchOffset: cached.pitchOffset !== undefined ? Number(cached.pitchOffset) : 0.0,
  yawOffset: cached.yawOffset !== undefined ? Number(cached.yawOffset) : 0.0,
  mountOrientation: cachedMountOrientation,
  mountBaseOrientation: cachedMountBase,
  mountAxes: cachedMountOrientation === "custom" ? cachedMountAxes : cloneMountAxes(mountOrientationById(cachedMountOrientation).axes),
  mountRotation: cachedMountOrientation === "custom" ? cachedMountRotation : [...mountOrientationById(cachedMountOrientation).rotation],
  mountPositionOffset: cachedMountPositionOffset,
  viewRoll: cachedViewRoll,
  modelAlignmentRotation: cachedModelAlignmentRotation,
  modelAttitudeVersion: MODEL_ATTITUDE_VERSION,
  modelInvertRoll: modelAttitudeMigrated ? false : !!cached.modelInvertRoll,
  modelInvertPitch: modelAttitudeMigrated ? false : !!cached.modelInvertPitch,
  modelSwapRollPitch: modelAttitudeMigrated ? false : !!cached.modelSwapRollPitch,
  modelIgnoreYaw: modelAttitudeMigrated ? false : !!cached.modelIgnoreYaw,
  bufferRate: cached.bufferRate !== undefined ? (Number(cached.bufferRate) === 0 ? 0 : Number(cached.bufferRate) === 1 ? 52 : Number(cached.bufferRate) === 2 ? 104 : 208) : 52,
  followThroughMs: cached.followThrough !== undefined ? Number(cached.followThrough) : 1500,
  streamRate: cached.streamRate !== undefined ? (Number(cached.streamRate) === 0 ? 55 : Number(cached.streamRate) === 1 ? 111 : Number(cached.streamRate) === 2 ? 222 : Number(cached.streamRate) === 3 ? 555 : 1110) : 1110,
  manualRecordingActive: false,
  manualRecordSamples: 0,
  manualRecordElapsedSec: 0
});

function saveSettingsToCache() {
  try {
    const settings = {
      threshold: el.thresholdSlider.value,
      wake: el.wakeSlider.value,
      sleepTimeout: el.sleepTimeoutSlider.value,
      sleepSens: el.sleepSensSlider.value,
      sleepEnable: el.sleepEnableToggle.checked,
      bufferRate: el.bufferRateSlider.value,
      followThrough: el.followThroughSlider.value,
      streamRate: el.streamRateSlider.value,
      bufferNVS: el.bufferNVSToggle.checked,
      transport: el.transportSelect.value,
      cantOffset: store.get().cantOffset,
      levelRange: store.get().levelRange,
      levelTolerance: store.get().levelTolerance,
      pitchOffset: store.get().pitchOffset,
      yawOffset: store.get().yawOffset,
      mountOrientation: store.get().mountOrientation,
      mountBaseOrientation: store.get().mountBaseOrientation,
      mountAxes: store.get().mountAxes,
      mountRotation: store.get().mountRotation,
      mountPositionOffset: store.get().mountPositionOffset,
      viewRoll: store.get().viewRoll,
      modelAlignmentRotation: store.get().modelAlignmentRotation,
      modelAttitudeVersion: MODEL_ATTITUDE_VERSION,
      modelInvertRoll: store.get().modelInvertRoll,
      modelInvertPitch: store.get().modelInvertPitch,
      modelSwapRollPitch: store.get().modelSwapRollPitch,
      modelIgnoreYaw: store.get().modelIgnoreYaw
    };
    localStorage.setItem("openfloat_settings", JSON.stringify(settings));
  } catch (err) {
    console.error("Failed to save settings to cache:", err);
  }
}

function initSettingsFromCache() {
  try {
    if (cached.threshold !== undefined) {
      el.thresholdSlider.value = cached.threshold;
      el.thresholdValue.textContent = thresholdGrams().toFixed(1);
    }
    if (cached.wake !== undefined) {
      el.wakeSlider.value = cached.wake;
      el.wakeValue.textContent = wakeSensitivityGrams().toFixed(1);
    }
    if (cached.sleepTimeout !== undefined) {
      el.sleepTimeoutSlider.value = cached.sleepTimeout;
      el.sleepTimeoutValue.textContent = sleepTimeoutSeconds();
    }
    if (cached.sleepSens !== undefined) {
      el.sleepSensSlider.value = cached.sleepSens;
      el.sleepSensValue.textContent = sleepSensitivityG().toFixed(2);
    }
    if (cached.sleepEnable !== undefined) {
      el.sleepEnableToggle.checked = !!cached.sleepEnable;
    }
    if (cached.bufferRate !== undefined) {
      el.bufferRateSlider.value = cached.bufferRate;
      el.bufferRateValue.textContent = bufferRateLabelText(Number(cached.bufferRate));
    }
    if (cached.followThrough !== undefined) {
      el.followThroughSlider.value = cached.followThrough;
      el.followThroughValueMs.textContent = followThroughLabelText(followThroughMs());
    }
    if (cached.streamRate !== undefined) {
      el.streamRateSlider.value = cached.streamRate;
      el.streamRateValue.textContent = streamRateLabelText(Number(cached.streamRate));
    }
    if (cached.bufferNVS !== undefined) {
      el.bufferNVSToggle.checked = !!cached.bufferNVS;
    }
    if (cached.transport !== undefined) {
      el.transportSelect.value = cached.transport;
    }
    if (cached.mountOrientation !== undefined && el.mountOrientationSelect) {
      el.mountOrientationSelect.value = cachedMountOrientation;
    }
    if (Array.isArray(cached.mountPositionOffset) && cached.mountPositionOffset.length === 3) {
      el.mountPositionXSlider.value = cachedMountPositionOffset[0];
      el.mountPositionYSlider.value = cachedMountPositionOffset[1];
      el.mountPositionZSlider.value = cachedMountPositionOffset[2];
      el.mountPositionXValue.textContent = cachedMountPositionOffset[0].toFixed(2);
      el.mountPositionYValue.textContent = cachedMountPositionOffset[1].toFixed(2);
      el.mountPositionZValue.textContent = cachedMountPositionOffset[2].toFixed(2);
    }
    if (cached.viewRoll !== undefined && el.mountViewRollSlider && el.mountViewRollValue) {
      el.mountViewRollSlider.value = cachedViewRoll;
      el.mountViewRollValue.textContent = Math.round(cachedViewRoll);
    }
    if (cached.levelRange !== undefined && el.levelRangeSlider && el.levelRangeValue) {
      el.levelRangeSlider.value = cached.levelRange;
      el.levelRangeValue.textContent = cached.levelRange;
    }
    if (cached.levelTolerance !== undefined && el.levelToleranceSlider && el.levelToleranceValue) {
      el.levelToleranceSlider.value = cached.levelTolerance;
      el.levelToleranceValue.textContent = Number(cached.levelTolerance).toFixed(1);
    }
  } catch (err) {
    console.error("Failed to init settings from cache:", err);
  }
}

// Initialize database
initDb().then(async () => {
  bus.emit("log", "Local IndexedDB initialized successfully.");
  await loadBowProfiles();
  await restoreActiveSession();
  await loadRecentShotsList();
}).catch((err) => {
  bus.emit("log", `Database initialization failed: ${err.message}`);
});

const telemetry = new TelemetryStore(bus, store);
const syncAdapter = new CloudSyncAdapter(bus, store);
telemetry.syncAdapter = syncAdapter; // Register sync on telemetry store

mountDashboard({ store, telemetry, el });
mountLog(bus, el.eventLog);
mountAnalysis(bus, store, el);
mountOrientationSettings({ store, el });

// Initialize settings fields from localStorage cache on load
initSettingsFromCache();
if (modelAttitudeMigrated) {
  saveSettingsToCache();
  bus.emit("log", "Updated model attitude defaults for the imported bow axes.");
}

// Sync UI states by subscribing to the store
store.subscribe((state) => {
  if (el.syncBadge && el.syncText) {
    el.syncText.textContent = state.syncText;
    el.syncBadge.className = "status clickable";
    if (state.syncStatus) {
      el.syncBadge.classList.add(`sync-${state.syncStatus}`);
    }
  }

  if (el.viewTraceBtn && el.viewTargetBtn) {
    el.viewTraceBtn.classList.toggle("active", state.chartView === "line");
    el.viewTargetBtn.classList.toggle("active", state.chartView === "target");
  }

  if (el.reviewTraceControls && el.replayTraceBtn && el.zoomValue) {
    const pinReviewActive = state.reviewMode && state.chartView === "target";
    el.reviewTraceControls.classList.toggle("hidden", !pinReviewActive);
    if (state.replayActive) {
      el.replayTraceBtn.textContent = state.replayPaused ? "Resume" : "Pause";
    } else {
      el.replayTraceBtn.textContent = state.replayProgress > 0 && state.replayProgress < 1 ? "Resume" : "Replay";
    }
    el.replayTraceBtn.disabled = !pinReviewActive;
    el.zoomValue.textContent = `${(state.traceZoom || 1).toFixed(1)}x`;
    if (el.traceScrubSlider && el.traceScrubValue) {
      const progress = Math.max(0, Math.min(1, state.replayProgress ?? 1));
      if (document.activeElement !== el.traceScrubSlider) {
        el.traceScrubSlider.value = String(Math.round(progress * 1000));
      }
      el.traceScrubSlider.disabled = !pinReviewActive;
      el.traceScrubValue.textContent = traceScrubLabel(state);
    }
    if (el.tracePhaseRail) {
      const segments = tracePhaseSegments(state.reviewTrace);
      const hold = el.tracePhaseRail.querySelector(".phase-hold");
      const brk = el.tracePhaseRail.querySelector(".phase-break");
      const release = el.tracePhaseRail.querySelector(".phase-release");
      const follow = el.tracePhaseRail.querySelector(".phase-follow");
      if (hold) hold.style.flexBasis = `${segments.hold}%`;
      if (brk) brk.style.flexBasis = `${segments.break}%`;
      if (release) release.style.flexBasis = `${segments.release}%`;
      if (follow) follow.style.flexBasis = `${segments.follow}%`;
    }
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
  if (el.zeroYawBtn) {
    el.zeroYawBtn.disabled = !state.connected || (adapter && adapter.name === "Demo");
  }

  if (el.cantOffsetVal && el.pitchOffsetVal) {
    el.cantOffsetVal.textContent = (state.cantOffset || 0.0).toFixed(1);
    el.pitchOffsetVal.textContent = (state.pitchOffset || 0.0).toFixed(1);
  }

  if (el.startRecordBtn && el.stopRecordBtn && el.discardRecordBtn) {
    const connected = state.connected;
    const active = state.manualRecordingActive;
    
    el.startRecordBtn.disabled = !connected || active;
    el.startRecordBtn.classList.toggle("hidden", active);
    el.stopRecordBtn.classList.toggle("hidden", !active);
    el.discardRecordBtn.classList.toggle("hidden", !active);
  }

  if (el.recordStatusText && el.recordStatusBox && el.recordStatusBadge) {
    if (state.manualRecordingActive) {
      el.recordStatusText.textContent = "Recording...";
      el.recordStatusBox.className = "record-status-box recording";
      el.recordStatusBadge.className = "record-status-badge recording";
    } else if (state.connected) {
      el.recordStatusText.textContent = "Ready";
      el.recordStatusBox.className = "record-status-box";
      el.recordStatusBadge.className = "record-status-badge ready";
    } else {
      el.recordStatusText.textContent = "Disconnected";
      el.recordStatusBox.className = "record-status-box";
      el.recordStatusBadge.className = "record-status-badge";
    }
  }

  if (el.recordTimeText) {
    el.recordTimeText.textContent = `${(state.manualRecordElapsedSec || 0.0).toFixed(1)}s`;
  }

  if (el.recordSamplesText) {
    el.recordSamplesText.textContent = state.manualRecordSamples || 0;
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
    if (transport() === "ble") {
      await adapter.sendControl(`thresh:${thresholdGrams().toFixed(1)}`);
      await adapter.sendControl(`wakesens:${wakeSensitivityGrams().toFixed(1)}`);
      await adapter.sendControl(`sleeptime:${sleepTimeoutSeconds()}`);
      await adapter.sendControl(`sleepsens:${sleepSensitivityG().toFixed(2)}`);
      await adapter.sendControl(`bufrate:${bufferRateHz()}`);
      await adapter.sendControl(`bufnvs:${bufferNvsEnabled()}`);
      await adapter.sendControl(`followms:${followThroughMs()}`);
      await adapter.sendControl(`streamrate:${streamRateDivider()}`);
      await adapter.sendControl(`autosleep:${autoSleepEnabled()}`);
    }

  } catch (error) {
    bus.emit("log", `Connect failed: ${error.message}`);
    adapter = null;
  }
}

function thresholdGrams() {
  return Number(el.thresholdSlider.value);
}

// Mobile checks and alerts setup
function checkMobileCompatibility() {
  const userAgent = navigator.userAgent || "";
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isMobile) {
    if (!navigator.bluetooth) {
      if (isIOS) {
        el.mobileAlertText.innerHTML = `iOS Safari and Chrome do not support Web Bluetooth. To connect to your bow sensor, please open this page in a Bluetooth-capable app like <strong>Bluefy</strong> or <strong>WebBLE</strong>.`;
      } else {
        el.mobileAlertText.textContent = `Your mobile browser does not support Web Bluetooth. To connect to your bow sensor, please use Google Chrome on Android.`;
      }
      el.mobileAlertBanner.classList.remove("hidden");
    } else {
      el.mobileAlertText.textContent = `Web Serial (USB) is not supported on mobile devices. Please connect using Bluetooth (BLE).`;
      el.mobileAlertBanner.classList.remove("hidden");
    }
  } else {
    if (!navigator.bluetooth && !navigator.serial) {
      el.mobileAlertText.textContent = `Your browser does not support Web Bluetooth or Web Serial. For the full experience, please use Chrome, Edge, or Opera.`;
      el.mobileAlertBanner.classList.remove("hidden");
    }
  }
}

if (el.mobileAlertBanner && el.mobileAlertText && el.closeMobileAlertBtn) {
  el.closeMobileAlertBtn.addEventListener("click", () => {
    el.mobileAlertBanner.classList.add("hidden");
  });
  checkMobileCompatibility();
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

function autoSleepEnabled() {
  return el.sleepEnableToggle.checked ? 1 : 0;
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
  if (val === 1) return "Device 52 Hz / Web 208 Hz";
  if (val === 2) return "Device 104 Hz / Web 416 Hz";
  return "Device 208 Hz / Web 832 Hz";
}

function followThroughMs() {
  return Number(el.followThroughSlider.value);
}

function followThroughLabelText(ms) {
  return (ms / 1000).toFixed(1);
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

function reviewSampleRateHz(state) {
  return Number(state.reviewSampleRateHz || 52);
}

function reviewDurationSeconds(state) {
  const traceLength = state.reviewTrace ? state.reviewTrace.length : 0;
  if (traceLength <= 1) return 0;
  return (traceLength - 1) / reviewSampleRateHz(state);
}

function traceScrubLabel(state) {
  const progress = Math.max(0, Math.min(1, state.replayProgress ?? 1));
  const elapsed = progress * reviewDurationSeconds(state);
  return `${elapsed.toFixed(1)}s`;
}

function tracePhaseSegments(trace) {
  if (!trace || trace.length < 2) {
    return { hold: 100, break: 0, release: 0, follow: 0 };
  }

  let releaseIdx = Math.round(trace.length * 0.62);
  let maxG = 0;
  for (let i = 0; i < trace.length; i++) {
    const pt = trace[i];
    const g = Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0);
    if (g > maxG) {
      maxG = g;
      releaseIdx = i;
    }
  }

  if (maxG <= 1.35) {
    releaseIdx = Math.round(trace.length * 0.62);
  }

  const breakStart = Math.max(0, releaseIdx - Math.max(4, Math.round(trace.length * 0.025)));
  const releaseEnd = Math.min(trace.length - 1, releaseIdx + Math.max(8, Math.round(trace.length * 0.055)));
  const total = Math.max(1, trace.length - 1);

  return {
    hold: (breakStart / total) * 100,
    break: ((releaseIdx - breakStart) / total) * 100,
    release: ((releaseEnd - releaseIdx) / total) * 100,
    follow: ((total - releaseEnd) / total) * 100,
  };
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
el.statusBadge.addEventListener("click", async () => {
  if (store.get().connected) {
    await disconnect();
  } else {
    await connect();
  }
});
el.demoBtn.addEventListener("click", toggleDemo);
el.saveManualBtn.addEventListener("click", () => telemetry.saveManual30sCapture());
el.startRecordBtn.addEventListener("click", () => {
  const label = el.recordLabelInput.value.trim() || "Manual Capture";
  telemetry.startManualRecording(label);
});
el.stopRecordBtn.addEventListener("click", async () => {
  const savedId = await telemetry.saveManualRecording();
  if (savedId) {
    el.recordLabelInput.value = "";
    selectViewTab("tabHistory");
  }
});
el.discardRecordBtn.addEventListener("click", () => {
  if (confirm("Are you sure you want to discard this manual recording?")) {
    telemetry.discardManualRecording();
  }
});
el.zeroBtn.addEventListener("click", () => {
  if (adapter) {
    adapter.sendControl("zero");
    const roll = store.get().roll || 0;
    const pitch = store.get().pitch || 0;
    const yaw = store.get().yaw || 0;
    store.set({
      cantOffset: roll,
      pitchOffset: pitch
    });
    bus.emit("log", `Zero calibration requested. Bow level set at Cant: ${roll.toFixed(1)} deg, Pitch: ${pitch.toFixed(1)} deg, Yaw: ${yaw.toFixed(1)} deg`);
    saveSettingsToCache();
  }
});
el.zeroYawBtn.addEventListener("click", () => {
  const yaw = store.get().yaw || 0;
  store.set({
    yawOffset: yaw
  });
  bus.emit("log", `Yaw calibrated. Browser offset set at Yaw: ${yaw.toFixed(1)} deg`);
  saveSettingsToCache();
});

if (el.toggleLevelTuneBtn && el.levelTuneSection) {
  el.toggleLevelTuneBtn.addEventListener("click", () => {
    const isHidden = el.levelTuneSection.classList.contains("hidden");
    el.levelTuneSection.classList.toggle("hidden", !isHidden);
    el.toggleLevelTuneBtn.textContent = isHidden ? "Close Tuning" : "Tune Bubble Settings";
    el.toggleLevelTuneBtn.classList.toggle("active", isHidden);
  });
}

if (el.levelRangeSlider && el.levelRangeValue) {
  el.levelRangeSlider.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    el.levelRangeValue.textContent = val;
    store.set({ levelRange: val });
    saveSettingsToCache();
  });
}

if (el.levelToleranceSlider && el.levelToleranceValue) {
  el.levelToleranceSlider.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    el.levelToleranceValue.textContent = val.toFixed(1);
    store.set({ levelTolerance: val });
    saveSettingsToCache();
  });
}

el.thresholdSlider.addEventListener("input", () => {
  const val = thresholdGrams();
  el.thresholdValue.textContent = val.toFixed(1);
  store.set({ threshold: val });
});
el.thresholdSlider.addEventListener("change", () => {
  const command = `thresh:${thresholdGrams().toFixed(1)}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the shot threshold.");
  saveSettingsToCache();
});

el.wakeSlider.addEventListener("input", () => {
  el.wakeValue.textContent = wakeSensitivityGrams().toFixed(1);
});
el.wakeSlider.addEventListener("change", () => {
  const command = `wakesens:${wakeSensitivityGrams().toFixed(1)}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the wake sensitivity.");
  saveSettingsToCache();
});

el.sleepTimeoutSlider.addEventListener("input", () => {
  el.sleepTimeoutValue.textContent = sleepTimeoutSeconds();
});
el.sleepTimeoutSlider.addEventListener("change", () => {
  const command = `sleeptime:${sleepTimeoutSeconds()}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the sleep timeout.");
  saveSettingsToCache();
});

el.sleepSensSlider.addEventListener("input", () => {
  el.sleepSensValue.textContent = sleepSensitivityG().toFixed(2);
});
el.sleepSensSlider.addEventListener("change", () => {
  const command = `sleepsens:${sleepSensitivityG().toFixed(2)}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the sleep sensitivity.");
  saveSettingsToCache();
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
  saveSettingsToCache();
});

el.followThroughSlider.addEventListener("input", () => {
  el.followThroughValueMs.textContent = followThroughLabelText(followThroughMs());
});
el.followThroughSlider.addEventListener("change", () => {
  const command = `followms:${followThroughMs()}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply the follow-through recording window.");
  saveSettingsToCache();
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
  saveSettingsToCache();
});

el.bufferNVSToggle.addEventListener("change", () => {
  const val = bufferNvsEnabled();
  const command = `bufnvs:${val}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply NVS buffering.");
  saveSettingsToCache();
});

el.sleepEnableToggle.addEventListener("change", () => {
  const val = autoSleepEnabled();
  const command = `autosleep:${val}`;
  if (adapter) adapter.sendControl(command);
  else bus.emit("log", "Connect over BLE to apply auto-sleep settings.");
  saveSettingsToCache();
});

el.transportSelect.addEventListener("change", () => {
  saveSettingsToCache();
});

el.mountOrientationSelect.addEventListener("change", () => {
  const selected = el.mountOrientationSelect.value;
  if (selected === "custom") {
    store.set({ mountOrientation: "custom" });
    bus.emit("log", "Mount orientation set to custom rotated preview.");
    saveSettingsToCache();
    return;
  }

  const orientation = mountOrientationById(selected);
  store.set({
    mountOrientation: orientation.id,
    mountBaseOrientation: orientation.id,
    mountAxes: cloneMountAxes(orientation.axes),
    mountRotation: [...orientation.rotation],
  });
  bus.emit("log", `Mount orientation set to "${orientation.label}". Rebuild firmware with the matching axis mapping for device-computed angles.`);
  saveSettingsToCache();
});

function rotateMountPreview(bowAxis) {
  const current = mountOrientationState(store.get());
  const rotation = [...current.rotation];
  const axisIndex = bowAxis === "x" ? 0 : bowAxis === "y" ? 1 : 2;
  rotation[axisIndex] = Number(((rotation[axisIndex] || 0) - Math.PI / 2).toFixed(6));
  const axes = rotateMountAxes(current.axes, bowAxis);

  store.set({
    mountOrientation: "custom",
    mountAxes: axes,
    mountRotation: rotation,
  });

  const axisName = bowAxis.toUpperCase();
  bus.emit("log", `Rotated IMU preview 90 deg around Bow ${axisName}. Axis map is Bow X ${axes.x}, Bow Y ${axes.y}, Bow Z ${axes.z}.`);
  saveSettingsToCache();
}

function resetMountPreview() {
  const preset = mountOrientationById(store.get().mountBaseOrientation);
  store.set({
    mountOrientation: preset.id,
    mountAxes: cloneMountAxes(preset.axes),
    mountRotation: [...preset.rotation],
    mountPositionOffset: [0, 0, 0],
    viewRoll: 0,
  });
  bus.emit("log", `Mount orientation, position, and view roll reset to "${preset.label}".`);
  saveSettingsToCache();
}

el.mountViewRollSlider.addEventListener("input", () => {
  const viewRoll = Number(el.mountViewRollSlider.value);
  el.mountViewRollValue.textContent = Math.round(viewRoll);
  store.set({ viewRoll });
});

el.mountViewRollSlider.addEventListener("change", () => {
  const viewRoll = Number(store.get().viewRoll || 0);
  bus.emit("log", `3D view roll set to ${Math.round(viewRoll)} deg around the module origin.`);
  saveSettingsToCache();
});

function setMountPositionOffset(axisIndex, value) {
  const current = Array.isArray(store.get().mountPositionOffset)
    ? [...store.get().mountPositionOffset]
    : [0, 0, 0];
  current[axisIndex] = Number.isFinite(value) ? value : 0;
  store.set({ mountPositionOffset: current });
}

[
  [el.mountPositionXSlider, 0],
  [el.mountPositionYSlider, 1],
  [el.mountPositionZSlider, 2],
].forEach(([slider, axisIndex]) => {
  slider.addEventListener("input", () => {
    setMountPositionOffset(axisIndex, Number(slider.value));
  });
  slider.addEventListener("change", () => {
    const [x, y, z] = store.get().mountPositionOffset;
    bus.emit("log", `Bow preview offset set to X ${x.toFixed(2)}, Y ${y.toFixed(2)}, Z ${z.toFixed(2)} with the module at origin.`);
    saveSettingsToCache();
  });
});

el.mountRotateXBtn.addEventListener("click", () => rotateMountPreview("x"));
el.mountRotateYBtn.addEventListener("click", () => rotateMountPreview("y"));
el.mountRotateZBtn.addEventListener("click", () => rotateMountPreview("z"));
el.mountResetBtn.addEventListener("click", resetMountPreview);

function rotateModelAlignment(axis) {
  const rotation = Array.isArray(store.get().modelAlignmentRotation)
    ? [...store.get().modelAlignmentRotation]
    : [0, 0, 0];
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  rotation[axisIndex] = Number(((rotation[axisIndex] || 0) + Math.PI / 2).toFixed(6));
  store.set({ modelAlignmentRotation: rotation });
  bus.emit("log", `Rotated Blender bow model 90 deg around Model ${axis.toUpperCase()}.`);
  saveSettingsToCache();
}

function resetModelAlignment() {
  store.set({
    modelAlignmentRotation: [0, 0, 0],
    modelInvertRoll: false,
    modelInvertPitch: false,
    modelSwapRollPitch: false,
    modelIgnoreYaw: false,
  });
  bus.emit("log", "Reset Blender bow model alignment.");
  saveSettingsToCache();
}

el.modelRotateXBtn.addEventListener("click", () => rotateModelAlignment("x"));
el.modelRotateYBtn.addEventListener("click", () => rotateModelAlignment("y"));
el.modelRotateZBtn.addEventListener("click", () => rotateModelAlignment("z"));
el.modelResetBtn.addEventListener("click", resetModelAlignment);
el.modelInvertRollToggle.addEventListener("change", () => {
  store.set({ modelInvertRoll: el.modelInvertRollToggle.checked });
  bus.emit("log", `${el.modelInvertRollToggle.checked ? "Enabled" : "Disabled"} inverted model roll.`);
  saveSettingsToCache();
});
el.modelInvertPitchToggle.addEventListener("change", () => {
  store.set({ modelInvertPitch: el.modelInvertPitchToggle.checked });
  bus.emit("log", `${el.modelInvertPitchToggle.checked ? "Enabled" : "Disabled"} inverted model pitch.`);
  saveSettingsToCache();
});
el.modelSwapRollPitchToggle.addEventListener("change", () => {
  store.set({ modelSwapRollPitch: el.modelSwapRollPitchToggle.checked });
  bus.emit("log", `${el.modelSwapRollPitchToggle.checked ? "Enabled" : "Disabled"} swapped model cant/pitch axes.`);
  saveSettingsToCache();
});
el.modelIgnoreYawToggle.addEventListener("change", () => {
  store.set({ modelIgnoreYaw: el.modelIgnoreYawToggle.checked });
  bus.emit("log", `${el.modelIgnoreYawToggle.checked ? "Enabled" : "Disabled"} ignoring model yaw.`);
  saveSettingsToCache();
});

// Tab Switching Navigation Logic
function selectViewTab(targetId) {
  const tabs = ["tabDashboard", "tabRecord", "tabHistory", "tabSettings", "tabAnalysis"];
  const navButtons = {
    tabDashboard: el.navDashboardBtn,
    tabRecord: el.navRecordBtn,
    tabHistory: el.navHistoryBtn,
    tabSettings: el.navSettingsBtn,
    tabAnalysis: el.navAnalysisBtn
  };
  const panels = {
    tabDashboard: el.tabDashboard,
    tabRecord: el.tabRecord,
    tabHistory: el.tabHistory,
    tabSettings: el.tabSettings,
    tabAnalysis: el.tabAnalysis
  };

  tabs.forEach((id) => {
    const isActive = id === targetId;
    if (panels[id]) {
      panels[id].classList.toggle("active-view", isActive);
      panels[id].classList.toggle("hidden-view", !isActive);
    }
    if (navButtons[id]) {
      navButtons[id].classList.toggle("active", isActive);
    }
  });

  bus.emit("view-changed", targetId);

  if (targetId === "tabHistory") {
    loadShotHistoryList();
  }
  if (targetId === "tabDashboard") {
    loadRecentShotsList();
  }
}

if (el.navDashboardBtn && el.navRecordBtn && el.navHistoryBtn && el.navSettingsBtn && el.navAnalysisBtn) {
  el.navDashboardBtn.addEventListener("click", () => selectViewTab("tabDashboard"));
  el.navRecordBtn.addEventListener("click", () => selectViewTab("tabRecord"));
  el.navHistoryBtn.addEventListener("click", () => selectViewTab("tabHistory"));
  el.navAnalysisBtn.addEventListener("click", () => selectViewTab("tabAnalysis"));
  el.navSettingsBtn.addEventListener("click", () => selectViewTab("tabSettings"));
}

// Chart View Toggle Event Listeners
el.viewTraceBtn.addEventListener("click", () => {
  store.set({ chartView: "line", replayActive: false, replayPaused: false, replayProgress: 1 });
});

el.viewTargetBtn.addEventListener("click", () => {
  store.set({ chartView: "target" });
});

el.replayTraceBtn.addEventListener("click", () => {
  const state = store.get();
  if (!state.reviewMode || state.chartView !== "target") return;

  if (state.replayActive && !state.replayPaused) {
    store.set({ replayPaused: true });
    return;
  }

  const durationMs = 1800;
  const startProgress = state.replayProgress >= 1 ? 0 : (state.replayProgress || 0);
  const startedAt = performance.now() - startProgress * durationMs;
  store.set({ replayActive: true, replayPaused: false, replayProgress: startProgress });

  function tick(now) {
    const current = store.get();
    if (!current.reviewMode || current.chartView !== "target") return;
    if (current.replayPaused) return;
    const progress = Math.min(1, (now - startedAt) / durationMs);
    store.set({
      replayProgress: progress,
      replayActive: progress < 1,
      replayPaused: false,
    });
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
});

el.traceScrubSlider.addEventListener("input", () => {
  const progress = Number(el.traceScrubSlider.value) / 1000;
  store.set({
    replayActive: false,
    replayPaused: false,
    replayProgress: progress,
  });
});

el.zoomOutBtn.addEventListener("click", () => {
  const nextZoom = Math.max(0.4, Number(((store.get().traceZoom || 1) - 0.2).toFixed(1)));
  store.set({ traceZoom: nextZoom });
});

el.zoomInBtn.addEventListener("click", () => {
  const nextZoom = Math.min(3, Number(((store.get().traceZoom || 1) + 0.2).toFixed(1)));
  store.set({ traceZoom: nextZoom });
});

// Bow Profile & Session Management Functions
async function loadBowProfiles() {
  try {
    const profiles = await getAll("bow_profiles");
    
    // Clear and reset dynamic options
    el.bowProfileSelect.innerHTML = '<option value="">Default Bow</option>';
    el.sessionBowSelect.innerHTML = '<option value="">Default Bow</option>';

    profiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.model + (profile.draw_weight ? ` (${profile.draw_weight} lbs)` : "");
      
      el.bowProfileSelect.appendChild(option.cloneNode(true));
      el.sessionBowSelect.appendChild(option);
    });

    // Restore selected active bow
    const activeBowId = localStorage.getItem("openfloat_active_bow_id") || "";
    el.bowProfileSelect.value = activeBowId;
    el.sessionBowSelect.value = activeBowId;
    
    populateBowForm();
  } catch (error) {
    console.error("Error loading bow profiles:", error);
    bus.emit("log", `Error loading bow profiles: ${error.message}`);
  }
}

async function populateBowForm() {
  const selectedId = el.bowProfileSelect.value;
  if (!selectedId) {
    el.bowModelInput.value = "";
    el.drawWeightInput.value = "";
    el.stabilizerSetupInput.value = "";
    el.bowNotesInput.value = "";
    el.deleteBowProfileBtn.disabled = true;
  } else {
    try {
      const profile = await get("bow_profiles", selectedId);
      if (profile) {
        el.bowModelInput.value = profile.model || "";
        el.drawWeightInput.value = profile.draw_weight != null ? profile.draw_weight : "";
        el.stabilizerSetupInput.value = profile.stabilizer_setup || "";
        el.bowNotesInput.value = profile.notes || "";
        el.deleteBowProfileBtn.disabled = false;
      }
    } catch (error) {
      console.error("Error loading bow details:", error);
    }
  }
}

async function restoreActiveSession() {
  const sessionId = localStorage.getItem("openfloat_active_session_id");
  if (!sessionId) {
    setNoActiveSessionUI();
    return;
  }

  try {
    const session = await get("sessions", sessionId);
    if (!session) {
      localStorage.removeItem("openfloat_active_session_id");
      telemetry.currentSessionId = null;
      setNoActiveSessionUI();
      return;
    }

    telemetry.currentSessionId = sessionId;
    
    if (session.bow_profile_id) {
      localStorage.setItem("openfloat_active_bow_id", session.bow_profile_id);
      el.bowProfileSelect.value = session.bow_profile_id;
      el.sessionBowSelect.value = session.bow_profile_id;
      populateBowForm();
    }

    el.sessionLocationInput.value = session.location_label || "";
    el.startSessionBtn.disabled = true;
    el.endSessionBtn.disabled = false;

    let bowName = "Default Bow";
    if (session.bow_profile_id) {
      const bow = await get("bow_profiles", session.bow_profile_id);
      if (bow) bowName = bow.model;
    }

    el.sessionStatusText.innerHTML = `Active: <strong style="color: var(--cyan);">${session.location_label || "Practice"}</strong> (${bowName})`;
  } catch (error) {
    console.error("Error restoring active session:", error);
    setNoActiveSessionUI();
  }
}

function setNoActiveSessionUI() {
  el.startSessionBtn.disabled = false;
  el.endSessionBtn.disabled = true;
  el.sessionStatusText.textContent = "No active session (Quick Practice)";
  el.sessionStatusText.style.color = "var(--muted)";
}

// Bind Bow Profile & Session Event Listeners
el.bowProfileSelect.addEventListener("change", () => {
  const activeBowId = el.bowProfileSelect.value;
  localStorage.setItem("openfloat_active_bow_id", activeBowId);
  el.sessionBowSelect.value = activeBowId;
  populateBowForm();
});

el.sessionBowSelect.addEventListener("change", () => {
  const activeBowId = el.sessionBowSelect.value;
  localStorage.setItem("openfloat_active_bow_id", activeBowId);
  el.bowProfileSelect.value = activeBowId;
  populateBowForm();
});

el.newBowProfileBtn.addEventListener("click", () => {
  el.bowProfileSelect.value = "";
  el.sessionBowSelect.value = "";
  localStorage.setItem("openfloat_active_bow_id", "");
  populateBowForm();
  el.bowModelInput.focus();
  bus.emit("log", "Ready to define a new bow profile.");
});

el.saveBowProfileBtn.addEventListener("click", async () => {
  const modelName = el.bowModelInput.value.trim();
  if (!modelName) {
    alert("Please enter a Bow Name / Model.");
    return;
  }

  const drawWeight = parseFloat(el.drawWeightInput.value) || null;
  const stabilizerSetup = el.stabilizerSetupInput.value.trim();
  const notes = el.bowNotesInput.value.trim();

  let id = el.bowProfileSelect.value;
  const isNew = !id;
  
  if (isNew) {
    id = generateUUID();
  }

  const profile = {
    id,
    model: modelName,
    draw_weight: drawWeight,
    stabilizer_setup: stabilizerSetup,
    notes
  };

  try {
    await put("bow_profiles", profile);
    await put("sync_queue", {
      table: "bow_profiles",
      action: isNew ? "CREATE" : "UPDATE",
      targetId: id,
      payload: profile,
      status: "pending"
    });

    localStorage.setItem("openfloat_active_bow_id", id);
    bus.emit("log", `Saved bow profile: "${modelName}"`);
    await loadBowProfiles();
    
    if (syncAdapter) syncAdapter.triggerSync();
  } catch (error) {
    console.error("Error saving bow profile:", error);
    bus.emit("log", `Error saving bow profile: ${error.message}`);
  }
});

el.deleteBowProfileBtn.addEventListener("click", async () => {
  const id = el.bowProfileSelect.value;
  if (!id) return;

  const confirmDelete = confirm("Are you sure you want to delete this bow profile? This will not delete historical shots associated with it.");
  if (!confirmDelete) return;

  try {
    const profile = await get("bow_profiles", id);
    const name = profile ? profile.model : id;

    await remove("bow_profiles", id);
    await put("sync_queue", {
      table: "bow_profiles",
      action: "DELETE",
      targetId: id,
      status: "pending"
    });

    if (localStorage.getItem("openfloat_active_bow_id") === id) {
      localStorage.setItem("openfloat_active_bow_id", "");
    }

    bus.emit("log", `Deleted bow profile: "${name}"`);
    await loadBowProfiles();

    if (syncAdapter) syncAdapter.triggerSync();
  } catch (error) {
    console.error("Error deleting bow profile:", error);
    bus.emit("log", `Error deleting bow profile: ${error.message}`);
  }
});

el.startSessionBtn.addEventListener("click", async () => {
  const location = el.sessionLocationInput.value.trim() || "Practice Session";
  const bowId = el.sessionBowSelect.value || null;

  const sessionId = generateUUID();
  const sessionRecord = {
    id: sessionId,
    started_at: new Date().toISOString(),
    location_label: location,
    bow_profile_id: bowId
  };

  try {
    await put("sessions", sessionRecord);
    await put("sync_queue", {
      table: "sessions",
      action: "CREATE",
      targetId: sessionId,
      payload: sessionRecord,
      status: "pending"
    });

    localStorage.setItem("openfloat_active_session_id", sessionId);
    telemetry.currentSessionId = sessionId;

    let bowName = "Default Bow";
    if (bowId) {
      const bow = await get("bow_profiles", bowId);
      if (bow) bowName = bow.model;
    }

    el.startSessionBtn.disabled = true;
    el.endSessionBtn.disabled = false;
    el.sessionStatusText.innerHTML = `Active: <strong style="color: var(--cyan);">${location}</strong> (${bowName})`;
    
    bus.emit("log", `Started practice session: "${location}"`);

    if (syncAdapter) syncAdapter.triggerSync();
  } catch (error) {
    console.error("Error starting session:", error);
    bus.emit("log", `Error starting session: ${error.message}`);
  }
});

el.endSessionBtn.addEventListener("click", async () => {
  const sessionId = localStorage.getItem("openfloat_active_session_id");
  if (!sessionId) return;

  try {
    const session = await get("sessions", sessionId);
    if (session) {
      session.ended_at = new Date().toISOString();
      await put("sessions", session);
      await put("sync_queue", {
        table: "sessions",
        action: "UPDATE",
        targetId: sessionId,
        payload: session,
        status: "pending"
      });
    }

    localStorage.removeItem("openfloat_active_session_id");
    telemetry.currentSessionId = null;

    setNoActiveSessionUI();
    el.sessionLocationInput.value = "";
    
    bus.emit("log", `Ended practice session: "${session ? session.location_label : ''}"`);

    if (syncAdapter) syncAdapter.triggerSync();
  } catch (error) {
    console.error("Error ending session:", error);
    bus.emit("log", `Error ending session: ${error.message}`);
  }
});

async function loadShotHistoryList() {
  el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">Loading saved history...</p>`;
  try {
    const shots = await getAll("shots");
    const sessions = await getAll("sessions");
    const bows = await getAll("bow_profiles");

    if (shots.length === 0) {
      el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet.</p>`;
      return;
    }

    const sessionMap = new Map(sessions.map(s => [s.id, s]));
    const bowMap = new Map(bows.map(b => [b.id, b]));

    const grouped = {};
    for (const shot of shots) {
      const sessionId = shot.session_id || "legacy";
      if (!grouped[sessionId]) {
        grouped[sessionId] = [];
      }
      grouped[sessionId].push(shot);
    }

    const groups = [];
    for (const [sessionId, sessionShots] of Object.entries(grouped)) {
      sessionShots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      const sessionRecord = sessionMap.get(sessionId);
      const dateStr = sessionRecord 
        ? new Date(sessionRecord.started_at).toISOString() 
        : (sessionShots.length > 0 ? sessionShots[0].timestamp : new Date(0).toISOString());

      groups.push({
        id: sessionId,
        session: sessionRecord,
        shots: sessionShots,
        startedAt: dateStr
      });
    }

    groups.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    el.historyList.innerHTML = "";
    let isFirst = true;
    for (const group of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "session-group" + (isFirst ? "" : " collapsed");
      isFirst = false;

      const locationLabel = group.session ? group.session.location_label : "Quick Practice";
      const dateStr = new Date(group.startedAt).toLocaleString();
      
      let bowName = "Default Bow";
      if (group.session && group.session.bow_profile_id) {
        const bow = bowMap.get(group.session.bow_profile_id);
        if (bow) {
          bowName = bow.model + (bow.draw_weight ? ` (${bow.draw_weight} lbs)` : "");
        }
      }

      const shotCount = group.shots.length;
      let totalScore = 0;
      for (const s of group.shots) {
        totalScore += s.shot_score != null ? s.shot_score : (s.stability_score || 0);
      }
      const avgScore = shotCount > 0 ? Math.round(totalScore / shotCount) : 0;

      groupEl.innerHTML = `
        <div class="session-header">
          <div class="session-meta">
            <div class="session-title-row">
              <span class="session-arrow-icon">▼</span>
              <span class="session-location">${locationLabel}</span>
            </div>
            <div class="session-info-row">
              <span class="session-date">${dateStr}</span>
              <span class="session-divider">|</span>
              <span class="session-bow">${bowName}</span>
            </div>
          </div>
          <div class="session-stats">
            <div class="session-stat-badge">
              <span class="badge-label">Shots</span>
              <span class="badge-val">${shotCount}</span>
            </div>
            <div class="session-stat-badge">
              <span class="badge-label">Avg</span>
              <span class="badge-val">${avgScore}</span>
            </div>
          </div>
        </div>
        <div class="session-shots-container"></div>
      `;

      const headerEl = groupEl.querySelector(".session-header");
      headerEl.addEventListener("click", () => {
        groupEl.classList.toggle("collapsed");
      });

      const containerEl = groupEl.querySelector(".session-shots-container");
      for (const shot of group.shots) {
        const item = document.createElement("div");
        item.className = "history-item";

        const timestampStr = new Date(shot.timestamp).toLocaleTimeString();
        const title = shot.label || (shot.peak_g > 15 ? "Arrow Release" : "Hold Capture");
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

        item.addEventListener("click", (e) => {
          e.stopPropagation();
          reviewShotTrace(shot);
        });
        containerEl.appendChild(item);
      }

      el.historyList.appendChild(groupEl);
    }
  } catch (error) {
    console.error("Error loading shot history:", error);
    el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center; color: var(--red);">Failed to load history: ${error.message}</p>`;
  }
}

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

    const holdStability = shot.hold_stability != null ? Math.round(shot.hold_stability) : (shot.stability_score != null ? Math.round(shot.stability_score) : null);
    const releaseQuality = shot.release_quality != null ? Math.round(shot.release_quality) : null;
    const followThrough = shot.follow_through != null ? Math.round(shot.follow_through) : null;
    const roll = shot.cant_angle_deg || shot.roll_angle_deg || 0;
    
    const coaching = coachForScore({
      formScore: score,
      holdStability,
      releaseQuality,
      followThrough,
      roll
    });

    store.set({
      reviewMode: true,
      reviewTrace: trace.payload,
      reviewSampleRateHz: trace.sample_rate_hz || 52,
      reviewInfo: info,
      chartView: "target",
      replayActive: false,
      replayPaused: false,
      replayProgress: 1,
      traceZoom: 1,
      formScore: score,
      holdStability,
      releaseQuality,
      followThrough,
      coachTitle: coaching.coachTitle,
      coachText: coaching.coachText,
      lastShotSummary: {
        timestamp: shot.timestamp,
        score,
        peakG: shot.peak_g,
        cant: roll,
        pitch: shot.pitch_angle_deg || 0,
      },
    });

    bus.emit("log", `Entering review mode for shot ${shot.id.slice(0, 8)}...`);
    selectViewTab("tabDashboard");
  } catch (error) {
    console.error("Failed to load trace:", error);
    alert("Error fetching trace payload: " + error.message);
  }
}

el.exitReviewBtn.addEventListener("click", () => {
  store.set({
    reviewMode: false,
    reviewTrace: null,
    reviewSampleRateHz: 52,
    reviewInfo: "",
    replayActive: false,
    replayPaused: false,
    replayProgress: 1,
    traceZoom: 1,
    formScore: null,
    holdStability: null,
    releaseQuality: null,
    followThrough: null,
    coachTitle: null,
    coachText: null
  });
  bus.emit("log", "Exited review mode. Returned to live telemetry stream.");
});

// Load recent shots for dashboard
async function loadRecentShotsList() {
  if (!el.recentShotsList) return;
  try {
    const shots = await getAll("shots");
    if (!shots || shots.length === 0) {
      el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">No shots captured in this session yet.</p>`;
      return;
    }

    // Sort shots by timestamp descending (newest first)
    shots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Take the 5 most recent shots
    const recent = shots.slice(0, 5);

    el.recentShotsList.innerHTML = "";
    
    recent.forEach((shot, index) => {
      const item = document.createElement("div");
      item.className = "recent-shot-card";
      
      const timeStr = new Date(shot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
      const title = shot.label || `Shot #${shots.length - index}`;

      item.innerHTML = `
        <div class="recent-shot-header">
          <span class="recent-shot-title">${title}</span>
          <span class="recent-shot-time">${timeStr}</span>
        </div>
        <div class="recent-shot-metrics">
          <div class="recent-shot-metric">
            <span class="metric-label">Score</span>
            <strong class="metric-val score">${score}</strong>
          </div>
          <div class="recent-shot-metric">
            <span class="metric-label">Stability</span>
            <strong class="metric-val">${Math.round(shot.stability_score)}%</strong>
          </div>
          <div class="recent-shot-metric">
            <span class="metric-label">Peak G</span>
            <strong class="metric-val">${shot.peak_g.toFixed(1)}g</strong>
          </div>
        </div>
      `;

      item.addEventListener("click", () => {
        reviewShotTrace(shot);
      });
      el.recentShotsList.appendChild(item);
    });
  } catch (error) {
    console.error("Error loading recent shots:", error);
    el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">Failed to load recent shots.</p>`;
  }
}

// Update recent shots on shot-saved event
bus.on("shot-saved", () => {
  loadRecentShotsList();
});

// Register Service Worker for offline-first support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((reg) => {
        bus.emit("log", "Offline service worker registered successfully.");
      })
      .catch((err) => {
        console.error("Service worker registration failed:", err);
      });
  });
}

bus.emit("log", `Ready (${APP_BUILD}). Pick a transport and connect, or run the demo stream.`);
