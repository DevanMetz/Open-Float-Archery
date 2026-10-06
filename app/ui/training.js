// Steady Aim Training Game UI Module
// Manages the prep countdown, audio tones, live target tracing, scoring, and DB persistence.

import { getAll, saveCapture, generateUUID } from "../core/db.js?v=shot-store-176";
import { computeFloatScoreFromTrace } from "../telemetry/score.js?v=shot-store-150";
import {
  TRAINING_DRILLS,
  analyzeTrainingHistory,
  downsampleTrainingTrace,
  scoreTrainingHold,
  trainingFeedback,
} from "./training-coach.js?v=shot-store-150";

const TARGET_COLORS = ["#FFFFFF", "#1E1E1E", "#00B5E2", "#EE383E", "#FFE000"];
// A browser continuity guard, not a validated sensor sampling requirement.
const MAX_SAMPLE_GAP_MS = 1000;

// Marker colors that must flip with the page theme (white on the classic dark
// canvas, ink on light themes). Falls back to the classic palette when the
// --trace-* variables are not defined.
function canvasMarkerInk() {
  const styles = getComputedStyle(document.documentElement);
  return {
    dotRing: styles.getPropertyValue("--trace-dot-ring").trim() || "#FFFFFF",
    crosshair: styles.getPropertyValue("--trace-crosshair").trim() || "rgba(255, 255, 255, 0.6)",
    hold: styles.getPropertyValue("--green").trim() || "#30E39B",
    liveDot: styles.getPropertyValue("--cyan").trim() || "#35C7E8",
    refDot: styles.getPropertyValue("--red").trim() || "#FF5D73",
  };
}

// Stats Helper Functions
function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Web Audio API tone generator
function playTone(frequency, durationMs) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = "sine";

    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + durationMs / 1000);
    oscillator.onended = () => audioCtx.close();
  } catch (err) {
    console.warn("Failed to play audio tone:", err);
  }
}

