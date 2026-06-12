// App entry point: build the shared bus + store, wire telemetry and UI, and
// own the transport lifecycle (connect / disconnect).

import { createStore, EventBus } from "./core/store.js";
import { TelemetryStore } from "./telemetry/telemetry.js?v=shot-store-123";
import { createAdapter } from "./device/adapters.js?v=shot-store-123";
import {
  MOUNT_ORIENTATIONS,
  cloneMountAxes,
  mountBowShop,
  mountDashboard,
  mountLog,
  mountOrientationById,
  mountOrientationSettings,
  mountOrientationState,
  rotateMountAxes,
} from "./ui/dashboard.js?v=shot-store-124";
import { initDb, getAll, get, put, remove, generateUUID } from "./core/db.js?v=shot-store-98";
import { CloudSyncAdapter } from "./telemetry/sync.js?v=shot-store-117";
import { mountTraining } from "./ui/training.js?v=shot-store-99";
import { mountGuide } from "./ui/guide.js?v=shot-store-120";
import { initDataBackup } from "./ui/data-backup.js?v=shot-store-125";
import { initHistory } from "./ui/history.js?v=shot-store-125";
import { generateSampleData, SAMPLE_DEVICE_ID } from "./data/sample-data.js?v=shot-store-117";

const APP_BUILD = "shot-store-125";
const MODEL_ATTITUDE_VERSION = 3;

const ELEMENT_IDS = [
  "statusBadge", "statusText",
  "protocolValue", "typeValue", "sourceValue", "seqValue", "lossValue",
  "dtValue", "hzValue", "frameCountValue", "micVolumeItem", "volBar",
  "shotCountValue", "uploadStatusItem", "uploadCountValue", "eventLog", "traceCanvas",
  "orientationCanvas", "orientationRollValue", "orientationPitchValue", "orientationYawValue",
  "syncBadge", "syncText", "cloudModal", "closeCloudModalBtn",
  "sbUrlInput", "sbKeyInput", "saveCloudSettingsBtn", "clearCloudSettingsBtn",
  "chartTitle", "reviewBanner", "reviewInfo", "reviewRangeEst", "reviewCompareSelect",
  "reviewCompareField", "reviewCompareLegend", "exportShotBtn", "exitReviewBtn",
  "navDashboardBtn", "navTrainingBtn", "navHistoryBtn", "navBowShopBtn", "navSettingsBtn", "navGuideBtn",
  "tabDashboard", "tabTraining", "tabHistory", "tabBowShop", "tabSettings", "tabGuide",
  "guideSidebar", "guideContent", "historyList",
  "historyBulkActions", "bulkSelectCount", "bulkDeleteBtn", "bulkCancelBtn", "historySelectModeBtn", "bulkSelectAllBtn", "historyDefaultActions",
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
  "calOffsetRollValue", "calOffsetPitchValue", "calOffsetYawValue",
  "mountOrientationSelect", "mountOrientationCanvas", "mountOrientationDescription",
  "mountLiveCantValue", "mountLivePitchValue",
  "mountWizardText", "mountWizardPrimaryBtn", "mountWizardCancelBtn",
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
  "bowProfileSelect", "bowModelInput", "drawWeightInput", "bowSpeedInput", "stabilizerSetupInput", "bowNotesInput",
  "saveBowProfileBtn", "deleteBowProfileBtn", "newBowProfileBtn",
  "recentShotsPanel", "recentShotsList",
  "exportDataBtn", "importDataBtn", "importDataInput", "dataBackupStatus",
  "sampleDataCard", "clearSamplesBtn", "sampleDataStatus",
  "toggleLevelTuneBtn", "levelTuneSection", "levelRangeSlider",
  "levelRangeValue", "levelToleranceSlider", "levelToleranceValue",
  "liveDurationSlider", "liveDurationValue", "liveDurationContainer", "liveDurationDivider"
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
  reviewRangeEst: "",
  reviewReleaseIdx: null,
  reviewReleaseTimeMs: null,
  reviewHitIdx: null,
  reviewHitTimeMs: null,
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
  qw: null,
  qx: null,
  qy: null,
  qz: null,
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
  manualRecordElapsedSec: 0,
  liveTraceDuration: cached.liveTraceDuration !== undefined ? Number(cached.liveTraceDuration) : 10
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
      bowMaterialColors: store.get().bowMaterialColors,
      liveTraceDuration: store.get().liveTraceDuration
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
    if (cached.liveTraceDuration !== undefined && el.liveDurationSlider && el.liveDurationValue) {
      el.liveDurationSlider.value = cached.liveTraceDuration;
      el.liveDurationValue.textContent = cached.liveTraceDuration;
    }
  } catch (err) {
    console.error("Failed to init settings from cache:", err);
  }
}

