// Bow Stability Comparison & Analysis Dashboard module for OpenFloat.
// Handles dropdown population, statistics aggregation, and rendering overlays.

import { getAll, get } from "../core/db.js";

// Helper stats functions
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  const variance = arr.reduce((sum, val) => sum + (val - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function findReleaseIndex(data, thresholdG = 12.0) {
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
  return {
    releaseIdx,
    hasRelease: maxG > thresholdG,
  };
}

function getHoldWindow(trace, releaseIdx, hasRelease) {
  if (!trace.length) return [];
  if (!hasRelease) return trace;
  const releaseStart = Math.max(5, releaseIdx - Math.max(6, Math.round(trace.length * 0.03)));
  return trace.slice(0, releaseStart);
}

function getHoldAverage(trace, releaseIdx, hasRelease) {
  const holdData = getHoldWindow(trace, releaseIdx, hasRelease);
  if (!holdData.length) return { roll: 0, pitch: 0 };
  const sumRoll = holdData.reduce((s, p) => s + (p.roll || 0), 0);
  const sumPitch = holdData.reduce((s, p) => s + (p.pitch || 0), 0);
  return {
    roll: sumRoll / holdData.length,
    pitch: sumPitch / holdData.length
  };
}

function getMaxDeviation(trace, center, releaseIdx, hasRelease) {
  const holdData = getHoldWindow(trace, releaseIdx, hasRelease);
  let maxDev = 1.0;
  for (const pt of holdData) {
    const dx = (pt.roll || 0) - center.roll;
    const dy = (pt.pitch || 0) - center.pitch;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDev) maxDev = dist;
  }
  return maxDev;
}

function calculateStabilityAt(trace, index) {
  const windowSize = 52; // 1 second window
  const start = Math.max(0, index - windowSize + 1);
  const slice = trace.slice(start, index + 1);
  if (slice.length < 2) return 100;

  const rolls = slice.map(pt => pt.roll || 0);
  const pitches = slice.map(pt => pt.pitch || 0);

  const rollStd = stdDev(rolls);
  const pitchStd = stdDev(pitches);

  const gyroMag = Math.hypot(trace[index].gx || 0, trace[index].gy || 0, trace[index].gz || 0);

  // Exact hold stability formula
  const holdStability = 100 - (rollStd + pitchStd) * 18 - gyroMag * 0.7;
  return Math.max(0, Math.min(100, holdStability));
}

export function mountAnalysis(bus, store, el) {
  let activeTab = "float"; // 'float' or 'timeline'
  let shotDataA = null;
  let shotDataB = null;

  // Replay, Scrub, and Zoom States
  let replayActive = false;
  let replayPaused = false;
  let replayProgress = 1.0;
  let traceZoom = 1.0;
  let animationFrameId = null;

  const ctx = el.compareCanvas.getContext("2d");
  const legendA = el.compareChartCard.querySelector(".legend-item:first-child");
  const legendB = el.compareChartCard.querySelector(".legend-item:last-child");

  // Load and refresh lists when entering tab
  bus.on("view-changed", async (tabId) => {
    stopReplay();
    if (tabId === "tabAnalysis") {
      await refreshBowSelections();
    }
  });

  el.compareBowASelect.addEventListener("change", () => {
    stopReplay();
    handleBowSelectionChange("A");
  });
  
  el.compareBowBSelect.addEventListener("change", () => {
    stopReplay();
    handleBowSelectionChange("B");
  });

  el.compareViewFloatBtn.addEventListener("click", () => {
    activeTab = "float";
    el.compareViewFloatBtn.classList.add("active");
    el.compareViewTimelineBtn.classList.remove("active");
    draw();
    updateScrubberReadout();
  });

  el.compareViewTimelineBtn.addEventListener("click", () => {
    activeTab = "timeline";
    el.compareViewTimelineBtn.classList.add("active");
    el.compareViewFloatBtn.classList.remove("active");
    draw();
    updateScrubberReadout();
  });

  el.runCompareBtn.addEventListener("click", () => {
    stopReplay();
    handleRunComparison();
  });

  // Replay, Scrub, and Zoom Listeners
  el.compareReplayBtn.addEventListener("click", () => {
    if (replayActive && !replayPaused) {
      replayPaused = true;
      el.compareReplayBtn.textContent = "Resume";
      return;
    }

    const durationMs = 1800; // Plays back over 1.8 seconds, matching review mode
    const startProgress = replayProgress >= 1 ? 0 : replayProgress;
    const startedAt = performance.now() - startProgress * durationMs;

    replayActive = true;
    replayPaused = false;
    replayProgress = startProgress;
    el.compareReplayBtn.textContent = "Pause";

    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    function tick(now) {
      if (replayPaused) return;

      replayProgress = Math.min(1, (now - startedAt) / durationMs);
      el.compareScrubSlider.value = Math.round(replayProgress * 1000);
      updateScrubberReadout();

      if (replayProgress >= 1) {
        replayActive = false;
        el.compareReplayBtn.textContent = "Replay";
        draw();
      } else {
        draw();
        animationFrameId = requestAnimationFrame(tick);
      }
    }

    animationFrameId = requestAnimationFrame(tick);
  });

  el.compareScrubSlider.addEventListener("input", () => {
    replayActive = false;
    replayPaused = false;
    replayProgress = Number(el.compareScrubSlider.value) / 1000;
    el.compareReplayBtn.textContent = "Replay";
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    updateScrubberReadout();
    draw();
  });

  el.compareZoomOutBtn.addEventListener("click", () => {
    traceZoom = Math.max(0.4, Number((traceZoom - 0.2).toFixed(1)));
    el.compareZoomValue.textContent = `${traceZoom.toFixed(1)}x`;
    draw();
  });

  el.compareZoomInBtn.addEventListener("click", () => {
    traceZoom = Math.min(3.0, Number((traceZoom + 0.2).toFixed(1)));
    el.compareZoomValue.textContent = `${traceZoom.toFixed(1)}x`;
    draw();
  });

  window.addEventListener("resize", resize);

  function stopReplay() {
    replayActive = false;
    replayPaused = false;
    replayProgress = 1.0;
    traceZoom = 1.0;
    el.compareScrubSlider.value = 1000;
    el.compareZoomValue.textContent = "1.0x";
    el.compareReplayBtn.textContent = "Replay";
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    updateScrubberReadout();
  }

  function updateScrubberReadout() {
    const p = replayProgress;
    if (activeTab === "timeline") {
      const t = ((p - 1) * 5.0).toFixed(1);
      el.compareScrubValue.textContent = `${t}s`;
    } else {
      const tA = shotDataA ? ((p - 1) * (getHoldWindow(shotDataA.trace, findReleaseIndex(shotDataA.trace, shotDataA.shot.threshold_g || 12.0).releaseIdx, true).length / 52)).toFixed(1) : "-0.0";
      const tB = shotDataB ? ((p - 1) * (getHoldWindow(shotDataB.trace, findReleaseIndex(shotDataB.trace, shotDataB.shot.threshold_g || 12.0).releaseIdx, true).length / 52)).toFixed(1) : "-0.0";
      if (shotDataA && shotDataB) {
        el.compareScrubValue.textContent = `A: ${tA}s | B: ${tB}s`;
      } else if (shotDataA) {
        el.compareScrubValue.textContent = `${tA}s`;
      } else if (shotDataB) {
        el.compareScrubValue.textContent = `${tB}s`;
      } else {
        el.compareScrubValue.textContent = "0.0s";
      }
    }
    updateLegendText();
  }

  function updateLegendText() {
    const p = replayProgress;
    let labelA = "Setup A Shot";
    let labelB = "Setup B Shot";

    if (shotDataA) {
      const { releaseIdx, hasRelease } = findReleaseIndex(shotDataA.trace, shotDataA.shot.threshold_g || 12.0);
      const holdA = getHoldWindow(shotDataA.trace, releaseIdx, hasRelease);
      let idxA;
      if (activeTab === "timeline") {
        const timeOffset = (p - 1) * 5.0;
        idxA = Math.max(0, releaseIdx + Math.round(timeOffset * 52));
      } else {
        idxA = Math.min(holdA.length - 1, Math.floor(p * (holdA.length - 1)));
      }
      const instStabilityA = Math.round(calculateStabilityAt(shotDataA.trace, idxA));
      labelA = `${shotDataA.shot.label || "Setup A Shot"} (${instStabilityA}%)`;
    }

    if (shotDataB) {
      const { releaseIdx, hasRelease } = findReleaseIndex(shotDataB.trace, shotDataB.shot.threshold_g || 12.0);
      const holdB = getHoldWindow(shotDataB.trace, releaseIdx, hasRelease);
      let idxB;
      if (activeTab === "timeline") {
        const timeOffset = (p - 1) * 5.0;
        idxB = Math.max(0, releaseIdx + Math.round(timeOffset * 52));
      } else {
        idxB = Math.min(holdB.length - 1, Math.floor(p * (holdB.length - 1)));
      }
      const instStabilityB = Math.round(calculateStabilityAt(shotDataB.trace, idxB));
      labelB = `${shotDataB.shot.label || "Setup B Shot"} (${instStabilityB}%)`;
    }

    if (legendA) legendA.innerHTML = `<span class="legend-dot" style="background: var(--green);"></span> ${labelA}`;
    if (legendB) legendB.innerHTML = `<span class="legend-dot" style="background: var(--cyan);"></span> ${labelB}`;
  }

  async function refreshBowSelections() {
    try {
      const bows = await getAll("bow_profiles");
      
      const bowAVal = el.compareBowASelect.value;
      const bowBVal = el.compareBowBSelect.value;

      const defaultOptions = '<option value="">Default Bow</option>';
      const customOptions = bows.map(b => `<option value="${b.id}">${b.model}${b.draw_weight ? ` (${b.draw_weight} lbs)` : ""}</option>`).join("");

      el.compareBowASelect.innerHTML = defaultOptions + customOptions;
      el.compareBowBSelect.innerHTML = defaultOptions + customOptions;

      // Restore selections
      if ([...el.compareBowASelect.options].some(opt => opt.value === bowAVal)) {
        el.compareBowASelect.value = bowAVal;
      }
      if ([...el.compareBowBSelect.options].some(opt => opt.value === bowBVal)) {
        el.compareBowBSelect.value = bowBVal;
      }

      await handleBowSelectionChange("A");
      await handleBowSelectionChange("B");
    } catch (err) {
      console.error("Failed to load bow profiles in analysis", err);
    }
  }

  async function handleBowSelectionChange(column) {
    const bowSelect = column === "A" ? el.compareBowASelect : el.compareBowBSelect;
    const shotSelect = column === "A" ? el.compareShotASelect : el.compareShotBSelect;
    const bowId = bowSelect.value;

    try {
      // 1. Get filtered sessions
      const sessions = await getAll("sessions");
      const filteredSessions = sessions.filter(s => {
        if (!bowId) return !s.bow_profile_id;
        return s.bow_profile_id === bowId;
      });
      const sessionIds = new Set(filteredSessions.map(s => s.id));

      // 2. Get filtered shots
      const shots = await getAll("shots");
      const filteredShots = shots.filter(s => {
        const sid = s.session_id || "legacy";
        if (sid === "legacy") return !bowId; // Group legacy shots with default bow
        return sessionIds.has(sid);
      });

      // Sort newest first
      filteredShots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // 3. Populate Shot select
      if (filteredShots.length === 0) {
        shotSelect.innerHTML = '<option value="">No shots for this bow setup</option>';
      } else {
        shotSelect.innerHTML = '<option value="">Select a shot...</option>' + 
          filteredShots.map(s => {
            const timeStr = new Date(s.timestamp).toLocaleString();
            const score = s.shot_score != null ? Math.round(s.shot_score) : Math.round(s.stability_score || 0);
            const label = s.label || (s.peak_g > 15 ? "Arrow" : "Hold");
            return `<option value="${s.id}">${label} - ${timeStr} (Score: ${score})</option>`;
          }).join("");
      }
    } catch (err) {
      console.error("Failed to load shots for bow setup", err);
    }
  }

  async function handleRunComparison() {
    const bowIdA = el.compareBowASelect.value;
    const bowIdB = el.compareBowBSelect.value;
    const shotIdA = el.compareShotASelect.value;
    const shotIdB = el.compareShotBSelect.value;

    // 1. Load comparison averages
    await calculateAverages(bowIdA, bowIdB);

    // 2. Load selected shot traces for overlay
    shotDataA = null;
    shotDataB = null;

    if (shotIdA) {
      const shot = await get("shots", shotIdA);
      const trace = await get("shot_traces", shotIdA);
      if (shot && trace && trace.payload) {
        shotDataA = { shot, trace: trace.payload };
      }
    }
    if (shotIdB) {
      const shot = await get("shots", shotIdB);
      const trace = await get("shot_traces", shotIdB);
      if (shot && trace && trace.payload) {
        shotDataB = { shot, trace: trace.payload };
      }
    }

    if (shotDataA || shotDataB) {
      el.compareChartCard.classList.remove("hidden");
      resize();
      draw();
      updateScrubberReadout();
    } else {
      el.compareChartCard.classList.add("hidden");
    }
  }

  async function calculateAverages(bowIdA, bowIdB) {
    try {
      const sessions = await getAll("sessions");
      const shots = await getAll("shots");

      const getStatsForBow = (bowId) => {
        const filteredSessions = sessions.filter(s => !bowId ? !s.bow_profile_id : s.bow_profile_id === bowId);
        const sessionIds = new Set(filteredSessions.map(s => s.id));
        const filteredShots = shots.filter(s => {
          const sid = s.session_id || "legacy";
          if (sid === "legacy") return !bowId;
          return sessionIds.has(sid);
        });

        if (filteredShots.length === 0) return null;

        const holdScores = filteredShots.map(s => s.hold_stability != null ? s.hold_stability : s.stability_score).filter(v => v != null);
        const releaseScores = filteredShots.map(s => s.release_quality).filter(v => v != null);
        const followScores = filteredShots.map(s => s.follow_through).filter(v => v != null);
        const formScores = filteredShots.map(s => s.shot_score != null ? s.shot_score : s.stability_score).filter(v => v != null);

        return {
          hold: holdScores.length ? Math.round(mean(holdScores)) : null,
          release: releaseScores.length ? Math.round(mean(releaseScores)) : null,
          follow: followScores.length ? Math.round(mean(followScores)) : null,
          form: formScores.length ? Math.round(mean(formScores)) : null
        };
      };

      const statsA = getStatsForBow(bowIdA);
      const statsB = getStatsForBow(bowIdB);

      el.compareHoldAVal.textContent = statsA && statsA.hold != null ? `${statsA.hold}%` : "--";
      el.compareHoldBVal.textContent = statsB && statsB.hold != null ? `${statsB.hold}%` : "--";

      el.compareReleaseAVal.textContent = statsA && statsA.release != null ? `${statsA.release}%` : "--";
      el.compareReleaseBVal.textContent = statsB && statsB.release != null ? `${statsB.release}%` : "--";

      el.compareFollowAVal.textContent = statsA && statsA.follow != null ? `${statsA.follow}%` : "--";
      el.compareFollowBVal.textContent = statsB && statsB.follow != null ? `${statsB.follow}%` : "--";

      el.compareFormAVal.textContent = statsA && statsA.form != null ? String(statsA.form) : "--";
      el.compareFormBVal.textContent = statsB && statsB.form != null ? String(statsB.form) : "--";

      el.compareStatsPanel.classList.remove("hidden");
    } catch (err) {
      console.error("Failed to compute stats comparison", err);
    }
  }

  function resize() {
    if (el.compareCanvas.offsetParent === null) return; // Canvas is hidden
    const rect = el.compareCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.compareCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    el.compareCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    if (el.compareCanvas.offsetParent === null) return;
    const rect = el.compareCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    if (activeTab === "float") {
      drawAimFloatOverlay(w, h);
    } else {
      drawStabilityTimelineOverlay(w, h);
    }
  }

  function drawAimFloatOverlay(w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = Math.min(w, h) * 0.45;

    // 1. Draw target background
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

    // 2. Overlay traces
    let centerA = null;
    let centerB = null;
    let devA = 0.1;
    let devB = 0.1;

    let releaseIdxA = 0, hasReleaseA = false;
    let releaseIdxB = 0, hasReleaseB = false;

    if (shotDataA) {
      const { releaseIdx, hasRelease } = findReleaseIndex(shotDataA.trace, shotDataA.shot.threshold_g || 12.0);
      releaseIdxA = releaseIdx;
      hasReleaseA = hasRelease;
      centerA = getHoldAverage(shotDataA.trace, releaseIdx, hasRelease);
      devA = getMaxDeviation(shotDataA.trace, centerA, releaseIdx, hasRelease);
    }

    if (shotDataB) {
      const { releaseIdx, hasRelease } = findReleaseIndex(shotDataB.trace, shotDataB.shot.threshold_g || 12.0);
      releaseIdxB = releaseIdx;
      hasReleaseB = hasRelease;
      centerB = getHoldAverage(shotDataB.trace, releaseIdx, hasRelease);
      devB = getMaxDeviation(shotDataB.trace, centerB, releaseIdx, hasRelease);
    }

    const maxDev = Math.max(devA, devB);
    const scale = (maxRadius / maxDev) * 0.85 * traceZoom;

    const drawPath = (trace, center, releaseIdx, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      
      const holdData = getHoldWindow(trace, releaseIdx, true);
      const limit = Math.max(2, Math.ceil(holdData.length * replayProgress));
      const visiblePoints = holdData.slice(0, limit);

      for (let i = 0; i < visiblePoints.length; i++) {
        const pt = visiblePoints[i];
        const x = cx + ((pt.roll || 0) - center.roll) * scale;
        const y = cy - ((pt.pitch || 0) - center.pitch) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw release pin dot
      if (visiblePoints.length > 0) {
        const finalPt = visiblePoints[visiblePoints.length - 1];
        const x = cx + ((finalPt.roll || 0) - center.roll) * scale;
        const y = cy - ((finalPt.pitch || 0) - center.pitch) * scale;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };

    if (shotDataA && centerA) {
      drawPath(shotDataA.trace, centerA, releaseIdxA, "#30E39B"); // Green
    }
    if (shotDataB && centerB) {
      drawPath(shotDataB.trace, centerB, releaseIdxB, "#35C7E8"); // Cyan
    }
  }

  function drawStabilityTimelineOverlay(w, h) {
    const padding = 45;
    const chartW = w - 2 * padding;
    const chartH = h - 2 * padding;

    // 1. Draw Grid lines and background
    ctx.strokeStyle = "rgba(142, 166, 160, 0.15)";
    ctx.lineWidth = 1;

    // Y Axis lines (0% to 100% stability)
    for (let percent = 0; percent <= 100; percent += 20) {
      const y = padding + (1.0 - percent / 100) * chartH;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(w - padding, y);
      ctx.stroke();

      ctx.fillStyle = "rgba(230, 244, 239, 0.6)";
      ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(`${percent}%`, padding - 8, y);
    }

    // X Axis lines (-5s to 0s release point)
    for (let s = -5; s <= 0; s++) {
      const x = padding + ((s + 5) / 5) * chartW;
      ctx.beginPath();
      ctx.moveTo(x, padding);
      ctx.lineTo(x, h - padding);
      ctx.stroke();

      ctx.fillStyle = "rgba(230, 244, 239, 0.6)";
      ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(s === 0 ? "Release" : `${s}s`, x, h - padding + 8);
    }

    // 2. Draw Stability Curves
    const drawCurve = (trace, color, thresholdG = 12.0) => {
      const { releaseIdx } = findReleaseIndex(trace, thresholdG);
      const points = [];

      // Calculate sliding stability leading up to release index (up to 5 seconds / 260 samples)
      const lookbackSamples = 260; 
      const startIdx = Math.max(52, releaseIdx - lookbackSamples);

      for (let i = startIdx; i <= releaseIdx; i++) {
        const stability = calculateStabilityAt(trace, i);
        const timeOffset = (i - releaseIdx) / 52; // relative time (e.g. -5.0s to 0.0s)
        if (timeOffset >= -5.0) {
          points.push({ time: timeOffset, stability });
        }
      }

      if (points.length < 2) return;

      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();

      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const x = padding + ((pt.time + 5.0) / 5.0) * chartW;
        const y = padding + (1.0 - pt.stability / 100) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (shotDataA) {
      drawCurve(shotDataA.trace, "#30E39B", shotDataA.shot.threshold_g || 12.0);
    }
    if (shotDataB) {
      drawCurve(shotDataB.trace, "#35C7E8", shotDataB.shot.threshold_g || 12.0);
    }

    // 3. Draw vertical scrub cursor
    const xCursor = padding + replayProgress * chartW;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xCursor, padding);
    ctx.lineTo(xCursor, h - padding);
    ctx.stroke();
  }
}