export function mountTraining({ store, el, bus }) {
  if (!el.trainingTargetCanvas) return;

  const ctx = el.trainingTargetCanvas.getContext("2d");
  
  // Game states: 'idle', 'countdown', 'holding', 'finished', 'saving', 'refreshing'
  let gameState = "idle";
  let countdownVal = 5;
  let remainingHoldTime = 10;
  let timerInterval = null;
  let phaseDeadline = 0;
  let holdStartedAt = 0;
  let holdTimestamp = null;
  let renderFrame = null;
  let finishTone = null;
  let trainingVisible = !el.tabTraining || el.tabTraining.classList.contains("active-view");
  let pageActive = true;
  let disposed = false;
  
  let refRoll = 0;
  let refPitch = 0;
  let trainingSamples = [];
  let currentHoldDuration = 10;
  let sessionIsDemo = false;
  let sessionDeviceId = "OpenFloat-Sensor";
  let sessionConnectionMode = "";
  let interruption = "";
  let saveMessage = "";
  let recommendation = analyzeTrainingHistory([]);
  let recommendationRequest = 0;
  let activeDrill = TRAINING_DRILLS[recommendation.drillId];
  let currentTarget = recommendation.target;

  // Render variables
  let liveDotRoll = null;
  let liveDotPitch = null;

  function selectedDrillId() {
    const selected = el.trainingDrillSelect?.value || "adaptive";
    return selected === "adaptive" ? recommendation.drillId : selected;
  }

  function updateDrillUi({ applyDuration = false } = {}) {
    if (gameState !== "idle") return;
    activeDrill = TRAINING_DRILLS[selectedDrillId()] || TRAINING_DRILLS.steady;
    const isAdaptive = (el.trainingDrillSelect?.value || "adaptive") === "adaptive";
    currentTarget = isAdaptive ? recommendation.target : activeDrill.defaultTarget;

    if (el.trainingDrillDescription) {
      el.trainingDrillDescription.textContent = `${activeDrill.description} Cue: ${activeDrill.cue}`;
    }
    if (el.trainingReadyTitle) el.trainingReadyTitle.textContent = activeDrill.name;
    if (el.trainingReadyText) {
      el.trainingReadyText.textContent = `${activeDrill.cue} Target score: ${currentTarget}.`;
    }
    if (el.startTrainingBtn && gameState === "idle") {
      el.startTrainingBtn.textContent = `Start ${activeDrill.name}`;
    }
    if (applyDuration && el.trainingDurationSelect) {
      el.trainingDurationSelect.value = String(activeDrill.defaultDuration);
    }
  }

  function renderRecommendation() {
    if (el.adaptiveCoachTitle) el.adaptiveCoachTitle.textContent = recommendation.title;
    if (el.adaptiveCoachText) el.adaptiveCoachText.textContent = recommendation.reason;
    if (el.adaptiveCoachStats) {
      const baseline = recommendation.baseline == null ? "New baseline" : `Baseline ${recommendation.baseline}`;
      el.adaptiveCoachStats.textContent = `${TRAINING_DRILLS[recommendation.drillId].name} | ${baseline} | Target ${recommendation.target}`;
    }
  }

  async function refreshRecommendation() {
    const request = ++recommendationRequest;
    try {
      const shots = await getAll("shots");
      if (disposed || request !== recommendationRequest) return;
      recommendation = analyzeTrainingHistory(shots);
      renderRecommendation();
      if (gameState === "idle") updateDrillUi();
      return true;
    } catch (error) {
      if (disposed || request !== recommendationRequest) return;
      console.warn("Failed to refresh adaptive training recommendation:", error);
      return false;
    }
  }

  function visible() {
    return !disposed && pageActive && trainingVisible && !document.hidden;
  }

  function active() {
    return gameState === "countdown" || gameState === "holding";
  }

  function updateStatus(state = store.get()) {
    const connected = state.connected;
    if (el.startTrainingBtn) {
      el.startTrainingBtn.disabled = !connected || gameState !== "idle" || !visible();
    }

    if (el.trainingStatusText && el.trainingStatusDesc) {
      if (connected) {
        el.trainingStatusText.textContent = state.statusMode === "demo" ? "Demo Mode" : "Connected";
        el.trainingStatusText.style.color = "var(--green)";
        el.trainingStatusDesc.textContent = saveMessage || interruption || (state.statusMode === "demo"
          ? "Synthetic movement. Saved demo holds stay local and do not affect your baseline."
          : "Bow sensor is streaming. Press start to train.");
      } else {
        el.trainingStatusText.textContent = "Disconnected";
        el.trainingStatusText.style.color = "var(--red)";
        el.trainingStatusDesc.textContent = saveMessage || interruption || "Connect a sensor or start demo mode to train.";
      }
    }
  }

  function interrupt(message) {
    if (!active()) return;
    interruption = message;
    resetToIdle();
    bus.emit("log", message);
  }

  // React to connection states in the reactive store.
  const stopStore = store.subscribe((state) => {
    if (active() && (!state.connected || state.statusMode !== sessionConnectionMode)) {
      interrupt(state.connected
        ? "Hold stopped: the connection changed. Press start to retry."
        : "Hold stopped: connection lost. Reconnect your sensor or start demo mode to retry.");
    }
    updateStatus(state);

    // Live display updates during hold
    if (gameState === "holding" && state.sample) {
      const roll = state.roll - (state.cantOffset || 0);
      const pitch = state.pitch - (state.pitchOffset || 0);
      if (!Number.isFinite(roll) || !Number.isFinite(pitch)) return;
      liveDotRoll = roll;
      liveDotPitch = pitch;
      if (el.trainingCantBadge) {
        // Calculate calibrated cant
        el.trainingCantBadge.textContent = `Cant: ${roll.toFixed(1)} deg`;
        el.trainingCantBadge.style.color = Math.abs(roll) <= (state.levelTolerance || 2.0) ? "var(--green)" : "var(--amber)";
      }
    }
  });

  // Listen to raw samples from event bus to collect high-res trace data
  const stopSamples = bus.on("sample", (sample) => {
    if (gameState !== "holding") return;
    if (!visible()) {
      interrupt("Hold stopped: the training page was hidden. Press start to retry.");
      return;
    }
    const now = performance.now();
    // A delayed timer must not collect movement after the selected window.
    if (now > phaseDeadline) {
      finishHoldingPhase();
      return;
    }
    if (!continuousAt(now)) return;
    if (sample.source === "demo") sessionIsDemo = true;
    
    const state = store.get();
    const roll = state.roll - (state.cantOffset || 0);
    const pitch = state.pitch - (state.pitchOffset || 0);
    if (!Number.isFinite(roll) || !Number.isFinite(pitch)) return;
    if (trainingSamples.length === 0) {
      // Anchor the target to the first usable frame in this hold.
      refRoll = liveDotRoll = roll;
      refPitch = liveDotPitch = pitch;
    }
    
    trainingSamples.push({
      roll,
      pitch,
      yaw: state.yaw || 0,
      gx: sample.gxDps || 0,
      gy: sample.gyDps || 0,
      gz: sample.gzDps || 0,
      ax: (sample.axMg || 0) / 1000,
      ay: (sample.ayMg || 0) / 1000,
      az: (sample.azMg ?? 1000) / 1000,
      timestamp: now,
      micAmp: sample.micAmp || 0
    });
  });

  // Setup click listeners
  el.startTrainingBtn.addEventListener("click", startSession);
  el.cancelTrainingBtn.addEventListener("click", cancelSession);
  el.saveTrainingShotBtn.addEventListener("click", saveSession);
  el.discardTrainingShotBtn.addEventListener("click", discardSession);
  const changeDrill = () => updateDrillUi({ applyDuration: true });
  el.trainingDrillSelect?.addEventListener("change", changeDrill);
  const stopViews = bus.on("view-changed", (viewId) => {
    trainingVisible = viewId === "tabTraining";
    if (!trainingVisible) {
      interrupt("Hold stopped: you left the Training tab. Press start to retry.");
      stopRendering();
      clearFinishTone();
    } else {
      refreshRecommendation();
      requestRender();
    }
    updateStatus();
  });
  const stopSaved = bus.on("shot-saved", refreshRecommendation);
  const stopTraceSaved = bus.on("shot-trace-saved", refreshRecommendation);
  const stopChanged = bus.on("saved-data-changed", refreshRecommendation);

  function visibilityChanged() {
    if (!visible()) {
      interrupt("Hold stopped: the training page was hidden. Press start to retry.");
      stopRendering();
      clearFinishTone();
    } else requestRender();
    updateStatus();
  }
  function pageHidden() { pageActive = false; visibilityChanged(); }
  function pageShown() { pageActive = true; visibilityChanged(); }
  function beforeUnload(event) {
    if (gameState !== "finished" && gameState !== "saving") return;
    event.preventDefault();
    event.returnValue = "";
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", pageHidden);
  window.addEventListener("pageshow", pageShown);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("themechange", requestRender);
  renderRecommendation();
  updateDrillUi({ applyDuration: true });
  refreshRecommendation();

  // Resize canvas handler
  function resizeCanvas() {
    const canvas = el.trainingTargetCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resized() { resizeCanvas(); requestRender(); }
  window.addEventListener("resize", resized);

  function stopRendering() {
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
  }

  function requestRender() {
    if (!visible() || renderFrame !== null ||
        !["holding", "finished", "saving", "refreshing"].includes(gameState)) return;
    const frame = requestAnimationFrame(() => {
      if (renderFrame !== frame) return;
      renderFrame = null;
      renderLoop();
    });
    renderFrame = frame;
  }

  function clearFinishTone() {
    if (finishTone !== null) clearTimeout(finishTone);
    finishTone = null;
  }

  function drawTargetRings(cx, cy, maxRadius) {
    const radii = [maxRadius, maxRadius * 0.8, maxRadius * 0.6, maxRadius * 0.4, maxRadius * 0.2];
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = TARGET_COLORS[i];
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
  }

  function renderLoop() {
    if (!visible() || !["holding", "finished", "saving", "refreshing"].includes(gameState)) return;

    const canvas = el.trainingTargetCanvas;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    
    // Ensure canvas backing store matches bounding rect
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      resizeCanvas();
    }

    ctx.clearRect(0, 0, w, h);

    const markerInk = canvasMarkerInk();
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = Math.min(w, h) * 0.45;

    // 1. Draw Target
    drawTargetRings(cx, cy, maxRadius);

    // 2. Draw Center Crosshair
    ctx.strokeStyle = "rgba(142, 166, 160, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - maxRadius, cy);
    ctx.lineTo(cx + maxRadius, cy);
    ctx.moveTo(cx, cy - maxRadius);
    ctx.lineTo(cx, cy + maxRadius);
    ctx.stroke();

    if (gameState === "holding" && trainingSamples.length > 0) {
      // Live hold rendering (Fixed visual scale: 1.5° deflection reaches target blue ring)
      const scale = (maxRadius * 0.6) / 1.5;

      // Draw Trace Path
      ctx.save();
      ctx.strokeStyle = markerInk.hold;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < trainingSamples.length; i++) {
        const pt = trainingSamples[i];
        const x = cx + (pt.roll - refRoll) * scale;
        const y = cy - (pt.pitch - refPitch) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Draw Live Position Dot
      if (liveDotRoll !== null) {
        const lx = cx + (liveDotRoll - refRoll) * scale;
        const ly = cy - (liveDotPitch - refPitch) * scale;
        
        ctx.fillStyle = markerInk.liveDot; // Live indicator dot (cyan)
        ctx.beginPath();
        ctx.arc(lx, ly, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = markerInk.dotRing;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Crosshair for live dot
        ctx.strokeStyle = markerInk.crosshair;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx - 10, ly);
        ctx.lineTo(lx + 10, ly);
        ctx.moveTo(lx, ly - 10);
        ctx.lineTo(lx, ly + 10);
        ctx.stroke();
      }
    } else if (gameState !== "holding" && trainingSamples.length >= 2) {
      // Finished view: auto-scale to review trajectory shape, center on average float point
      const rolls = trainingSamples.map((pt) => pt.roll);
      const pitches = trainingSamples.map((pt) => pt.pitch);
      const avgR = mean(rolls);
      const avgP = mean(pitches);

      let maxDev = 0.05;
      for (let i = 0; i < trainingSamples.length; i++) {
        const dev = Math.hypot(rolls[i] - avgR, pitches[i] - avgP);
        if (dev > maxDev) maxDev = dev;
      }
      const scale = (maxRadius * 0.9) / maxDev;

      // Draw standard-deviation ellipse (sigma error ellipse)
      const ellipseData = calculateSigmaEllipse(trainingSamples, scale);
      if (ellipseData) {
        const ecx = cx + (ellipseData.rollMean - avgR) * scale;
        const ecy = cy - (ellipseData.pitchMean - avgP) * scale;
        
        ctx.save();
        ctx.translate(ecx, ecy);
        ctx.rotate(-ellipseData.angle);
        ctx.fillStyle = markerInk.hold;
        ctx.strokeStyle = markerInk.hold;

        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        ctx.ellipse(0, 0, ellipseData.radiusX, ellipseData.radiusY, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, ellipseData.radiusX, ellipseData.radiusY, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.restore();
      }

      // Draw Trace Path
      ctx.strokeStyle = markerInk.hold; // Green trace
      ctx.lineWidth = 2.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < trainingSamples.length; i++) {
        const pt = trainingSamples[i];
        const x = cx + (pt.roll - avgR) * scale;
        const y = cy - (pt.pitch - avgP) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw final reference crosshair on the center of average float
      ctx.fillStyle = markerInk.refDot;
      ctx.strokeStyle = markerInk.dotRing;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (gameState === "holding") requestRender();
  }

  function calculateSigmaEllipse(points, scale) {
    if (points.length < 8) return null;

    const rolls = points.map((pt) => pt.roll || 0);
    const pitches = points.map((pt) => pt.pitch || 0);
    const rollMean = mean(rolls);
    const pitchMean = mean(pitches);
    
    let covRoll = 0;
    let covPitch = 0;
    let covCross = 0;

    for (let i = 0; i < points.length; i++) {
      const dx = rolls[i] - rollMean;
      const dy = pitches[i] - pitchMean;
      covRoll += dx * dx;
      covPitch += dy * dy;
      covCross += dx * dy;
    }

    covRoll /= points.length;
    covPitch /= points.length;
    covCross /= points.length;

    const traceVal = covRoll + covPitch;
    const delta = Math.sqrt(Math.max(0, ((covRoll - covPitch) / 2) ** 2 + covCross ** 2));
    const lambda1 = Math.max(0.0001, traceVal / 2 + delta);
    const lambda2 = Math.max(0.0001, traceVal / 2 - delta);
    const angle = Math.atan2(2 * covCross, covRoll - covPitch) / 2;

    const radiusX = Math.max(8, Math.sqrt(lambda1) * scale);
    const radiusY = Math.max(6, Math.sqrt(lambda2) * scale);

    return {
      rollMean,
      pitchMean,
      radiusX,
      radiusY,
      angle
    };
  }

  function startSession() {
    if (gameState !== "idle" || !store.get().connected || !visible()) return;
    const focusStart = document.activeElement === el.startTrainingBtn;

    updateDrillUi();
    interruption = "";
    saveMessage = "";
    clearFinishTone();
    gameState = "countdown";
    countdownVal = 5;
    const duration = Number(el.trainingDurationSelect.value);
    currentHoldDuration = Number.isFinite(duration) && duration >= 5 && duration <= 30 ? duration : 10;
    phaseDeadline = performance.now() + 5000;
    sessionIsDemo = store.get().statusMode === "demo";
    sessionDeviceId = store.get().deviceId || "OpenFloat-Sensor";
    sessionConnectionMode = store.get().statusMode;
    
    trainingSamples = [];
    
    // Toggle UI display
    el.trainingDisplayDefault.classList.add("hidden");
    el.trainingDisplayActive.classList.remove("hidden");
    el.trainingTargetWrapper.classList.add("hidden");
    el.trainingResultsCard.classList.add("hidden");
    
    el.startTrainingBtn.classList.add("hidden");
    el.cancelTrainingBtn.classList.remove("hidden");
    el.trainingDurationSelect.disabled = true;
    if (el.trainingDrillSelect) el.trainingDrillSelect.disabled = true;
    
    el.trainingCountdownVal.textContent = countdownVal;
    el.trainingPhaseLabel.textContent = activeDrill.cue;
    el.trainingPhaseLabel.style.color = "var(--amber)";
    
    // Setup timer circle
    const progressCircle = el.timerProgress;
    progressCircle.style.stroke = "var(--amber)";
    progressCircle.style.strokeDashoffset = "0";
    
    playTone(440, 100); // initial beep
    timerInterval = setInterval(tick, 100);
    updateStatus();
    if (focusStart) el.cancelTrainingBtn.focus();
  }

  function tick() {
    if (!active()) return;
    if (!visible()) {
      interrupt("Hold stopped: the training page was hidden. Press start to retry.");
      return;
    }
    const now = performance.now();
    if (gameState === "countdown") {
      const remaining = Math.max(0, phaseDeadline - now);
      if (remaining === 0) {
        // A delayed preparation callback still gives the archer a full hold
        // starting at the actual cue, rather than a shortened catch-up hold.
        startHoldingPhase();
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      if (seconds !== countdownVal) {
        countdownVal = seconds;
        el.trainingCountdownVal.textContent = seconds;
        playTone(440, 100);
      }
      el.timerProgress.style.strokeDashoffset = 339.3 * (1 - remaining / 5000);
    } else if (now >= phaseDeadline) {
      finishHoldingPhase();
    } else if (continuousAt(now)) {
      remainingHoldTime = Math.max(0, (phaseDeadline - now) / 1000);
      el.trainingHoldTimerBadge.textContent = `${remainingHoldTime.toFixed(1)}s`;
    }
  }

  function continuousAt(now) {
    const previous = trainingSamples.at(-1)?.timestamp ?? holdStartedAt;
    if (now - previous <= MAX_SAMPLE_GAP_MS) return true;
    interrupt("Hold stopped: sensor data paused for over a second. Press start to retry.");
    return false;
  }

  function startHoldingPhase() {
    gameState = "holding";
    remainingHoldTime = currentHoldDuration;
    holdStartedAt = performance.now();
    phaseDeadline = holdStartedAt + currentHoldDuration * 1000;
    // Match the scored window's end, even if completion or Save runs later.
    // Sample the wall clock at the cue; elapsed hold time stays monotonic.
    holdTimestamp = new Date(Date.now() + currentHoldDuration * 1000).toISOString();
    
    // Play loud hold tone
    playTone(880, 350);
    
    // Wire UI to target canvas
    el.trainingDisplayActive.classList.add("hidden");
    el.trainingTargetWrapper.classList.remove("hidden");
    
    el.trainingHoldTimerBadge.textContent = `${remainingHoldTime.toFixed(1)}s`;
    
    // Take reference offset
    const activeState = store.get();
    refRoll = activeState.roll - (activeState.cantOffset || 0);
    refPitch = activeState.pitch - (activeState.pitchOffset || 0);
    
    // Clear live indicator variables
    liveDotRoll = refRoll;
    liveDotPitch = refPitch;
    
    // Start drawing
    resizeCanvas();
    requestRender();
  }

  function finishHoldingPhase() {
    if (gameState !== "holding" || !continuousAt(phaseDeadline)) return;
    if (trainingSamples.length < 5) {
      interrupt("Hold stopped: too little usable sensor data. Press start to retry.");
      return;
    }
    const focusCancel = document.activeElement === el.cancelTrainingBtn;
    gameState = "finished";
    clearInterval(timerInterval);
    timerInterval = null;
    el.trainingHoldTimerBadge.textContent = "0.0s";
    stopRendering();
    requestRender();
    
    // Play happy double-beep
    playTone(660, 150);
    finishTone = setTimeout(() => {
      finishTone = null;
      if (visible() && (gameState === "finished" || gameState === "saving")) playTone(880, 250);
    }, 180);
    
    // Switch cancel button back to start button
    el.cancelTrainingBtn.classList.add("hidden");
    el.startTrainingBtn.classList.remove("hidden");
    el.startTrainingBtn.disabled = true;
    
    const result = scoreTrainingHold(trainingSamples, {
      drillId: activeDrill.id,
      levelTolerance: store.get().levelTolerance || 2,
    });
    const feedback = trainingFeedback(result, currentTarget);

    if (el.resultScoreLabel) el.resultScoreLabel.textContent = `${activeDrill.name} Score`;
    el.resultSteadinessScore.textContent = result.score;
    el.resultAvgCantDev.textContent = `${result.avgCantDev.toFixed(2)} deg`;
    el.resultAvgPitchDev.textContent = `${result.avgPitchDev.toFixed(2)} deg`;
    el.resultMaxFloat.textContent = `${result.maxFloat.toFixed(2)} deg`;
    el.resultCoachingTitle.textContent = feedback.title;
    el.resultCoachingText.textContent = `${sessionIsDemo ? "Demo result. " : ""}${feedback.text} Goal: ${feedback.target}.`;
    el.saveTrainingShotBtn.textContent = sessionIsDemo ? "Save Demo Hold" : "Save Session Shot";
    
    // Open results card
    el.trainingResultsCard.classList.remove("hidden");
    if (focusCancel) el.saveTrainingShotBtn.focus();
  }

  async function saveSession() {
    if (gameState !== "finished" || trainingSamples.length === 0) return;
    const hadFocus = document.activeElement === el.saveTrainingShotBtn;
    gameState = "saving";
    
    el.saveTrainingShotBtn.disabled = true;
    el.discardTrainingShotBtn.disabled = true;
    el.saveTrainingShotBtn.textContent = "Saving...";
    saveMessage = "Saving training hold...";
    updateStatus();
    let sessionShotId;
    
    try {
      const rolls = trainingSamples.map((s) => s.roll);
      const pitches = trainingSamples.map((s) => s.pitch);
      const avgRoll = mean(rolls);
      const avgPitch = mean(pitches);
      const score = Number(el.resultSteadinessScore.textContent);
      
      let maxG = 0;
      for (const s of trainingSamples) {
        const g = Math.hypot(s.ax, s.ay, s.az);
        if (g > maxG) maxG = g;
      }
      
      sessionShotId = generateUUID();
      const timestamp = holdTimestamp;
      const label = `${activeDrill.label} (${currentHoldDuration}s)`;
      const savedSamples = downsampleTrainingTrace(trainingSamples, 52);
      const traceStartTime = Number(savedSamples[0]?.timestamp) || 0;
      const traceForScore = savedSamples.map((s) => ({
        ax: s.ax,
        ay: s.ay,
        az: s.az,
        gx: s.gx || 0,
        gy: s.gy || 0,
        gz: s.gz || 0,
        roll: s.roll,
        pitch: s.pitch,
        yaw: s.yaw || 0,
        micAmp: s.micAmp || 0,
        tUs: Math.max(0, Math.round(((Number(s.timestamp) || traceStartTime) - traceStartTime) * 1000)),
      }));
      const floatScore = computeFloatScoreFromTrace(traceForScore, {
        sampleRateHz: 52,
        isManual: true,
      });
      
      const shotRecord = {
        id: sessionShotId,
        session_id: null,
        device_id: sessionIsDemo ? "OpenFloat-Demo" : sessionDeviceId,
        capture_kind: "hold",
        sample: sessionIsDemo,
        timestamp,
        peak_g: Number(maxG.toFixed(2)),
        cant_angle_deg: Number(avgRoll.toFixed(1)),
        pitch_angle_deg: Number(avgPitch.toFixed(1)),
        yaw_angle_deg: 0,
        roll_angle_deg: Number(avgRoll.toFixed(1)),
        stability_score: score,
        shot_score: floatScore.formScore,
        hold_stability: floatScore.holdStability,
        release_quality: floatScore.releaseQuality,
        follow_through: floatScore.followThrough,
        level_consistency: floatScore.levelConsistency,
        score_version: floatScore.scoreVersion,
        packet_loss_count: 0,
        label: label
      };
      
      const tracePayload = {
        shot_id: sessionShotId,
        sample: sessionIsDemo,
        source: sessionIsDemo ? "sample" : "browser-training",
        sample_rate_hz: 52,
        payload: traceForScore
      };
      
      await saveCapture(shotRecord, tracePayload);
    } catch (err) {
      if (disposed) return;
      gameState = "finished";
      console.error("Failed to save training shot:", err);
      saveMessage = `Could not save the hold locally: ${err?.message || "Storage unavailable"}. Your result is still here. Press Save to retry.`;
      finishSaveControls();
      updateStatus();
      if (hadFocus && visible() && document.activeElement === document.body) el.saveTrainingShotBtn.focus();
      // Logging cannot turn a retained, retryable result into another failure.
      bus.emitAsync("log", saveMessage);
      return;
    }
    if (disposed) return;

    // Storage has committed. Only notification outcomes remain; these cannot
    // return the same hold to a retryable state or trigger an unsaved warning.
    gameState = "refreshing";
    clearFinishTone();
    saveMessage = "Training hold saved locally. Refreshing saved views...";
    updateStatus();
    let refreshed = false;
    try {
      const [, ...notifications] = await Promise.all([
        bus.emitAsync("log", `${activeDrill.name} training session saved successfully (ID: ${sessionShotId.slice(0, 8)}).`),
        bus.emitAsync("shot-saved", { shotId: null, stored: false, localShotId: sessionShotId }),
        bus.emitAsync("shot-trace-saved", { localShotId: sessionShotId, deviceShotId: null }),
      ]);
      refreshed = notifications.flat().every((result) => result.status === "fulfilled" && result.value !== false);
    } catch (error) {
      console.warn("Training hold saved locally; notifications could not finish:", error);
    }
    if (disposed) return;
    saveMessage = refreshed
      ? "Training hold saved locally."
      : "Training hold saved locally. Some views could not refresh. Reopen Saved Shots or Training to retry the views.";
    resetToIdle({ focus: true, hadFocus });
    finishSaveControls();
    return sessionShotId;
  }

  function finishSaveControls() {
    el.saveTrainingShotBtn.disabled = false;
    el.saveTrainingShotBtn.textContent = sessionIsDemo ? "Save Demo Hold" : "Save Session Shot";
    el.discardTrainingShotBtn.disabled = false;
  }

  function cancelSession() {
    if (gameState !== "countdown" && gameState !== "holding") return;
    
    clearInterval(timerInterval);
    bus.emit("log", `${activeDrill.name} training session cancelled.`);
    resetToIdle({ focus: true });
  }

  function discardSession() {
    if (gameState === "saving" || gameState === "refreshing") return;
    saveMessage = "";
    resetToIdle({ focus: true });
  }

  function resetToIdle({ focus = false, hadFocus = false } = {}) {
    const focused = document.activeElement;
    gameState = "idle";
    clearInterval(timerInterval);
    timerInterval = null;
    stopRendering();
    clearFinishTone();
    
    // Reset buttons and controls
    el.cancelTrainingBtn.classList.add("hidden");
    el.startTrainingBtn.classList.remove("hidden");
    el.trainingDurationSelect.disabled = false;
    if (el.trainingDrillSelect) el.trainingDrillSelect.disabled = false;
    
    // Hide panels
    el.trainingDisplayActive.classList.add("hidden");
    el.trainingTargetWrapper.classList.add("hidden");
    el.trainingResultsCard.classList.add("hidden");
    el.trainingDisplayDefault.classList.remove("hidden");
    
    trainingSamples = [];
    holdTimestamp = null;
    updateDrillUi();
    updateStatus();
    if (focus && visible() && ([el.cancelTrainingBtn, el.saveTrainingShotBtn, el.discardTrainingShotBtn].includes(focused)
        || hadFocus && focused === document.body)) {
      (el.startTrainingBtn.disabled ? el.trainingDrillSelect : el.startTrainingBtn)?.focus();
    }
  }

  return { destroy() {
    disposed = true;
    ++recommendationRequest;
    clearInterval(timerInterval);
    stopRendering();
    clearFinishTone();
    stopStore(); stopSamples(); stopViews(); stopSaved(); stopTraceSaved(); stopChanged();
    el.startTrainingBtn.removeEventListener("click", startSession);
    el.cancelTrainingBtn.removeEventListener("click", cancelSession);
    el.saveTrainingShotBtn.removeEventListener("click", saveSession);
    el.discardTrainingShotBtn.removeEventListener("click", discardSession);
    el.trainingDrillSelect?.removeEventListener("change", changeDrill);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", pageHidden);
    window.removeEventListener("pageshow", pageShown);
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("themechange", requestRender);
    window.removeEventListener("resize", resized);
  } };
}