// Demo/sample data so a first-time visitor without a device sees a populated
// dashboard. Seeded only into an empty database, never synced to the cloud, and
// removed as soon as real data shows up.
const SAMPLE_CLEARED_KEY = "openfloat_samples_cleared";

async function seedSampleDataIfEmpty() {
  try {
    if (localStorage.getItem(SAMPLE_CLEARED_KEY) === "1") return;
    const existing = await getAll("shots");
    if (existing.length > 0) return;
    const { shots, traces } = generateSampleData();
    for (const s of shots) await put("shots", s); // no sync_queue → never uploads
    for (const t of traces) await put("shot_traces", t);
    bus.emit(
      "log",
      `Loaded ${shots.length} sample shots so you can explore the app — connect a device to start your own.`,
    );
  } catch (error) {
    console.error("Sample data seed failed:", error);
  }
}

async function sampleShotsPresent() {
  try {
    const shots = await getAll("shots");
    return shots.some(
      (s) => s && (s.sample === true || s.device_id === SAMPLE_DEVICE_ID),
    );
  } catch (_) {
    return false;
  }
}

// Show the "Remove demo shots" control only while sample shots exist.
async function updateSampleControls() {
  if (!el.sampleDataCard) return;
  el.sampleDataCard.hidden = !(await sampleShotsPresent());
}

async function clearSampleData({ refresh = true } = {}) {
  try {
    const shots = await getAll("shots");
    const samples = shots.filter(
      (s) => s && (s.sample === true || s.device_id === SAMPLE_DEVICE_ID),
    );
    // Remember the choice so samples don't reappear, even if real data is later
    // deleted and the shots store ends up empty again.
    localStorage.setItem(SAMPLE_CLEARED_KEY, "1");
    for (const s of samples) {
      await remove("shots", s.id);
      await remove("shot_traces", s.id);
    }
    bus.emit("log", `Removed ${samples.length} demo shot(s).`);
    if (refresh) {
      await historyUi?.loadShotHistoryList();
      await historyUi?.loadRecentShotsList();
    }
    await updateSampleControls();
    return samples.length;
  } catch (error) {
    console.error("Clearing sample data failed:", error);
    return 0;
  }
}

