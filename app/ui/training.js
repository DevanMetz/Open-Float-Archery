// Steady Aim Training Game UI Module
// Manages the prep countdown, audio tones, live target tracing, scoring, and DB persistence.

import { put, generateUUID } from "../core/db.js?v=shot-store-98";
import { computeFloatScoreFromTrace } from "../telemetry/score.js?v=shot-store-99";

const TARGET_COLORS = ["#FFFFFF", "#1E1E1E", "#00B5E2", "#EE383E", "#FFE000"];

// Stats Helper Functions
function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

function getMaxFloatSpan(samples) {
  let maxDist = 0;
  // If we have a lot of samples, decimate for performance
  const step = Math.max(1, Math.floor(samples.length / 500));
  const pts = [];
  for (let i = 0; i < samples.length; i += step) {
    pts.push(samples[i]);
  }
  
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = (pts[i].roll || 0) - (pts[j].roll || 0);
      const dy = (pts[i].pitch || 0) - (pts[j].pitch || 0);
      const dist = Math.hypot(dx, dy);
      if (dist > maxDist) maxDist = dist;
    }
  }
  return maxDist;
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
  } catch (err) {
    console.warn("Failed to play audio tone:", err);
  }
}

export function mountTraining({ store, telemetry, el, bus }) {
  if (!el.trainingTargetCanvas) return;

  const ctx = el.trainingTargetCanvas.getContext("2d");
  
  // Game states: 'idle', 'countdown', 'holding', 'finished'
  let gameState = "idle";
  let countdownVal = 5;
  let remainingHoldTime = 10;
  let timerInterval = null;
  
  let refRoll = 0;
  let refPitch = 0;
  let trainingSamples = [];
  let currentHoldDuration = 10;
  let latestSampleTime = 0;

  // Render variables
  let liveDotRoll = null;
  let liveDotPitch = null;
  let liveTimerProgress = 0;

  // React to connection states in the reactive store
  store.subscribe((state) => {
    const connected = state.connected;
    
    if (el.startTrainingBtn) {
      el.startTrainingBtn.disabled = !connected || gameState !== "idle";
    }

    if (el.trainingStatusText && el.trainingStatusDesc) {
      if (connected) {
        el.trainingStatusText.textContent = state.statusMode === "demo" ? "Demo Mode" : "Connected";
        el.trainingStatusText.style.color = "var(--green)";
        el.trainingStatusDesc.textContent = "Bow sensor is streaming. Press start to train.";
      } else {
        el.trainingStatusText.textContent = "Disconnected";
        el.trainingStatusText.style.color = "var(--red)";
        el.trainingStatusDesc.textContent = "Connect a sensor or start demo mode to train.";
      }
    }

    // Live display updates during hold
    if (gameState === "holding" && state.sample) {
      liveDotRoll = state.roll;
      liveDotPitch = state.pitch;
      if (el.trainingCantBadge) {
        // Calculate calibrated cant
        const calRoll = state.roll - (state.cantOffset || 0);
        el.trainingCantBadge.textContent = `Cant: ${calRoll.toFixed(1)}°`;
        el.trainingCantBadge.style.color = Math.abs(calRoll) <= (state.levelTolerance || 2.0) ? "var(--green)" : "var(--amber)";
      }
    }
  });

  // Listen to raw samples from event bus to collect high-res trace data
  bus.on("sample", (sample) => {
    if (gameState !== "holding") return;
    
    const state = store.get();
    const now = performance.now();
    
    trainingSamples.push({
      roll: state.roll,
      pitch: state.pitch,
      yaw: state.yaw || 0,
      gx: sample.gxDps || 0,
      gy: sample.gyDps || 0,
      gz: sample.gzDps || 0,
      ax: (sample.axMg || 0) / 1000,
      ay: (sample.ayMg || 0) / 1000,
      az: (sample.azMg || 1000) / 1000,
      timestamp: now,
      micAmp: sample.micAmp || 0
    });
  });

  // Setup click listeners
  el.startTrainingBtn.addEventListener("click", startSession);
  el.cancelTrainingBtn.addEventListener("click", cancelSession);
  el.saveTrainingShotBtn.addEventListener("click", saveSession);
  el.discardTrainingShotBtn.addEventListener("click", discardSession);

  // Resize canvas handler
  function resizeCanvas() {
    const canvas = el.trainingTargetCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resizeCanvas);

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
    if (gameState === "idle") return;

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
      ctx.strokeStyle = "rgba(48, 227, 155, 0.85)"; // Hold green
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

      // Draw Live Position Dot
      if (liveDotRoll !== null) {
        const lx = cx + (liveDotRoll - refRoll) * scale;
        const ly = cy - (liveDotPitch - refPitch) * scale;
        
        ctx.fillStyle = "#35C7E8"; // Live indicator dot (cyan)
        ctx.beginPath();
        ctx.arc(lx, ly, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Crosshair for live dot
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx - 10, ly);
        ctx.lineTo(lx + 10, ly);
        ctx.moveTo(lx, ly - 10);
        ctx.lineTo(lx, ly + 10);
        ctx.stroke();
      }
    } else if (gameState === "finished" && trainingSamples.length >= 2) {
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
        ctx.fillStyle = "rgba(48, 227, 155, 0.12)";
        ctx.strokeStyle = "rgba(48, 227, 155, 0.55)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, ellipseData.radiusX, ellipseData.radiusY, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Draw Trace Path
      ctx.strokeStyle = "#30E39B"; // Green trace
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
      ctx.fillStyle = "#FF5D73";
      ctx.strokeStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (gameState === "holding" || gameState === "finished") {
      requestAnimationFrame(renderLoop);
    }
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
    if (gameState !== "idle") return;
    
    gameState = "countdown";
    countdownVal = 5;
    currentHoldDuration = Number(el.trainingDurationSelect.value);
    
    trainingSamples = [];
    
    // Toggle UI display
    el.trainingDisplayDefault.classList.add("hidden");
    el.trainingDisplayActive.classList.remove("hidden");
    el.trainingTargetWrapper.classList.add("hidden");
    el.trainingResultsCard.classList.add("hidden");
    
    el.startTrainingBtn.classList.add("hidden");
    el.cancelTrainingBtn.classList.remove("hidden");
    el.trainingDurationSelect.disabled = true;
    
    el.trainingCountdownVal.textContent = countdownVal;
    el.trainingPhaseLabel.textContent = "Draw Your Bow";
    el.trainingPhaseLabel.style.color = "var(--amber)";
    
    // Setup timer circle
    const progressCircle = el.timerProgress;
    progressCircle.style.stroke = "var(--amber)";
    progressCircle.style.strokeDashoffset = "0";
    
    playTone(440, 100); // initial beep
    
    timerInterval = setInterval(() => {
      countdownVal--;
      if (countdownVal > 0) {
        el.trainingCountdownVal.textContent = countdownVal;
        
        // Progress circle shrink
        const offset = 339.3 * (1 - countdownVal / 5);
        progressCircle.style.strokeDashoffset = offset;
        
        playTone(440, 100);
      } else {
        clearInterval(timerInterval);
        startHoldingPhase();
      }
    }, 1000);
  }

  function startHoldingPhase() {
    gameState = "holding";
    remainingHoldTime = currentHoldDuration;
    
    // Play loud hold tone
    playTone(880, 350);
    
    // Wire UI to target canvas
    el.trainingDisplayActive.classList.add("hidden");
    el.trainingTargetWrapper.classList.remove("hidden");
    
    el.trainingHoldTimerBadge.textContent = `${remainingHoldTime.toFixed(1)}s`;
    
    // Take reference offset
    const activeState = store.get();
    refRoll = activeState.roll;
    refPitch = activeState.pitch;
    
    // Clear live indicator variables
    liveDotRoll = activeState.roll;
    liveDotPitch = activeState.pitch;
    
    // Start drawing
    resizeCanvas();
    requestAnimationFrame(renderLoop);
    
    const startTime = performance.now();
    timerInterval = setInterval(() => {
      const elapsed = (performance.now() - startTime) / 1000;
      remainingHoldTime = Math.max(0, currentHoldDuration - elapsed);
      el.trainingHoldTimerBadge.textContent = `${remainingHoldTime.toFixed(1)}s`;
      
      if (remainingHoldTime <= 0) {
        clearInterval(timerInterval);
        finishHoldingPhase();
      }
    }, 100);
  }

  function finishHoldingPhase() {
    gameState = "finished";
    
    // Play happy double-beep
    playTone(660, 150);
    setTimeout(() => playTone(880, 250), 180);
    
    // Switch cancel button back to start button
    el.cancelTrainingBtn.classList.add("hidden");
    el.startTrainingBtn.classList.remove("hidden");
    el.startTrainingBtn.disabled = false;
    el.trainingDurationSelect.disabled = false;
    
    if (trainingSamples.length < 5) {
      alert("Hold sequence ended prematurely or no telemetry frames were received.");
      resetToIdle();
      return;
    }
    
    // Calculate Stats
    const rolls = trainingSamples.map((s) => s.roll);
    const pitches = trainingSamples.map((s) => s.pitch);
    const gyros = trainingSamples.map((s) => Math.hypot(s.gx || 0, s.gy || 0, s.gz || 0));
    
    const rollStd = stdDev(rolls);
    const pitchStd = stdDev(pitches);
    const avgGyroMag = mean(gyros);
    
    // Calculate steadiness score (using standard deviation + angular velocity)
    const steadinessScore = Math.round(
      Math.max(0, Math.min(100, 100 - (rollStd + pitchStd) * 18 - avgGyroMag * 0.7))
    );
    
    const avgCantDev = rollStd;
    const avgPitchDev = pitchStd;
    const maxFloat = getMaxFloatSpan(trainingSamples);
    
    // Populate Results
    el.resultSteadinessScore.textContent = steadinessScore;
    el.resultAvgCantDev.textContent = `${avgCantDev.toFixed(2)}°`;
    el.resultAvgPitchDev.textContent = `${avgPitchDev.toFixed(2)}°`;
    el.resultMaxFloat.textContent = `${maxFloat.toFixed(2)}°`;
    
    // Coaching tip
    let coachTitle = "";
    let coachText = "";
    if (steadinessScore >= 90) {
      coachTitle = "Elite Stability";
      coachText = "Outstanding control! Your float is exceptionally tight. Maintain this solid posture in your practice.";
    } else if (steadinessScore >= 80) {
      coachTitle = "Strong Foundation";
      coachText = "Great hold. Your movement is well within the gold rings. Focus on a relaxed draw-arm shoulder to shrink the group further.";
    } else if (steadinessScore >= 65) {
      coachTitle = "Developing Float";
      coachText = "Decent stability, but showing some wander. Try settling into your skeletal stack before starting your aim sequence.";
    } else {
      coachTitle = "Settle the Stance";
      coachText = "Significant movement detected. Ensure you are not muscle-holding the weight. Align your posture and relax your grip.";
    }
    
    el.resultCoachingTitle.textContent = coachTitle;
    el.resultCoachingText.textContent = coachText;
    
    // Open results card
    el.trainingResultsCard.classList.remove("hidden");
  }

  async function saveSession() {
    if (trainingSamples.length === 0) return;
    
    el.saveTrainingShotBtn.disabled = true;
    el.saveTrainingShotBtn.textContent = "Saving...";
    
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
      
      const sessionShotId = generateUUID();
      const timestamp = new Date().toISOString();
      const label = `Steady Aim Hold (${currentHoldDuration}s)`;
      const traceForScore = trainingSamples.map((s) => ({
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
      }));
      const floatScore = computeFloatScoreFromTrace(traceForScore, { sampleRateHz: 52 });
      
      const shotRecord = {
        id: sessionShotId,
        session_id: null,
        device_id: "OpenFloat-Sensor",
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
      
      await put("shots", shotRecord);
      await put("sync_queue", {
        table: "shots",
        action: "CREATE",
        targetId: sessionShotId,
        payload: shotRecord,
        status: "pending"
      });
      
      const tracePayload = {
        shot_id: sessionShotId,
        sample_rate_hz: 52,
        payload: traceForScore
      };
      
      await put("shot_traces", tracePayload);
      await put("sync_queue", {
        table: "shot_traces",
        action: "CREATE",
        targetId: sessionShotId,
        payload: tracePayload,
        status: "pending"
      });
      
      bus.emit("log", `Steady Aim training session saved successfully (ID: ${sessionShotId.slice(0, 8)}).`);
      
      // Notify main app to refresh history list & recent shots
      bus.emit("shot-saved", {
        shotId: null,
        stored: false,
        localShotId: sessionShotId
      });
      
      bus.emit("shot-trace-saved", {
        localShotId: sessionShotId,
        deviceShotId: null
      });
      
      // Clear results and go back to default screen
      resetToIdle();
      alert("Training session shot saved successfully!");
    } catch (err) {
      console.error("Failed to save training shot:", err);
      bus.emit("log", `Failed to save training shot: ${err.message}`);
      alert(`Error saving training shot: ${err.message}`);
    } finally {
      el.saveTrainingShotBtn.disabled = false;
      el.saveTrainingShotBtn.textContent = "Save Session Shot";
    }
  }

  function cancelSession() {
    if (gameState !== "countdown" && gameState !== "holding") return;
    
    clearInterval(timerInterval);
    bus.emit("log", "Steady Aim Training session cancelled.");
    resetToIdle();
  }

  function discardSession() {
    resetToIdle();
  }

  function resetToIdle() {
    gameState = "idle";
    clearInterval(timerInterval);
    
    // Reset buttons and controls
    el.cancelTrainingBtn.classList.add("hidden");
    el.startTrainingBtn.classList.remove("hidden");
    el.startTrainingBtn.disabled = !store.get().connected;
    el.trainingDurationSelect.disabled = false;
    
    // Hide panels
    el.trainingDisplayActive.classList.add("hidden");
    el.trainingTargetWrapper.classList.add("hidden");
    el.trainingResultsCard.classList.add("hidden");
    el.trainingDisplayDefault.classList.remove("hidden");
    
    trainingSamples = [];
  }
}
