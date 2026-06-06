// App entry point: build the shared bus + store, wire telemetry and UI, and
// own the transport lifecycle (connect / disconnect).

import { createStore, EventBus } from "./core/store.js";
import { TelemetryStore, coachForScore } from "./telemetry/telemetry.js?v=shot-store-103";
import { createAdapter } from "./device/adapters.js?v=shot-store-98";
import {
  cloneMountAxes,
  mountBowShop,
  mountDashboard,
  mountLog,
  mountOrientationById,
  mountOrientationSettings,
  mountOrientationState,
  rotateMountAxes,
} from "./ui/dashboard.js?v=shot-store-102";
import {
  drawEmptyTargetPreview,
  drawTraceTargetPreview,
  watchTracePreviewResize,
} from "./ui/trace-preview.js?v=shot-store-98";
import { resolveReviewMicSeries } from "./protocol/trace.js?v=shot-store-102";
import { initDb, getAll, get, put, remove, generateUUID, groupShotsByTime, SESSION_GAP_MS, exportAllData, importAllData } from "./core/db.js?v=shot-store-98";
import { CloudSyncAdapter } from "./telemetry/sync.js?v=shot-store-104";
import { mountTraining } from "./ui/training.js?v=shot-store-99";

const APP_BUILD = "shot-store-104";
const MODEL_ATTITUDE_VERSION = 3;

const ELEMENT_IDS = [
  "statusBadge", "statusText",
  "protocolValue", "typeValue", "sourceValue", "seqValue", "lossValue",
  "dtValue", "hzValue", "frameCountValue", "micVolumeItem", "volBar",
  "shotCountValue", "uploadStatusItem", "uploadCountValue", "eventLog", "traceCanvas",
  "orientationCanvas", "orientationRollValue", "orientationPitchValue", "orientationYawValue",
  "syncBadge", "syncText", "cloudModal", "closeCloudModalBtn",
  "sbUrlInput", "sbKeyInput", "saveCloudSettingsBtn", "clearCloudSettingsBtn",
  "chartTitle", "reviewBanner", "reviewInfo", "reviewCompareSelect",
  "reviewCompareField", "reviewCompareLegend", "exitReviewBtn",
  "navDashboardBtn", "navTrainingBtn", "navHistoryBtn", "navBowShopBtn", "navSettingsBtn",
  "tabDashboard", "tabTraining", "tabHistory", "tabBowShop", "tabSettings", "historyList",
  "trainingDurationSelect", "startTrainingBtn", "cancelTrainingBtn",
  "trainingStatusText", "trainingStatusDesc", "trainingDisplayDefault", "trainingDisplayActive",
  "timerProgress", "trainingCountdownVal", "trainingPhaseLabel", "trainingTargetWrapper",
  "trainingTargetCanvas", "trainingCantBadge", "trainingHoldTimerBadge", "trainingResultsCard",
  "resultSteadinessScore", "resultAvgCantDev", "resultAvgPitchDev", "resultMaxFloat",
  "resultCoachingTitle", "resultCoachingText", "saveTrainingShotBtn", "discardTrainingShotBtn",
  "recordToggleBtn", "recordToggleLabel", "recordStatusItem",
  "recordTimeText", "recordSamplesText", "discardRecordBtn",
  "thresholdSlider", "thresholdValue",
  "wakeSlider", "wakeValue",
  "sleepTimeoutSlider", "sleepTimeoutValue",
  "sleepSensSlider", "sleepSensValue", "sleepEnableToggle",
  "viewTraceBtn", "viewTargetBtn",
  "formScoreValue", "coachTitle", "coachText", "holdStabilityValue",
  "releaseQualityValue", "followThroughValue", "cantValue",
  "levelCard", "levelBubble", "levelAlertText",
  "reviewScrubBar", "replayTraceBtn", "speedDownBtn", "speedUpBtn",
  "speedValue", "traceScrubSlider", "traceScrubValue", "tracePhaseRail",
  "zeroBtn", "zeroYawBtn", "batteryBadge", "batteryText",
  "mountOrientationSelect", "mountOrientationCanvas", "mountOrientationDescription",
  "mountViewRollSlider", "mountViewRollValue",
  "mountPositionXSlider", "mountPositionYSlider", "mountPositionZSlider",
  "mountPositionXValue", "mountPositionYValue", "mountPositionZValue",
  "mountAxisXValue", "mountAxisYValue", "mountAxisZValue", "mountFirmwareNote",
  "mountRotateXBtn", "mountRotateYBtn", "mountRotateZBtn", "mountResetBtn",
  "modelRotateXBtn", "modelRotateYBtn", "modelRotateZBtn", "modelResetBtn",
  "modelInvertRollToggle", "modelInvertPitchToggle", "modelSwapRollPitchToggle", "modelIgnoreYawToggle",
  "modelAxisXValue", "modelAxisYValue", "modelAxisZValue",
  "bowShopCanvas", "bowMaterialColorList",
  "bufferRateSlider", "bufferRateValue", "bufferNVSToggle",
  "followThroughSlider", "followThroughValueMs",
  "streamRateSlider", "streamRateValue",
  "mobileAlertBanner", "mobileAlertText", "closeMobileAlertBtn",
  "bowProfileSelect", "bowModelInput", "drawWeightInput", "stabilizerSetupInput", "bowNotesInput",
  "saveBowProfileBtn", "deleteBowProfileBtn", "newBowProfileBtn",
  "recentShotsPanel", "recentShotsList",
  "exportDataBtn", "importDataBtn", "importDataInput", "dataBackupStatus",
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
const cachedBowRiserColor = /^#[0-9a-f]{6}$/i.test(String(cached.bowRiserColor || ""))
  ? String(cached.bowRiserColor)
  : "#c7d5d0";
const cachedBowHandleColor = /^#[0-9a-f]{6}$/i.test(String(cached.bowHandleColor || ""))
  ? String(cached.bowHandleColor)
  : "#1a1a1a";
const cachedBowMaterialColors = cached.bowMaterialColors && typeof cached.bowMaterialColors === "object"
  ? Object.fromEntries(
      Object.entries(cached.bowMaterialColors)
        .filter(([, value]) => /^#[0-9a-f]{6}$/i.test(String(value || "")))
        .map(([key, value]) => [String(key), String(value)]),
    )
  : {};
if (!cachedBowMaterialColors.riser && cached.bowRiserColor) {
  cachedBowMaterialColors.riser = cachedBowRiserColor;
}
if (!cachedBowMaterialColors.grip && cached.bowHandleColor) {
  cachedBowMaterialColors.grip = cachedBowHandleColor;
}
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
  uploadPending: 0,
  wakeSensitivity: 2.0,
  threshold: cached.threshold !== undefined ? Number(cached.threshold) : 12.0,
  sample: null,
  syncStatus: "local",
  syncText: "Local-Only",
  syncQueueCount: 0,
  cloudUser: null,
  reviewMode: false,
  reviewShotId: null,
  reviewTrace: null,
  reviewMicSeries: null,
  reviewSampleRateHz: 52,
  reviewThresholdG: 12,
  reviewInfo: "",
  compareShotId: null,
  compareTrace: null,
  compareShotLabel: "",
  compareThresholdG: 12,
  chartView: "target",
  formScore: null,
  holdStability: null,
  releaseQuality: null,
  followThrough: null,
  levelConsistency: null,
  scoreVersion: null,
  coachTitle: "Waiting for movement",
  coachText: "Connect a sensor to start reading hold stability.",
  roll: 0,
  pitch: 0,
  yaw: 0,
  lastShotSummary: null,
  traceZoom: 1,
  replaySpeed: 1,
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
  bowMaterialColors: cachedBowMaterialColors,
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
      transport: "ble",
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
      modelIgnoreYaw: store.get().modelIgnoreYaw,
      bowMaterialColors: store.get().bowMaterialColors
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
  await loadRecentShotsList();
}).catch((err) => {
  bus.emit("log", `Database initialization failed: ${err.message}`);
});