// Initialize database
initDb().then(async () => {
  bus.emit("log", "Local IndexedDB initialized successfully.");
  await seedSampleDataIfEmpty();
  await loadBowProfiles();
  await historyUi?.loadRecentShotsList();
  await updateSampleControls();
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

  if (el.liveDurationContainer && el.liveDurationDivider) {
    const showDuration = !state.reviewMode;
    el.liveDurationContainer.classList.toggle("hidden", !showDuration);
    el.liveDurationDivider.classList.toggle("hidden", !showDuration);
    if (showDuration && el.liveDurationSlider && el.liveDurationValue) {
      el.liveDurationSlider.value = state.liveTraceDuration;
      el.liveDurationValue.textContent = state.liveTraceDuration;
    }
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
    }
  } else {
    if (!navigator.bluetooth) {
      el.mobileAlertText.textContent = `Your browser does not support Web Bluetooth. For the full experience, please use Chrome, Edge, or Opera.`;
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

if (el.liveDurationSlider) {
  el.liveDurationSlider.addEventListener("input", (e) => {
    const val = Number(e.target.value);
    if (el.liveDurationValue) el.liveDurationValue.textContent = val;
    store.set({ liveTraceDuration: val });
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

// --- Guided mount setup wizard ---------------------------------------------
// Detects the board mounting from two gravity captures: the bow held upright
// and level, then canted 90 degrees to the right. Each capture averages the
// most recent accel samples; the two measured "up" directions are snapped to
// the nearest signed IMU axes and matched against the mount presets.
const WIZARD_CAPTURE_MS = 1300;
const WIZARD_SAMPLE_COUNT = 40;
const WIZARD_IDLE_TEXT =
  "With the sensor connected and streaming, two quick captures detect the board position automatically — no axis-thinking required. Detection is relative to the data the sensor currently streams.";

let wizardStep = "idle"; // idle | level | tilted | result
let wizardLevelVec = null;
let wizardResult = null;

function wizardVecNormalize(v) {
  const mag = Math.hypot(v[0], v[1], v[2]);
  return mag > 0 ? v.map((c) => c / mag) : [0, 0, 0];
}

function wizardVecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function wizardVecCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function wizardSnapAxis(v) {
  const abs = v.map(Math.abs);
  const index = abs.indexOf(Math.max(...abs));
  const sign = v[index] >= 0 ? "" : "-";
  return { label: `${sign}${["IMU X", "IMU Y", "IMU Z"][index]}`, index };
}

function wizardUi(text, primaryLabel, { disabled = false, cancel = true } = {}) {
  if (el.mountWizardText) el.mountWizardText.textContent = text;
  if (el.mountWizardPrimaryBtn) {
    el.mountWizardPrimaryBtn.textContent = primaryLabel;
    el.mountWizardPrimaryBtn.disabled = disabled;
  }
  if (el.mountWizardCancelBtn) el.mountWizardCancelBtn.classList.toggle("hidden", !cancel);
}

function wizardReset(text = WIZARD_IDLE_TEXT) {
  wizardStep = "idle";
  wizardLevelVec = null;
  wizardResult = null;
  wizardUi(text, "Start Guided Setup", { cancel: false });
}

function wizardPromptForStep() {
  if (wizardStep === "level") {
    wizardUi(
      "Step 1 of 2 — Hold the bow upright and level, as if aiming with no cant. Keep it still, then press Capture.",
      "Capture Level Pose",
    );
  } else {
    wizardUi(
      "Step 2 of 2 — Cant the bow 90° to the right so the top limb points to the right. Hold still, then press Capture.",
      "Capture Canted Pose",
    );
  }
}

function wizardCollectGravity() {
  return new Promise((resolve) => {
    const before = telemetry.getTrace();
    const lastBefore = before.length ? before[before.length - 1] : null;
    setTimeout(() => {
      const trace = telemetry.getTrace();
      const lastAfter = trace.length ? trace[trace.length - 1] : null;
      if (!lastAfter || lastAfter === lastBefore) {
        resolve({ error: "No live sensor data. Connect the sensor (status badge, top right) and make sure it is streaming, then retry." });
        return;
      }
      const pts = trace.slice(-WIZARD_SAMPLE_COUNT);
      if (pts.length < 10) {
        resolve({ error: "Not enough samples yet — keep the sensor streaming for a moment and retry." });
        return;
      }
      const mean = [0, 0, 0];
      for (const pt of pts) {
        mean[0] += pt.ax || 0;
        mean[1] += pt.ay || 0;
        mean[2] += pt.az || 0;
      }
      mean[0] /= pts.length;
      mean[1] /= pts.length;
      mean[2] /= pts.length;
      const mag = Math.hypot(mean[0], mean[1], mean[2]);
      if (mag < 0.5 || mag > 1.5) {
        resolve({ error: `Unexpected acceleration (${mag.toFixed(2)} g). Hold the bow still — only gravity should be acting on it — and retry.` });
        return;
      }
      let maxVariance = 0;
      for (let axis = 0; axis < 3; axis++) {
        let variance = 0;
        for (const pt of pts) {
          const value = [pt.ax || 0, pt.ay || 0, pt.az || 0][axis];
          variance += (value - mean[axis]) ** 2;
        }
        maxVariance = Math.max(maxVariance, variance / pts.length);
      }
      if (Math.sqrt(maxVariance) > 0.12) {
        resolve({ error: "Too much movement during the capture. Hold the bow steady and retry." });
        return;
      }
      resolve({ vec: wizardVecNormalize(mean) });
    }, WIZARD_CAPTURE_MS);
  });
}

function wizardComputeResult(levelVec, tiltedVec) {
  const angleDeg = (Math.acos(Math.max(-1, Math.min(1, wizardVecDot(levelVec, tiltedVec)))) * 180) / Math.PI;
  if (angleDeg < 45) {
    return { error: "The two captures look too similar. Make sure the bow is canted a full 90° to the right for step 2, then retry." };
  }
  // Accel at rest reads "up" in board coords. Level pose: up = bow Y.
  // Canted 90° right: up = -bow Z, so bow Z = -capture.
  const yBow = levelVec;
  let zBow = tiltedVec.map((c) => -c);
  const projection = wizardVecDot(zBow, yBow);
  zBow = wizardVecNormalize(zBow.map((c, i) => c - projection * yBow[i]));
  const xBow = wizardVecCross(yBow, zBow);

  const snapX = wizardSnapAxis(xBow);
  const snapY = wizardSnapAxis(yBow);
  const snapZ = wizardSnapAxis(zBow);
  if (snapX.index === snapY.index || snapX.index === snapZ.index || snapY.index === snapZ.index) {
    return { error: "Could not resolve three distinct axes — the bow was probably between positions. Repeat both captures with the bow square in each pose." };
  }

  const axes = { x: snapX.label, y: snapY.label, z: snapZ.label };
  const preset = MOUNT_ORIENTATIONS.find(
    (o) => o.axes.x === axes.x && o.axes.y === axes.y && o.axes.z === axes.z,
  ) || null;
  return { axes, preset };
}

async function wizardCapture() {
  const step = wizardStep;
  wizardUi("Capturing — hold the bow still…", "Capturing…", { disabled: true });
  const capture = await wizardCollectGravity();
  if (wizardStep !== step) return; // cancelled mid-capture
  if (capture.error) {
    wizardUi(`${capture.error}`, step === "level" ? "Retry Level Capture" : "Retry Canted Capture");
    return;
  }
  if (step === "level") {
    wizardLevelVec = capture.vec;
    wizardStep = "tilted";
    wizardPromptForStep();
    return;
  }
  const result = wizardComputeResult(wizardLevelVec, capture.vec);
  if (result.error) {
    wizardStep = "level";
    wizardLevelVec = null;
    wizardUi(`${result.error}`, "Restart From Step 1");
    return;
  }
  wizardResult = result;
  wizardStep = "result";
  const mappingText = `Bow X ${result.axes.x}, Bow Y ${result.axes.y}, Bow Z ${result.axes.z}`;
  if (result.preset) {
    wizardUi(`Detected "${result.preset.label}" (${mappingText}). Press Apply to use it.`, "Apply Detected Mount");
  } else {
    wizardUi(`Detected a custom mapping (${mappingText}). Press Apply to use it — the small board in the preview may not visually match a custom mapping.`, "Apply Custom Mapping");
  }
}

function wizardApply() {
  if (!wizardResult) return;
  const { axes, preset } = wizardResult;
  if (preset) {
    store.set({
      mountOrientation: preset.id,
      mountBaseOrientation: preset.id,
      mountAxes: cloneMountAxes(preset.axes),
      mountRotation: [...preset.rotation],
    });
    bus.emit("log", `Guided setup applied mount "${preset.label}". Rebuild firmware with the matching axis mapping for device-computed angles.`);
  } else {
    store.set({ mountOrientation: "custom", mountAxes: cloneMountAxes(axes) });
    bus.emit("log", `Guided setup applied a custom mount mapping: Bow X ${axes.x}, Bow Y ${axes.y}, Bow Z ${axes.z}.`);
  }
  saveSettingsToCache();
  wizardReset("Applied. Rebuild the firmware with this mapping so device-computed angles match. You can re-run guided setup any time.");
}

if (el.mountWizardPrimaryBtn) {
  el.mountWizardPrimaryBtn.addEventListener("click", () => {
    if (wizardStep === "idle") {
      wizardStep = "level";
      wizardPromptForStep();
    } else if (wizardStep === "level" || wizardStep === "tilted") {
      wizardCapture();
    } else if (wizardStep === "result") {
      wizardApply();
    }
  });
}

if (el.mountWizardCancelBtn) {
  el.mountWizardCancelBtn.addEventListener("click", () => wizardReset());
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
  const tabs = ["tabDashboard", "tabTraining", "tabHistory", "tabBowShop", "tabSettings", "tabGuide"];
  const navButtons = {
    tabDashboard: el.navDashboardBtn,
    tabTraining: el.navTrainingBtn,
    tabHistory: el.navHistoryBtn,
    tabBowShop: el.navBowShopBtn,
    tabSettings: el.navSettingsBtn,
    tabGuide: el.navGuideBtn,
  };
  const panels = {
    tabDashboard: el.tabDashboard,
    tabTraining: el.tabTraining,
    tabHistory: el.tabHistory,
    tabBowShop: el.tabBowShop,
    tabSettings: el.tabSettings,
    tabGuide: el.tabGuide,
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
    historyUi?.loadShotHistoryList();
  }
  if (targetId === "tabDashboard") {
    historyUi?.withPreservedScroll(() => historyUi.loadRecentShotsList());
  }
  if (targetId === "tabGuide" && guide) {
    guide.show();
  }
}

if (el.navDashboardBtn && el.navTrainingBtn && el.navHistoryBtn && el.navBowShopBtn && el.navSettingsBtn) {
  el.navDashboardBtn.addEventListener("click", () => selectViewTab("tabDashboard"));
  el.navTrainingBtn.addEventListener("click", () => selectViewTab("tabTraining"));
  el.navHistoryBtn.addEventListener("click", () => selectViewTab("tabHistory"));
  el.navBowShopBtn.addEventListener("click", () => selectViewTab("tabBowShop"));
  el.navSettingsBtn.addEventListener("click", () => selectViewTab("tabSettings"));
}
if (el.navGuideBtn) {
  el.navGuideBtn.addEventListener("click", () => selectViewTab("tabGuide"));
}

// In-app Guide (docs / wiki) tab.
const guide = mountGuide({ sidebar: el.guideSidebar, content: el.guideContent });
// Deep-link: open the Guide tab directly when the URL targets a guide page.
if (guide && guide.hasHashTarget()) {
  selectViewTab("tabGuide");
}
window.addEventListener("hashchange", () => {
  if (guide && guide.hasHashTarget()) {
    selectViewTab("tabGuide");
  }
});

initDataBackup({
  bus,
  syncAdapter,
  el,
  onImportComplete: async () => {
    await loadBowProfiles();
    await historyUi?.loadShotHistoryList();
    await historyUi?.loadRecentShotsList();
  },
});

if (el.clearSamplesBtn) {
  el.clearSamplesBtn.addEventListener("click", async () => {
    el.clearSamplesBtn.disabled = true;
    const n = await clearSampleData();
    bus.emit("log", n > 0 ? `Removed ${n} demo shot(s).` : "No demo shots to remove.");
    el.clearSamplesBtn.disabled = false;
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
    el.bowSpeedInput.value = "";
    el.stabilizerSetupInput.value = "";
    el.bowNotesInput.value = "";
    el.deleteBowProfileBtn.disabled = true;
  } else {
    try {
      const profile = await get("bow_profiles", selectedId);
      if (profile) {
        el.bowModelInput.value = profile.model || "";
        el.drawWeightInput.value = profile.draw_weight != null ? profile.draw_weight : "";
        el.bowSpeedInput.value = profile.arrow_speed != null ? profile.arrow_speed : "";
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
  const arrowSpeed = parseInt(el.bowSpeedInput.value, 10) || null;
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
    arrow_speed: arrowSpeed,
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

let historyUi = null;

historyUi = initHistory({
  bus,
  store,
  state: store.get(),
  el,
  syncAdapter,
  selectViewTab,
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
