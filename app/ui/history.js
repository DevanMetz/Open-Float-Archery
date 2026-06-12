// Shot history, review, recent shots, and deletion UI module.

import { getAll, get, put, remove, groupShotsByTime, SESSION_GAP_MS } from "../core/db.js?v=shot-store-125";
import { coachForScore } from "../telemetry/telemetry.js?v=shot-store-125";
import { resolveReviewMicSeries } from "../protocol/trace.js?v=shot-store-125";
import { drawEmptyTargetPreview, drawTraceTargetPreview, watchTracePreviewResize } from "./trace-preview.js?v=shot-store-125";
import { buildSessionFloatPlot, buildSessionReview } from "./session-review.js?v=shot-store-125";

export function initHistory({ bus, store, state, el, syncAdapter, selectViewTab }) {
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
            if (e.target.closest(".history-item-delete-btn") || e.target.closest(".history-item-export-btn")) return;
            
            const isSelectMode = el.historyBulkActions && !el.historyBulkActions.classList.contains("hidden");
            if (isSelectMode) {
              e.stopPropagation();
              const chk = item.querySelector(".history-item-checkbox");
              if (chk && e.target !== chk) {
                chk.checked = !chk.checked;
                updateBulkSelectCount();
              }
              return;
            }
            
            e.stopPropagation();
            reviewShotTrace(shot);
          });
          const deleteBtn = item.querySelector(".history-item-delete-btn");
          deleteBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteSavedShot(shot.id);
          });
          const exportBtn = item.querySelector(".history-item-export-btn");
          exportBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            exportSingleShot(shot.id);
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

  async function getActiveArrowSpeed() {
    const activeBowId = localStorage.getItem("openfloat_active_bow_id");
    if (activeBowId) {
      try {
        const profile = await get("bow_profiles", activeBowId);
        if (profile && profile.arrow_speed != null) {
          return Number(profile.arrow_speed);
        }
      } catch (error) {
        console.error("Error getting active bow speed:", error);
      }
    }
    return 280; // Fallback default speed
  }

  function estimateShotRange(trace, sampleRateHz, bowSpeedFps) {
    if (!trace || !trace.payload || trace.payload.length === 0) return null;
    const payload = trace.payload;
    const hz = sampleRateHz || 52;

    const getG = (f) => Math.sqrt((f.ax || 0) ** 2 + (f.ay || 0) ** 2 + (f.az || 0) ** 2);

    const getTimeMs = (idx) => {
      const f = payload[idx];
      if (f.tUs !== undefined) return f.tUs / 1000.0;
      return (idx * 1000.0) / hz;
    };

    let maxIdx = -1;
    let maxG = -1;
    for (let i = 0; i < payload.length; i++) {
      const g = getG(payload[i]);
      if (g > maxG) {
        maxG = g;
        maxIdx = i;
      }
    }

    if (maxG < 4.0 || maxIdx === -1) {
      return null;
    }

    const maxTime = getTimeMs(maxIdx);

    let releaseIdx = maxIdx;
    while (releaseIdx > 0) {
      if (getG(payload[releaseIdx]) <= 1.25) {
        break;
      }
      releaseIdx--;
    }

    const releaseTime = getTimeMs(releaseIdx);

    let searchStartIdx = -1;
    for (let i = releaseIdx; i < payload.length; i++) {
      if (getTimeMs(i) >= maxTime + 200) {
        searchStartIdx = i;
        break;
      }
    }

    if (searchStartIdx === -1) {
      return null;
    }

    let firstAbove15Idx = -1;
    for (let i = searchStartIdx; i < payload.length; i++) {
      const dt = getTimeMs(i) - releaseTime;
      if (dt > 2200) {
        break;
      }
      if ((payload[i].micAmp || 0) > 15) {
        firstAbove15Idx = i;
        break;
      }
    }

    if (firstAbove15Idx === -1) {
      return null;
    }

    let bestPeakIdx = firstAbove15Idx;
    let maxMic = payload[firstAbove15Idx].micAmp || 0;
    for (let i = firstAbove15Idx + 1; i < payload.length; i++) {
      const dt = getTimeMs(i) - releaseTime;
      if (dt > 2200) break;
      const mic = payload[i].micAmp || 0;
      if (mic <= 15) break;
      if (mic > maxMic) {
        maxMic = mic;
        bestPeakIdx = i;
      }
    }

    let hitIdx = bestPeakIdx;
    while (hitIdx > searchStartIdx && (payload[hitIdx].micAmp || 0) >= 10) {
      hitIdx--;
    }

    const hitTime = getTimeMs(hitIdx);
    const totalTimeSec = (hitTime - releaseTime) / 1000.0;
    if (totalTimeSec <= 0) return null;

    const V_sound = 1125.0;
    const b = 0.075;
    const A = b;
    const B = -(V_sound + bowSpeedFps + totalTimeSec * b * V_sound);
    const C = totalTimeSec * bowSpeedFps * V_sound;

    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return null;

    const distanceFt = (-B - Math.sqrt(discriminant)) / (2 * A);
    if (distanceFt <= 0) return null;

    return {
      yards: distanceFt / 3.0,
      feet: distanceFt,
      releaseIdx,
      releaseTime,
      hitIdx,
      hitTime
    };
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

      const speed = await getActiveArrowSpeed();
      const range = estimateShotRange(trace, trace.sample_rate_hz || 52, speed);
      const rangeText = range 
        ? `| Est. Range: ${range.yards.toFixed(1)} yds (${Math.round(range.feet)} ft) @ ${speed} fps`
        : "";

      store.set({
        reviewMode: true,
        reviewShotId: shot.id,
        reviewTrace: trace.payload,
        reviewMicSeries: resolveReviewMicSeries(trace, trace.sample_rate_hz || 52),
        reviewSampleRateHz: trace.sample_rate_hz || 52,
        reviewThresholdG: shot.threshold_g != null ? Number(shot.threshold_g) : 12,
        reviewInfo: info,
        reviewRangeEst: rangeText,
        reviewReleaseIdx: range ? range.releaseIdx : null,
        reviewReleaseTimeMs: range ? range.releaseTime : null,
        reviewHitIdx: range ? range.hitIdx : null,
        reviewHitTimeMs: range ? range.hitTime : null,
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
      reviewRangeEst: "",
      reviewReleaseIdx: null,
      reviewReleaseTimeMs: null,
      reviewHitIdx: null,
      reviewHitTimeMs: null,
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

  async function exportSingleShot(shotId) {
    try {
      const shot = await get("shots", shotId);
      if (!shot) {
        alert("Shot not found in database.");
        return;
      }
      const trace = await get("shot_traces", shotId);
      
      const payload = {
        format: "openfloat-shot-export",
        version: 1,
        exportedAt: new Date().toISOString(),
        shot,
        trace
      };

      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date(shot.timestamp).toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const a = document.createElement("a");
      a.href = url;
      a.download = `openfloat-shot-${shotId.slice(0, 8)}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      
      bus.emit("log", `Exported single shot ${shotId.slice(0, 8)} successfully.`);
    } catch (error) {
      console.error("Single shot export failed:", error);
      alert(`Failed to export shot: ${error.message}`);
    }
  }

  if (el.exportShotBtn) {
    el.exportShotBtn.addEventListener("click", () => {
      const currentShotId = store.get().reviewShotId;
      if (currentShotId) {
        exportSingleShot(currentShotId);
      } else {
        alert("No shot is currently being reviewed.");
      }
    });
  }

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

    const isSelectMode = el.historyBulkActions && !el.historyBulkActions.classList.contains("hidden");
    const chkClass = isSelectMode ? "history-item-checkbox" : "history-item-checkbox hidden";

    const timestampStr = new Date(shot.timestamp).toLocaleTimeString();
    const title = shot.label || (shot.peak_g > 15 ? "Arrow Release" : "Hold Capture");
    const score = shot.shot_score != null ? Math.round(shot.shot_score) : Math.round(shot.stability_score || 0);
    const stability =
      shot.stability_score != null ? Math.round(shot.stability_score) : "--";
    const peakG = Number.isFinite(Number(shot.peak_g)) ? Number(shot.peak_g).toFixed(1) : "--";

    item.innerHTML = `
      <input type="checkbox" class="${chkClass}" data-shot-id="${shot.id}" type="checkbox">
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
          class="history-item-export-btn mini-icon-btn"
          title="Export shot to JSON"
          aria-label="Export shot"
        >📤</button>
        <button
          type="button"
          class="history-item-delete-btn mini-icon-btn"
          title="Delete shot"
          aria-label="Delete shot"
        >🗑</button>
      </div>
    `;
    const chk = item.querySelector(".history-item-checkbox");
    chk?.addEventListener("click", (e) => {
      e.stopPropagation();
      updateBulkSelectCount();
    });
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
          reviewRangeEst: "",
          reviewReleaseIdx: null,
          reviewReleaseTimeMs: null,
          reviewHitIdx: null,
          reviewHitTimeMs: null,
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

  // History list bulk select & delete feature
  function updateBulkSelectCount() {
    if (!el.historyList) return;
    const checkboxes = el.historyList.querySelectorAll(".history-item-checkbox");
    let selectedCount = 0;
    checkboxes.forEach((chk) => {
      if (chk.checked) selectedCount++;
    });
    if (el.bulkSelectCount) {
      el.bulkSelectCount.textContent = `${selectedCount} selected`;
    }
  }

  if (el.historySelectModeBtn) {
    el.historySelectModeBtn.addEventListener("click", () => {
      if (el.historyDefaultActions) el.historyDefaultActions.classList.add("hidden");
      if (el.historyBulkActions) el.historyBulkActions.classList.remove("hidden");
      
      // Show all checkboxes in history list
      if (el.historyList) {
        el.historyList.querySelectorAll(".history-item-checkbox").forEach((chk) => {
          chk.classList.remove("hidden");
          chk.checked = false;
        });
      }
      updateBulkSelectCount();
    });
  }

  if (el.bulkCancelBtn) {
    el.bulkCancelBtn.addEventListener("click", () => {
      if (el.historyBulkActions) el.historyBulkActions.classList.add("hidden");
      if (el.historyDefaultActions) el.historyDefaultActions.classList.remove("hidden");
      
      // Hide all checkboxes and uncheck them
      if (el.historyList) {
        el.historyList.querySelectorAll(".history-item-checkbox").forEach((chk) => {
          chk.classList.add("hidden");
          chk.checked = false;
        });
      }
      updateBulkSelectCount();
    });
  }

  if (el.bulkSelectAllBtn) {
    el.bulkSelectAllBtn.addEventListener("click", () => {
      if (!el.historyList) return;
      const checkboxes = el.historyList.querySelectorAll(".history-item-checkbox");
      const allChecked = Array.from(checkboxes).every((chk) => chk.checked);
      checkboxes.forEach((chk) => {
        chk.checked = !allChecked;
      });
      updateBulkSelectCount();
    });
  }

  if (el.bulkDeleteBtn) {
    el.bulkDeleteBtn.addEventListener("click", async () => {
      if (!el.historyList) return;
      const checkboxes = el.historyList.querySelectorAll(".history-item-checkbox");
      const selectedIds = Array.from(checkboxes)
        .filter((chk) => chk.checked)
        .map((chk) => chk.dataset.shotId);

      if (selectedIds.length === 0) {
        alert("No shots selected for deletion.");
        return;
      }

      const confirmed = confirm(
        `Delete ${selectedIds.length} selected shot${selectedIds.length > 1 ? "s" : ""}?\n\nThis cannot be undone.`,
      );
      if (!confirmed) return;

      try {
        bus.emit("log", `Bulk deleting ${selectedIds.length} shots...`);
        
        const state = store.get();
        let reviewClosed = false;
        let compareClosed = false;
        
        for (const shotId of selectedIds) {
          await purgeSyncQueueForShot(shotId);
          try {
            await remove("shot_traces", shotId);
          } catch (_) {}
          await remove("shots", shotId);

          try {
            const override = await get("session_overrides", shotId);
            if (override) await remove("session_overrides", shotId);
          } catch (_) {}

          if (state.reviewMode && state.reviewShotId === shotId) {
            reviewClosed = true;
          }
          if (state.compareShotId === shotId) {
            compareClosed = true;
          }
        }

        const updates = {};
        if (reviewClosed) {
          Object.assign(updates, {
            reviewMode: false,
            reviewShotId: null,
            reviewTrace: null,
            reviewMicSeries: null,
            reviewInfo: "",
            reviewRangeEst: "",
            reviewReleaseIdx: null,
            reviewReleaseTimeMs: null,
            reviewHitIdx: null,
            reviewHitTimeMs: null,
            replayActive: false,
            replayPaused: false,
            replayProgress: 1,
          });
        }
        if (compareClosed) {
          Object.assign(updates, {
            compareShotId: null,
            compareTrace: null,
            compareShotLabel: "",
            compareThresholdG: 12,
          });
          if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
        }
        if (Object.keys(updates).length > 0) store.set(updates);

        if (el.historyBulkActions) el.historyBulkActions.classList.add("hidden");
        if (el.historyDefaultActions) el.historyDefaultActions.classList.remove("hidden");
        
        await loadShotHistoryList();
        
        if (state.reviewMode && state.reviewShotId && !selectedIds.includes(state.reviewShotId)) {
          await refreshReviewCompareOptions(state.reviewShotId);
        }

        if (syncAdapter) syncAdapter.triggerSync();
        
        bus.emit("log", `Successfully deleted ${selectedIds.length} shots.`);
      } catch (error) {
        console.error("Bulk deletion failed:", error);
        alert(`Failed to delete shots: ${error.message}`);
      }
    });
  }

  // Redraw previews when the theme is cycled
  window.addEventListener("themechange", async () => {
    try {
      await loadRecentShotsList();
      await loadShotHistoryList();
    } catch (err) {
      console.error("Failed to reload shots lists on theme change:", err);
    }
  });

  return {
    loadShotHistoryList,
    loadRecentShotsList,
    withPreservedScroll,
    refreshReviewCompareOptions,
    refreshHistoryShotPreview,
    upsertRecentShotCard,
    reviewShotTrace,
    exportSingleShot,
    deleteSavedShot,
  };
}