const telemetry = new TelemetryStore(bus, store);
const syncAdapter = new CloudSyncAdapter(bus, store);
telemetry.syncAdapter = syncAdapter; // Register sync on telemetry store

mountDashboard({ store, telemetry, el });
mountTraining({ store, telemetry, el, bus });
mountLog(bus, el.eventLog);
mountOrientationSettings({ store, el });
mountBowShop({ store, el, saveSettingsToCache });

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

    if (el.reviewCompareLegend) {
      const hasCompare = !!(state.reviewMode && state.compareTrace && state.compareTrace.length);
      el.reviewCompareLegend.classList.toggle("hidden", !hasCompare);
      if (hasCompare) {
        const compareLabel = state.compareShotLabel || "Compare";
        const compareSpan = el.reviewCompareLegend.querySelector(".legend-compare");
        if (compareSpan) compareSpan.textContent = compareLabel;
      }
    }
    if (el.reviewCompareSelect) {
      el.reviewCompareSelect.disabled = !state.reviewMode;
    }

    if (el.reviewScrubBar && el.replayTraceBtn && el.speedValue) {
      const pinReviewActive = state.reviewMode && state.chartView === "target";
      el.reviewScrubBar.classList.toggle("hidden", !pinReviewActive);
    const playing = state.replayActive && !state.replayPaused;
    el.replayTraceBtn.classList.toggle("playing", playing);
    el.replayTraceBtn.title = playing ? "Pause replay" : "Play replay";
    el.replayTraceBtn.disabled = !pinReviewActive;
    el.speedValue.textContent = `${formatSpeed(state.replaySpeed || 1)}×`;
    if (el.traceCanvas) {
      // Disable native gestures only while zoom-by-gesture is active.
      el.traceCanvas.style.touchAction = pinReviewActive ? "none" : "";
    }
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


  if (el.recordToggleBtn) {
    const connected = state.connected;
    const active = state.manualRecordingActive;

    el.recordToggleBtn.disabled = !connected;
    el.recordToggleBtn.classList.toggle("recording", active);
    if (el.recordToggleLabel) {
      el.recordToggleLabel.textContent = active ? "Stop" : "Record";
    }
    el.recordToggleBtn.title = !connected
      ? "Connect a sensor to record a manual trace"
      : active
        ? "Stop and save the recording"
        : "Record a manual trace";
  }

  if (el.discardRecordBtn) {
    el.discardRecordBtn.classList.toggle("hidden", !state.manualRecordingActive);
  }

  if (el.recordStatusItem) {
    el.recordStatusItem.classList.toggle("hidden", !state.manualRecordingActive);
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
  // Only Bluetooth (BLE) transport is supported.
  return "ble";
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
    try {
      await adapter?.disconnect?.();
    } catch (_) {}
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

el.statusBadge.addEventListener("click", async () => {
  if (store.get().connected) {
    await disconnect();
  } else {
    await connect();
  }
});
el.recordToggleBtn.addEventListener("click", async () => {
  if (store.get().manualRecordingActive) {
    // Currently recording -> stop and save. Stay on the dashboard.
    await telemetry.saveManualRecording();
  } else {
    // Not recording -> start with a timestamped default label.
    const label = `Manual Capture ${new Date().toLocaleTimeString()}`;
    telemetry.startManualRecording(label);
  }
});
el.discardRecordBtn.addEventListener("click", () => {
  if (confirm("Are you sure you want to discard this manual recording?")) {
    telemetry.discardManualRecording();
  }
});
el.zeroBtn.addEventListener("click", () => {
  if (!adapter) return;

  const roll = store.get().roll || 0;
  const pitch = store.get().pitch || 0;
  const yaw = store.get().yaw || 0;
  const confirmed = confirm(
    "Run zero calibration?\n\n" +
      "This sets the bow level reference from the sensor's current cant and pitch. " +
      "Only do this when the bow is level and still.\n\n" +
      `Current reading: Cant ${roll.toFixed(1)}°, Pitch ${pitch.toFixed(1)}°, Yaw ${yaw.toFixed(1)}°\n\n` +
      "Your previous calibration will be replaced.",
  );
  if (!confirmed) return;

  adapter.sendControl("zero");
  store.set({
    cantOffset: roll,
    pitchOffset: pitch,
  });
  bus.emit(
    "log",
    `Zero calibration requested. Bow level set at Cant: ${roll.toFixed(1)} deg, Pitch: ${pitch.toFixed(1)} deg, Yaw: ${yaw.toFixed(1)} deg`,
  );
  saveSettingsToCache();
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
  const tabs = ["tabDashboard", "tabTraining", "tabHistory", "tabBowShop", "tabSettings"];
  const navButtons = {
    tabDashboard: el.navDashboardBtn,
    tabTraining: el.navTrainingBtn,
    tabHistory: el.navHistoryBtn,
    tabBowShop: el.navBowShopBtn,
    tabSettings: el.navSettingsBtn,
  };
  const panels = {
    tabDashboard: el.tabDashboard,
    tabTraining: el.tabTraining,
    tabHistory: el.tabHistory,
    tabBowShop: el.tabBowShop,
    tabSettings: el.tabSettings,
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
    withPreservedScroll(() => loadRecentShotsList());
  }
}

if (el.navDashboardBtn && el.navTrainingBtn && el.navHistoryBtn && el.navBowShopBtn && el.navSettingsBtn) {
  el.navDashboardBtn.addEventListener("click", () => selectViewTab("tabDashboard"));
  el.navTrainingBtn.addEventListener("click", () => selectViewTab("tabTraining"));
  el.navHistoryBtn.addEventListener("click", () => selectViewTab("tabHistory"));
  el.navBowShopBtn.addEventListener("click", () => selectViewTab("tabBowShop"));
  el.navSettingsBtn.addEventListener("click", () => selectViewTab("tabSettings"));
}

// --- Local data backup / restore -----------------------------------------
function setDataBackupStatus(message, isError = false) {
  if (!el.dataBackupStatus) return;
  el.dataBackupStatus.textContent = message;
  el.dataBackupStatus.style.color = isError ? "var(--red)" : "var(--muted)";
}

// Accepts a per-store count map ({ shots: 12, ... }).
function summarizeCounts(counts) {
  const shots = counts.shots || 0;
  const traces = counts.shot_traces || 0;
  const profiles = counts.bow_profiles || 0;
  return `${shots} shot${shots === 1 ? "" : "s"}, ${traces} trace${traces === 1 ? "" : "s"}, ${profiles} bow profile${profiles === 1 ? "" : "s"}`;
}

async function handleExportData() {
  try {
    setDataBackupStatus("Preparing export...");
    const payload = await exportAllData();
    const exportCounts = Object.fromEntries(
      Object.entries(payload.stores).map(([name, rows]) => [name, rows.length]),
    );
    const summary = summarizeCounts(exportCounts);
    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `openfloat-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setDataBackupStatus(`Exported ${summary}.`);
    bus.emit("log", `Data export: ${summary}.`);
  } catch (error) {
    setDataBackupStatus(`Export failed: ${error.message}`, true);
    bus.emit("log", `Data export failed: ${error.message}`);
  }
}

async function handleImportFile(file) {
  try {
    setDataBackupStatus("Reading file...");
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error("file is not valid JSON.");
    }
    const counts = await importAllData(payload, { merge: true });
    const summary = summarizeCounts(counts);
    setDataBackupStatus(`Imported ${summary}.`);
    bus.emit("log", `Data import: ${summary}.`);
    // Refresh the views that read straight from IndexedDB.
    await loadBowProfiles();
    await loadShotHistoryList();
    await loadRecentShotsList();
  } catch (error) {
    setDataBackupStatus(`Import failed: ${error.message}`, true);
    bus.emit("log", `Data import failed: ${error.message}`);
  }
}

if (el.exportDataBtn) el.exportDataBtn.addEventListener("click", handleExportData);
if (el.importDataBtn && el.importDataInput) {
  el.importDataBtn.addEventListener("click", () => el.importDataInput.click());
  el.importDataInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ""; // allow re-importing the same file
    if (file) handleImportFile(file);
  });
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

  // Progress accumulates per-frame scaled by the current replay speed, so the
  // speed control takes effect live (mid-replay) without restarting playback.
  const BASE_DURATION_MS = 1800;
  let lastTs = performance.now();
  const startProgress = state.replayProgress >= 1 ? 0 : (state.replayProgress || 0);
  store.set({ replayActive: true, replayPaused: false, replayProgress: startProgress });

  function tick(now) {
    const current = store.get();
    if (!current.reviewMode || current.chartView !== "target") return;
    if (current.replayPaused) return;
    const dt = now - lastTs;
    lastTs = now;
    const speed = current.replaySpeed || 1;
    const progress = Math.min(
      1,
      (current.replayProgress || 0) + (dt / BASE_DURATION_MS) * speed,
    );
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

// Replay speed control (replaces the old zoom multiplier; zoom is now a gesture)
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];
function formatSpeed(s) {
  return String(s);
}
function stepReplaySpeed(dir) {
  const cur = store.get().replaySpeed || 1;
  let idx = REPLAY_SPEEDS.indexOf(cur);
  if (idx === -1) idx = REPLAY_SPEEDS.indexOf(1);
  idx = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, idx + dir));
  store.set({ replaySpeed: REPLAY_SPEEDS[idx] });
}
el.speedDownBtn.addEventListener("click", () => stepReplaySpeed(-1));
el.speedUpBtn.addEventListener("click", () => stepReplaySpeed(1));

// Trace zoom via scroll wheel (desktop) and pinch (mobile) on the target.
const TRACE_ZOOM_MIN = 0.5;
const TRACE_ZOOM_MAX = 6;
function clampZoom(z) {
  return Math.max(TRACE_ZOOM_MIN, Math.min(TRACE_ZOOM_MAX, Number(z.toFixed(3))));
}
function zoomActive() {
  const s = store.get();
  return s.reviewMode && s.chartView === "target";
}
function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}
if (el.traceCanvas) {
  el.traceCanvas.addEventListener(
    "wheel",
    (e) => {
      if (!zoomActive()) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      store.set({ traceZoom: clampZoom((store.get().traceZoom || 1) * factor) });
    },
    { passive: false },
  );

  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  el.traceCanvas.addEventListener(
    "touchstart",
    (e) => {
      if (!zoomActive() || e.touches.length !== 2) return;
      pinchStartDist = touchDistance(e.touches);
      pinchStartZoom = store.get().traceZoom || 1;
    },
    { passive: true },
  );
  el.traceCanvas.addEventListener(
    "touchmove",
    (e) => {
      if (!zoomActive() || e.touches.length !== 2 || pinchStartDist <= 0) return;
      e.preventDefault();
      const ratio = touchDistance(e.touches) / pinchStartDist;
      store.set({ traceZoom: clampZoom(pinchStartZoom * ratio) });
    },
    { passive: false },
  );
  el.traceCanvas.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinchStartDist = 0;
  });
}

// Bow Profile & Session Management Functions
async function loadBowProfiles() {
  try {
    const profiles = await getAll("bow_profiles");
    
    // Clear and reset dynamic options
    el.bowProfileSelect.innerHTML = '<option value="">Default Bow</option>';

    profiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.model + (profile.draw_weight ? ` (${profile.draw_weight} lbs)` : "");

      el.bowProfileSelect.appendChild(option);
    });

    // Restore selected active bow
    const activeBowId = localStorage.getItem("openfloat_active_bow_id") || "";
    el.bowProfileSelect.value = activeBowId;

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

// Bind Bow Profile Event Listeners
el.bowProfileSelect.addEventListener("change", () => {
  const activeBowId = el.bowProfileSelect.value;
  localStorage.setItem("openfloat_active_bow_id", activeBowId);
  populateBowForm();
});

el.newBowProfileBtn.addEventListener("click", () => {
  el.bowProfileSelect.value = "";
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

// Escape user-entered text before injecting into innerHTML.
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function defaultSessionName(startTime) {
  const d = new Date(startTime);
  const hour = d.getHours();
  const partOfDay =
    hour < 5 ? "Night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  return `${partOfDay} Practice`;
}

function bowDisplayName(bow) {
  if (!bow) return "Default Bow";
  return bow.model + (bow.draw_weight ? ` (${bow.draw_weight} lbs)` : "");
}

function shotFloatScore(shot) {
  const value = shot?.shot_score != null ? Number(shot.shot_score) : Number(shot?.stability_score || 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function shotHistoryLabel(shot, fallbackIndex = 0) {
  if (shot?.label) return shot.label;
  if (Number(shot?.peak_g || 0) > 15) return "Arrow Release";
  return fallbackIndex > 0 ? `Shot ${fallbackIndex}` : "Hold Capture";
}

function sessionAverage(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return 0;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function sessionStdDev(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 2) return 0;
  const avg = sessionAverage(usable);
  return Math.sqrt(sessionAverage(usable.map((value) => (value - avg) ** 2)));
}

function drillNameForShot(shot) {
  const label = shot?.label || "";
  if (/steady aim/i.test(label)) return "Steady Aim";
  if (/manual recording/i.test(label)) return "Manual Recording";
  if (/manual/i.test(label)) return "Manual Capture";
  if (label) return label.replace(/\s*\([^)]*\)\s*$/, "");
  return Number(shot?.peak_g || 0) > 15 ? "Arrow Release" : "Hold Capture";
}

function sessionTrendSummary(scores) {
  if (scores.length < 2) {
    return {
      label: "Need more shots",
      detail: "One scored shot",
    };
  }

  const first = scores[0];
  const latest = scores[scores.length - 1];
  const change = Math.round(latest - first);
  const spread = Math.round(Math.max(...scores) - Math.min(...scores));
  const std = sessionStdDev(scores);
  let label = "Variable";
  if (change >= 5) label = "Improving";
  else if (change <= -5) label = "Fading";
  else if (std <= 5) label = "Tight";
  else if (std <= 10) label = "Steady";

  return {
    label,
    detail: `${change > 0 ? "+" : ""}${change} pts, ${spread} spread`,
  };
}

function recurringIssueSummary(shots) {
  const components = [
    { key: "hold_stability", label: "Hold steadiness", detail: "Float is moving before release." },
    { key: "release_quality", label: "Release disturbance", detail: "Motion spikes at the break." },
    { key: "follow_through", label: "Follow-through control", detail: "The bow moves after release." },
    { key: "level_consistency", label: "Bow cant consistency", detail: "Cant varies through the hold." },
  ];

  const ranked = components
    .map((component) => {
      const values = shots
        .map((shot) => Number(shot[component.key]))
        .filter((value) => Number.isFinite(value));
      return {
        ...component,
        count: values.length,
        avg: values.length ? sessionAverage(values) : Infinity,
      };
    })
    .filter((component) => component.count > 0)
    .sort((a, b) => a.avg - b.avg);

  if (!ranked.length) {
    return {
      label: "Need more data",
      detail: "Future scored shots will reveal a pattern.",
      value: "--",
    };
  }

  const issue = ranked[0];
  return {
    label: issue.label,
    detail: issue.detail,
    value: `${Math.round(issue.avg)} avg`,
  };
}

function buildSessionReview(shots) {
  const chronological = [...shots].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
  const scores = chronological.map(shotFloatScore);
  if (!scores.length) return "";

  const avg = Math.round(sessionAverage(scores));
  const best = chronological.reduce((winner, shot) =>
    shotFloatScore(shot) > shotFloatScore(winner) ? shot : winner,
  chronological[0]);
  const worst = chronological.reduce((lowest, shot) =>
    shotFloatScore(shot) < shotFloatScore(lowest) ? shot : lowest,
  chronological[0]);
  const trend = sessionTrendSummary(scores);
  const issue = recurringIssueSummary(chronological);

  const drillCounts = new Map();
  for (const shot of chronological) {
    const name = drillNameForShot(shot);
    drillCounts.set(name, (drillCounts.get(name) || 0) + 1);
  }
  const drills = [...drillCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `<span>${escapeHtml(name)} <strong>${count}</strong></span>`)
    .join("");

  return `
    <div class="session-review" aria-label="Session review summary">
      <div class="session-review-head">
        <span>Session Review</span>
        <strong>${avg}</strong>
      </div>
      <div class="session-review-grid">
        <div class="session-review-stat">
          <span>Average</span>
          <strong>${avg}</strong>
          <small>Float Score</small>
        </div>
        <button class="session-review-stat as-button" type="button" data-review-shot-id="${escapeHtml(best.id)}">
          <span>Best Shot</span>
          <strong>${Math.round(shotFloatScore(best))}</strong>
          <small>${escapeHtml(shotHistoryLabel(best))}</small>
        </button>
        <button class="session-review-stat as-button" type="button" data-review-shot-id="${escapeHtml(worst.id)}">
          <span>Needs Work</span>
          <strong>${Math.round(shotFloatScore(worst))}</strong>
          <small>${escapeHtml(shotHistoryLabel(worst))}</small>
        </button>
        <div class="session-review-stat">
          <span>Consistency</span>
          <strong>${escapeHtml(trend.label)}</strong>
          <small>${escapeHtml(trend.detail)}</small>
        </div>
        <div class="session-review-stat issue">
          <span>Recurring Issue</span>
          <strong>${escapeHtml(issue.label)}</strong>
          <small>${escapeHtml(issue.value)} - ${escapeHtml(issue.detail)}</small>
        </div>
      </div>
      <div class="session-review-drills">
        <span class="session-review-drills-label">Shots by drill</span>
        <div>${drills}</div>
      </div>
    </div>
  `;
}

function buildSessionFloatPlot(shots) {
  const chronological = [...shots].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
  const scores = chronological.map(shotFloatScore);
  const count = scores.length;
  if (!count) {
    return "";
  }

  const latest = Math.round(scores[count - 1]);
  const best = Math.round(Math.max(...scores));
  const low = Math.round(Math.min(...scores));
  const trend = count > 1 ? Math.round(scores[count - 1] - scores[0]) : 0;
  const trendText =
    count > 1
      ? `${trend > 0 ? "+" : ""}${trend} from first`
      : "First shot in session";

  const width = 320;
  const height = 96;
  const padX = 18;
  const padTop = 14;
  const padBottom = 20;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;
  const pointFor = (score, index) => {
    const x = count === 1 ? width / 2 : padX + (plotW * index) / (count - 1);
    const y = padTop + (1 - score / 100) * plotH;
    return { x, y };
  };
  const points = scores.map(pointFor);
  const path = points
    .map((pt, index) => `${index === 0 ? "M" : "L"} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    count > 1
      ? `${path} L ${points[count - 1].x.toFixed(1)} ${height - padBottom} L ${points[0].x.toFixed(1)} ${height - padBottom} Z`
      : "";

  const dots = points
    .map((pt, index) => {
      const score = Math.round(scores[index]);
      const label = chronological[index].label || `Shot ${index + 1}`;
      return `
        <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${index === count - 1 ? 4.2 : 3.2}" class="session-float-dot${score === best ? " best" : ""}">
          <title>${escapeHtml(label)}: ${score}</title>
        </circle>
      `;
    })
    .join("");

  return `
    <div class="session-float-plot" aria-label="Session Float Score trend">
      <div class="session-float-plot-head">
        <span>Float Score Trend</span>
        <strong>${latest}</strong>
      </div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Float scores from ${count} session shots. Latest ${latest}, best ${best}, low ${low}.">
        <line x1="${padX}" y1="${padTop}" x2="${width - padX}" y2="${padTop}" class="session-float-grid"></line>
        <line x1="${padX}" y1="${padTop + plotH / 2}" x2="${width - padX}" y2="${padTop + plotH / 2}" class="session-float-grid"></line>
        <line x1="${padX}" y1="${height - padBottom}" x2="${width - padX}" y2="${height - padBottom}" class="session-float-grid baseline"></line>
        ${areaPath ? `<path d="${areaPath}" class="session-float-area"></path>` : ""}
        <path d="${path}" class="session-float-line"></path>
        ${dots}
      </svg>
      <div class="session-float-plot-foot">
        <span>Low ${low}</span>
        <span>Best ${best}</span>
        <span>${trendText}</span>
      </div>
    </div>
  `;
}

async function loadShotHistoryList() {
  el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">Loading saved history...</p>`;
  try {
    const shots = await getAll("shots");
    const bows = await getAll("bow_profiles");
    const overrides = await getAll("session_overrides");

    if (shots.length === 0) {
      el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet. Shots taken within ${Math.round(SESSION_GAP_MS / 60000)} minutes of each other are grouped into a session automatically.</p>`;
      return;
    }

    const bowMap = new Map(bows.map(b => [b.id, b]));
    const overrideMap = new Map(overrides.map(o => [o.id, o]));

    // Group shots purely by their timestamps (newest session first).
    const groups = groupShotsByTime(shots);

    el.historyList.innerHTML = "";
    const historyPreviewJobs = [];
    let isFirst = true;
    for (const group of groups) {
      const override = overrideMap.get(group.anchorId) || null;
      const groupEl = document.createElement("div");
      groupEl.className = "session-group" + (isFirst ? "" : " collapsed");
      isFirst = false;

      const sessionName = (override && override.name) || defaultSessionName(group.startTime);
      const dateStr = new Date(group.startTime).toLocaleString();

      const bow = override && override.bow_profile_id ? bowMap.get(override.bow_profile_id) : null;
      const bowName = bowDisplayName(bow);

      const shotCount = group.shots.length;
      let totalScore = 0;
      for (const s of group.shots) {
        totalScore += s.shot_score != null ? s.shot_score : (s.stability_score || 0);
      }
      const avgScore = shotCount > 0 ? Math.round(totalScore / shotCount) : 0;

      const bowOptions = ['<option value="">Default Bow</option>']
        .concat(bows.map(b => {
          const sel = override && override.bow_profile_id === b.id ? " selected" : "";
          return `<option value="${escapeHtml(b.id)}"${sel}>${escapeHtml(bowDisplayName(b))}</option>`;
        }))
        .join("");

      groupEl.innerHTML = `
        <div class="session-header">
          <div class="session-meta">
            <div class="session-title-row">
              <span class="session-arrow-icon">▼</span>
              <span class="session-location">${escapeHtml(sessionName)}</span>
              <button class="session-edit-btn" type="button" title="Edit session name and bow">✎</button>
            </div>
            <div class="session-info-row">
              <span class="session-date">${dateStr}</span>
              <span class="session-divider">|</span>
              <span class="session-bow">${escapeHtml(bowName)}</span>
            </div>
          </div>
          <div class="session-stats">
            <div class="session-stat-badge">
              <span class="badge-label">Shots</span>
              <span class="badge-val">${shotCount}</span>
            </div>
            <div class="session-stat-badge">
              <span class="badge-label">Avg Float</span>
              <span class="badge-val">${avgScore}</span>
            </div>
          </div>
        </div>
        <div class="session-editor hidden">
          <div class="field">
            <label>Session Name</label>
            <input type="text" class="session-name-input" value="${escapeHtml(sessionName)}" placeholder="e.g. Morning 70m Practice">
          </div>
          <div class="field">
            <label>Bow Used</label>
            <select class="session-bow-input">${bowOptions}</select>
          </div>
          <div class="session-editor-actions">
            <button class="primary session-save-btn" type="button">Save</button>
            <button class="session-cancel-btn" type="button">Cancel</button>
          </div>
        </div>
        ${buildSessionReview(group.shots)}
        ${buildSessionFloatPlot(group.shots)}
        <div class="session-shots-container"></div>
      `;

      const headerEl = groupEl.querySelector(".session-header");
      const editorEl = groupEl.querySelector(".session-editor");
      headerEl.addEventListener("click", () => {
        groupEl.classList.toggle("collapsed");
      });

      // Edit button: open the inline editor without toggling collapse.
      groupEl.querySelector(".session-edit-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        editorEl.classList.toggle("hidden");
      });
      groupEl.querySelector(".session-cancel-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        editorEl.classList.add("hidden");
      });
      groupEl.querySelector(".session-save-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        const nameVal = groupEl.querySelector(".session-name-input").value.trim();
        const bowVal = groupEl.querySelector(".session-bow-input").value || null;
        const record = {
          id: group.anchorId,
          name: nameVal || null,
          bow_profile_id: bowVal,
          updated_at: new Date().toISOString(),
        };
        try {
          await put("session_overrides", record);
          bus.emit("log", `Updated session "${nameVal || defaultSessionName(group.startTime)}".`);
          await loadShotHistoryList();
        } catch (err) {
          console.error("Error saving session override:", err);
          bus.emit("log", `Error saving session: ${err.message}`);
        }
      });
      groupEl.querySelectorAll("[data-review-shot-id]").forEach((button) => {
        button.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const shotId = button.dataset.reviewShotId;
          const shot = group.shots.find((candidate) => candidate.id === shotId);
          if (shot) reviewShotTrace(shot);
        });
      });

      const containerEl = groupEl.querySelector(".session-shots-container");
      for (const shot of group.shots) {
        const item = buildHistoryItemElement(shot);
        item.addEventListener("click", (e) => {
          if (e.target.closest(".history-item-delete-btn")) return;
          e.stopPropagation();
          reviewShotTrace(shot);
        });
        const deleteBtn = item.querySelector(".history-item-delete-btn");
        deleteBtn?.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          deleteSavedShot(shot.id);
        });
        containerEl.appendChild(item);
        historyPreviewJobs.push({ item, shot });
      }

      el.historyList.appendChild(groupEl);
    }

    await paintHistoryShotPreviews(historyPreviewJobs);
  } catch (error) {
    console.error("Error loading shot history:", error);
    el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center; color: var(--red);">Failed to load history: ${error.message}</p>`;
  }
}

function formatShotCompareLabel(shot) {
  const timeStr = new Date(shot.timestamp).toLocaleString();
  const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
  const label = shot.label || (shot.peak_g > 15 ? "Arrow" : "Hold");
  return `${label} - ${timeStr} (Float Score: ${score})`;
}

async function refreshReviewCompareOptions(currentShotId, preserveSelection = true) {
  if (!el.reviewCompareSelect) return;

  const previous = preserveSelection ? el.reviewCompareSelect.value : "";
  const shots = await getAll("shots");
  const candidates = [];

  for (const candidate of shots) {
    if (candidate.id === currentShotId) continue;
    const trace = await get("shot_traces", candidate.id);
    if (trace && trace.payload && trace.payload.length >= 2) {
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  el.reviewCompareSelect.innerHTML =
    '<option value="">None</option>' +
    candidates
      .map((s) => `<option value="${s.id}">${escapeHtml(formatShotCompareLabel(s))}</option>`)
      .join("");

  if (previous && [...el.reviewCompareSelect.options].some((opt) => opt.value === previous)) {
    el.reviewCompareSelect.value = previous;
  } else {
    el.reviewCompareSelect.value = "";
  }
}

async function loadReviewCompareShot(shotId) {
  if (!shotId) {
    store.set({
      compareShotId: null,
      compareTrace: null,
      compareShotLabel: "",
      compareThresholdG: 12,
    });
    return;
  }

  try {
    const shot = await get("shots", shotId);
    const trace = await get("shot_traces", shotId);
    if (!shot || !trace || !trace.payload || trace.payload.length < 2) {
      store.set({
        compareShotId: null,
        compareTrace: null,
        compareShotLabel: "",
        compareThresholdG: 12,
      });
      if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
      bus.emit("log", "Compare shot has no saved trace.");
      return;
    }

    const label = shot.label || formatShotCompareLabel(shot);
    store.set({
      compareShotId: shotId,
      compareTrace: trace.payload,
      compareShotLabel: label,
      compareThresholdG: shot.threshold_g != null ? Number(shot.threshold_g) : 12,
    });
    bus.emit("log", `Comparing with shot ${shotId.slice(0, 8)}…`);
  } catch (error) {
    console.error("Failed to load compare shot:", error);
    bus.emit("log", `Compare load failed: ${error.message}`);
  }
}

async function reviewShotTrace(shot) {
  try {
    let trace = await get("shot_traces", shot.id);

    // For shots taken while connected, the device does not store a trace — the
    // browser captures it and only persists it after the follow-through window
    // (~1.5 s + buffer). The shot is clickable immediately, so a just-taken
    // shot's trace may still be in flight. Poll briefly before giving up.
    if (!trace || !trace.payload) {
      const ageMs = Date.now() - new Date(shot.timestamp).getTime();
      if (ageMs < 4000) {
        bus.emit("log", "Trace still being captured (follow-through); waiting…");
        const deadline = Date.now() + 4000;
        while ((!trace || !trace.payload) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          trace = await get("shot_traces", shot.id);
        }
      }
    }

    if (!trace || !trace.payload) {
      alert(
        "No saved trace for this shot yet.\n\n" +
          "Live shots capture their trace shortly after the follow-through " +
          "window — try again in a moment. If a trace never appears, check that " +
          "“Trace Buffer Rate” in Settings isn’t set to Off.",
      );
      return;
    }

    const timeStr = new Date(shot.timestamp).toLocaleTimeString();
    const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
    const info = `Float Score: ${score} | Peak Force: ${shot.peak_g.toFixed(1)}g | Stability: ${shot.stability_score}% | Captured: ${timeStr}`;

    const holdStability = shot.hold_stability != null ? Math.round(shot.hold_stability) : (shot.stability_score != null ? Math.round(shot.stability_score) : null);
    const releaseQuality = shot.release_quality != null ? Math.round(shot.release_quality) : null;
    const followThrough = shot.follow_through != null ? Math.round(shot.follow_through) : null;
    const levelConsistency = shot.level_consistency != null ? Math.round(shot.level_consistency) : null;
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
      reviewShotId: shot.id,
      reviewTrace: trace.payload,
      reviewMicSeries: resolveReviewMicSeries(trace, trace.sample_rate_hz || 52),
      reviewSampleRateHz: trace.sample_rate_hz || 52,
      reviewThresholdG: shot.threshold_g != null ? Number(shot.threshold_g) : 12,
      reviewInfo: info,
      chartView: "target",
      replayActive: false,
      replayPaused: false,
      replayProgress: 1,
      traceZoom: 1,
      compareShotId: null,
      compareTrace: null,
      compareShotLabel: "",
      compareThresholdG: 12,
      formScore: score,
      holdStability,
      releaseQuality,
      followThrough,
      levelConsistency,
      scoreVersion: shot.score_version || null,
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

    await refreshReviewCompareOptions(shot.id, false);
    if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";

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
    reviewShotId: null,
    reviewTrace: null,
    reviewMicSeries: null,
    reviewSampleRateHz: 52,
    reviewThresholdG: 12,
    reviewInfo: "",
    compareShotId: null,
    compareTrace: null,
    compareShotLabel: "",
    compareThresholdG: 12,
    replayActive: false,
    replayPaused: false,
    replayProgress: 1,
    traceZoom: 1,
    formScore: null,
    holdStability: null,
    releaseQuality: null,
    followThrough: null,
    levelConsistency: null,
    scoreVersion: null,
    coachTitle: null,
    coachText: null
  });
  if (el.reviewCompareSelect) {
    el.reviewCompareSelect.innerHTML = '<option value="">None</option>';
    el.reviewCompareSelect.value = "";
  }
  bus.emit("log", "Exited review mode. Returned to live telemetry stream.");
});

if (el.reviewCompareSelect) {
  el.reviewCompareSelect.addEventListener("change", () => {
    loadReviewCompareShot(el.reviewCompareSelect.value);
  });
}

const RECENT_SHOTS_LIMIT = 5;

function recentShotCardMetrics(shot) {
  const timeStr = new Date(shot.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
  const stability = shot.stability_score != null ? Math.round(shot.stability_score) : "--";
  const peakG = Number.isFinite(Number(shot.peak_g)) ? Number(shot.peak_g).toFixed(1) : "--";
  return { timeStr, score, stability, peakG };
}

function buildHistoryItemElement(shot) {
  const item = document.createElement("div");
  item.className = "history-item";
  item.dataset.shotId = shot.id;

  const timestampStr = new Date(shot.timestamp).toLocaleTimeString();
  const title = shot.label || (shot.peak_g > 15 ? "Arrow Release" : "Hold Capture");
  const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
  const stability =
    shot.stability_score != null ? Math.round(shot.stability_score) : "--";
  const peakG = Number.isFinite(Number(shot.peak_g)) ? Number(shot.peak_g).toFixed(1) : "--";

  item.innerHTML = `
    <div class="history-item-preview-wrap is-empty" aria-hidden="true">
      <canvas class="history-item-trace-preview"></canvas>
    </div>
    <div class="history-item-body">
      <div class="history-meta">
        <div class="history-title">${escapeHtml(title)}</div>
        <div class="history-subtitle">${escapeHtml(timestampStr)}</div>
      </div>
      <div class="history-metrics">
        <div class="history-stat">
          <span class="history-stat-label">Float</span>
          <span class="history-stat-val score">${score}</span>
        </div>
        <div class="history-stat">
          <span class="history-stat-label">Stability</span>
          <span class="history-stat-val stability">${stability}%</span>
        </div>
        <div class="history-stat">
          <span class="history-stat-label">Peak G</span>
          <span class="history-stat-val peak">${peakG}g</span>
        </div>
      </div>
      <button
        type="button"
        class="history-item-delete-btn mini-icon-btn"
        title="Delete shot"
        aria-label="Delete shot"
      >🗑</button>
    </div>
  `;
  return item;
}

function syncQueueTaskMatchesShot(task, shotId) {
  if (!task || !shotId) return false;
  if (task.targetId === shotId) return true;
  const payload = task.payload;
  if (!payload) return false;
  if (payload.shot_id === shotId) return true;
  if (payload.id === shotId) return true;
  return false;
}

async function purgeSyncQueueForShot(shotId) {
  const tasks = await getAll("sync_queue");
  const matches = tasks.filter((task) => syncQueueTaskMatchesShot(task, shotId));
  await Promise.all(matches.map((task) => remove("sync_queue", task.id)));
}

async function deleteSavedShot(shotId) {
  if (!shotId) return;

  let shot;
  try {
    shot = await get("shots", shotId);
  } catch (_) {
    shot = null;
  }
  if (!shot) return;

  const title = shot.label || (shot.peak_g > 15 ? "Arrow Release" : "Hold Capture");
  const timeStr = new Date(shot.timestamp).toLocaleString();
  const confirmed = confirm(
    `Delete this saved shot?\n\n${title}\n${timeStr}\n\nThis cannot be undone.`,
  );
  if (!confirmed) return;

  try {
    await purgeSyncQueueForShot(shotId);
    try {
      await remove("shot_traces", shotId);
    } catch (_) {}
    await remove("shots", shotId);

    try {
      const override = await get("session_overrides", shotId);
      if (override) await remove("session_overrides", shotId);
    } catch (_) {}

    const state = store.get();
    const updates = {};
    if (state.reviewMode && state.reviewShotId === shotId) {
      Object.assign(updates, {
        reviewMode: false,
        reviewShotId: null,
        reviewTrace: null,
        reviewMicSeries: null,
        reviewInfo: "",
        replayActive: false,
        replayPaused: false,
        replayProgress: 1,
      });
    }
    if (state.compareShotId === shotId) {
      Object.assign(updates, {
        compareShotId: null,
        compareTrace: null,
        compareShotLabel: "",
        compareThresholdG: 12,
      });
      if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
    }
    if (Object.keys(updates).length > 0) store.set(updates);

    el.recentShotsList
      ?.querySelector(`.recent-shot-card[data-shot-id="${shotId}"]`)
      ?.remove();

    const historyItem = el.historyList?.querySelector(
      `.history-item[data-shot-id="${shotId}"]`,
    );
    if (historyItem) {
      const sessionGroup = historyItem.closest(".session-group");
      historyItem.remove();
      const remaining = sessionGroup?.querySelectorAll(".history-item").length ?? 0;
      if (remaining === 0 && sessionGroup) {
        sessionGroup.remove();
      } else if (sessionGroup) {
        const shotsLeft = sessionGroup.querySelectorAll(".history-item").length;
        const shotsBadge = sessionGroup.querySelector(
          ".session-stat-badge:first-child .badge-val",
        );
        if (shotsBadge) shotsBadge.textContent = String(shotsLeft);
      }
      const anyShots = el.historyList?.querySelector(".history-item");
      if (!anyShots) {
        el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet. Shots taken within ${Math.round(SESSION_GAP_MS / 60000)} minutes of each other are grouped into a session automatically.</p>`;
      }
    } else {
      await loadShotHistoryList();
    }

    if (state.reviewMode && state.reviewShotId && state.reviewShotId !== shotId) {
      await refreshReviewCompareOptions(state.reviewShotId);
    }

    if (syncAdapter) syncAdapter.triggerSync();
    bus.emit("log", `Deleted shot "${title}".`);
  } catch (error) {
    console.error("Failed to delete shot:", error);
    bus.emit("log", `Delete failed: ${error.message}`);
    alert(`Could not delete shot: ${error.message}`);
  }
}

async function paintHistoryShotPreviews(jobs) {
  if (!el.historyList) return;
  const entries = jobs?.length
    ? jobs
    : [...el.historyList.querySelectorAll(".history-item[data-shot-id]")].map((item) => ({
        item,
        shot: null,
      }));

  await Promise.all(
    entries.map(async ({ item, shot }) => {
      const canvas = item.querySelector(".history-item-trace-preview");
      const wrap = item.querySelector(".history-item-preview-wrap");
      if (!canvas || !wrap) return;
      try {
        const shotId = item.dataset.shotId;
        const record = shot || (shotId ? await get("shots", shotId) : null);
        if (!record) return;
        let trace = null;
        try {
          trace = await get("shot_traces", record.id);
        } catch (_) {
          trace = null;
        }
        paintShotPreview(canvas, wrap, record, trace);
      } catch (error) {
        console.error("Failed to paint history shot preview:", error);
      }
    }),
  );
}

async function refreshHistoryShotPreview(localShotId) {
  if (!el.historyList || !localShotId) return;
  const item = el.historyList.querySelector(
    `.history-item[data-shot-id="${localShotId}"]`,
  );
  if (!item) return;
  try {
    const shot = await get("shots", localShotId);
    const trace = await get("shot_traces", localShotId);
    const canvas = item.querySelector(".history-item-trace-preview");
    const wrap = item.querySelector(".history-item-preview-wrap");
    if (!shot || !canvas || !wrap) return;
    paintShotPreview(canvas, wrap, shot, trace);
  } catch (error) {
    console.error("Failed to refresh history shot preview:", error);
  }
}

function paintShotPreview(canvas, wrap, shot, trace) {
  if (!canvas || !wrap) return;
  const thresholdG = shot.threshold_g != null ? Number(shot.threshold_g) : 12;
  const paint = () => {
    if (trace?.payload?.length >= 2) {
      drawTraceTargetPreview(canvas, trace.payload, { thresholdG });
      wrap.classList.remove("is-empty");
    } else {
      drawEmptyTargetPreview(canvas);
      wrap.classList.add("is-empty");
    }
  };
  watchTracePreviewResize(canvas, paint);
  requestAnimationFrame(() => requestAnimationFrame(paint));
}

function buildRecentShotCardElement(shot, trace, titleIndex, totalShots) {
  const item = document.createElement("div");
  item.className = "recent-shot-card";
  item.dataset.shotId = shot.id;

  const { timeStr, score, stability, peakG } = recentShotCardMetrics(shot);
  const title = shot.label || `Shot #${Math.max(1, totalShots - titleIndex)}`;

  item.innerHTML = `
    <div class="recent-shot-preview-wrap is-empty" aria-hidden="true">
      <canvas class="recent-shot-preview"></canvas>
    </div>
    <div class="recent-shot-header">
      <span class="recent-shot-title">${escapeHtml(title)}</span>
      <span class="recent-shot-time">${escapeHtml(timeStr)}</span>
    </div>
    <div class="recent-shot-metrics">
      <div class="recent-shot-metric">
        <span class="metric-label">Float</span>
        <strong class="metric-val score">${score}</strong>
      </div>
      <div class="recent-shot-metric">
        <span class="metric-label">Stability</span>
        <strong class="metric-val">${stability}%</strong>
      </div>
      <div class="recent-shot-metric">
        <span class="metric-label">Peak G</span>
        <strong class="metric-val">${peakG}g</strong>
      </div>
    </div>
  `;

  const previewCanvas = item.querySelector(".recent-shot-preview");
  const previewWrap = item.querySelector(".recent-shot-preview-wrap");
  paintShotPreview(previewCanvas, previewWrap, shot, trace);

  item.addEventListener("click", () => {
    reviewShotTrace(shot);
  });
  return item;
}

function updateRecentShotCardMetrics(card, shot, titleIndex, totalShots) {
  const { timeStr, score, stability, peakG } = recentShotCardMetrics(shot);
  const title = shot.label || `Shot #${Math.max(1, totalShots - titleIndex)}`;
  const titleEl = card.querySelector(".recent-shot-title");
  const timeEl = card.querySelector(".recent-shot-time");
  const scoreEl = card.querySelector(".metric-val.score");
  const metrics = card.querySelectorAll(".recent-shot-metric .metric-val");
  if (titleEl) titleEl.textContent = title;
  if (timeEl) timeEl.textContent = timeStr;
  if (scoreEl) scoreEl.textContent = String(score);
  if (metrics[1]) metrics[1].textContent = `${stability}%`;
  if (metrics[2]) metrics[2].textContent = `${peakG}g`;
}

function trimRecentShotCards() {
  if (!el.recentShotsList) return;
  const cards = el.recentShotsList.querySelectorAll(".recent-shot-card");
  for (let i = RECENT_SHOTS_LIMIT; i < cards.length; i++) {
    cards[i].remove();
  }
}

function clearRecentShotsEmptyNote() {
  if (!el.recentShotsList) return;
  const note = el.recentShotsList.querySelector(":scope > .note");
  if (note) note.remove();
}

async function refreshRecentShotPreview(localShotId) {
  if (!el.recentShotsList || !localShotId) return;
  const card = el.recentShotsList.querySelector(
    `.recent-shot-card[data-shot-id="${localShotId}"]`,
  );
  if (!card) return;

  try {
    const shot = await get("shots", localShotId);
    const trace = await get("shot_traces", localShotId);
    if (!shot) return;
    const canvas = card.querySelector(".recent-shot-preview");
    const wrap = card.querySelector(".recent-shot-preview-wrap");
    paintShotPreview(canvas, wrap, shot, trace);
  } catch (error) {
    console.error("Failed to refresh recent shot preview:", error);
  }
}

async function upsertRecentShotCard(localShotId) {
  if (!el.recentShotsList || !localShotId) return;

  try {
    const shot = await get("shots", localShotId);
    if (!shot) return;

    const allShots = await getAll("shots");
    allShots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const totalShots = allShots.length;

    clearRecentShotsEmptyNote();

    let card = el.recentShotsList.querySelector(
      `.recent-shot-card[data-shot-id="${localShotId}"]`,
    );
    if (card) {
      updateRecentShotCardMetrics(card, shot, 0, totalShots);
      return;
    }

    const trace = await get("shot_traces", localShotId);
    card = buildRecentShotCardElement(shot, trace, 0, totalShots);
    el.recentShotsList.prepend(card);
    trimRecentShotCards();
  } catch (error) {
    console.error("Failed to upsert recent shot card:", error);
  }
}

function withPreservedScroll(run) {
  const root = document.scrollingElement || document.documentElement;
  const scrollTop = root.scrollTop;
  const finish = () => {
    requestAnimationFrame(() => {
      root.scrollTop = scrollTop;
    });
  };
  try {
    const result = run();
    if (result && typeof result.then === "function") {
      return result.then(finish, finish);
    }
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

// Load recent shots for dashboard (full rebuild — only on init / tab switch)
async function loadRecentShotsList() {
  if (!el.recentShotsList) return;
  try {
    const shots = await getAll("shots");
    if (!shots || shots.length === 0) {
      el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">No shots captured in this session yet.</p>`;
      return;
    }

    shots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recent = shots.slice(0, RECENT_SHOTS_LIMIT);

    el.recentShotsList.replaceChildren();

    const traceEntries = await Promise.all(
      recent.map(async (shot) => {
        try {
          const trace = await get("shot_traces", shot.id);
          return { shot, trace };
        } catch (_) {
          return { shot, trace: null };
        }
      }),
    );

    const fragment = document.createDocumentFragment();
    traceEntries.forEach(({ shot, trace }, index) => {
      fragment.appendChild(buildRecentShotCardElement(shot, trace, index, shots.length));
    });
    el.recentShotsList.appendChild(fragment);
  } catch (error) {
    console.error("Error loading recent shots:", error);
    el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">Failed to load recent shots.</p>`;
  }
}

bus.on("shot-saved", async (payload) => {
  if (payload?.duplicate) return;
  const localShotId = payload?.localShotId;
  if (localShotId) {
    await upsertRecentShotCard(localShotId);
    return;
  }
  await withPreservedScroll(() => loadRecentShotsList());
});

bus.on("shot-trace-saved", async (payload) => {
  const localShotId = payload?.localShotId;
  if (localShotId) {
    await refreshRecentShotPreview(localShotId);
    await refreshHistoryShotPreview(localShotId);
  }
  const state = store.get();
  if (state.reviewMode && state.reviewShotId) {
    await refreshReviewCompareOptions(state.reviewShotId);
  }
});

bus.on("battery", (level) => {
  const batteryLevel = Math.max(0, Math.min(100, Math.round(Number(level))));
  if (Number.isFinite(batteryLevel)) {
    store.set({ batteryLevel });
  }
});

bus.on("status", ({ mode }) => {
  if (mode !== "live") {
    store.set({ batteryLevel: null });
  }
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

bus.emit("log", `Ready (${APP_BUILD}). Click the status badge to connect a sensor.`);
