// Shot history, review, recent shots, and deletion UI module.

import { getAll, get, readSavedReview, removeSavedShots, saveShotOutcome, saveSessionOverride, exportShotData, exportSelectedShots, groupShotsByTime, sessionOverrideForGroup, SESSION_GAP_MS } from "../core/db.js?v=shot-store-176";
import { downloadJson, exportFileStamp } from "./download.js?v=shot-store-176";
import { coachForScore } from "../telemetry/telemetry.js?v=shot-store-183";
import { scoreValue, shotFloatScore, averageShotScore } from "../telemetry/score.js?v=shot-store-150";
import {
  buildScorecard,
  canRecordArrowOutcome,
  formatShotOutcome,
  impactDirectionLabel,
  normalizeArrowOutcome,
  normalizeImpact,
} from "../telemetry/outcome.js?v=shot-store-150";
import { resolveReviewMicSeries } from "../protocol/trace.js?v=shot-store-125";
import { ASSUMED_ARROW_SPEED_FPS, arrowSpeedFps, calculateRangeFromTimes, findImpactTimeMs, formatRangeEstimate } from "../telemetry/range.js?v=shot-store-163";
import { traceTimeline, timelineIndexAt } from "./replay.js?v=shot-store-155";
import { drawEmptyTargetPreview, drawTraceTargetPreview, watchTracePreviewResize } from "./trace-preview.js?v=shot-store-155";
import {
  buildSessionFloatPlot,
  buildSessionImpactReview,
  buildSessionOutcomeReview,
  buildSessionReview,
  buildSessionScorecard,
  shotHistoryLabel,
} from "./session-review.js?v=shot-store-150";
import { mountImpactTarget } from "./impact-target.js?v=shot-store-138";
import { tracePhases } from "./trace-phases.js?v=shot-store-155";

export function initHistory({ bus, store, state, el, syncAdapter, selectViewTab, download = downloadJson }) {
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

  function newestFirst(a, b) {
    const savedTime = (shot) => {
      const time = Date.parse(shot.timestamp);
      return Number.isFinite(time) ? time : -Infinity;
    };
    const aTime = savedTime(a);
    const bTime = savedTime(b);
    if (aTime !== bTime) return aTime > bTime ? -1 : 1;
    return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
  }

  const OUTCOME_CONTEXT_KEY = "openfloat_last_target_context";
  let selectedOutcome = null;
  let selectedImpact = null;
  let currentOutcomeShotId = null;
  let impactTarget = null;
  let reviewArrows = [];
  let outcomeSaving = false;
  let savedOutcomeExists = false;
  let outcomeDirty = false;
  let reviewedTraceRecord = null;
  let reviewRequest = 0;
  let reviewReturnFocus = null;
  let historyRequest = 0;
  let recentRequest = 0;
  let compareRequest = 0;
  let compareOptionsRequest = 0;
  let reviewUpdateRequest = 0;
  let exportInProgress = false;
  let reviewExportShotId = null;
  let deletionInProgress = false;
  const selectedShotIds = new Set();
  const sessionOperations = new Map();

  function sessionOperation(group) {
    const matching = [...sessionOperations.values()].filter((operation) => group.shots.some((shot) => operation.shotIds.has(shot.id)));
    return matching.find((operation) => operation.busy) || matching[0];
  }

  function sessionRows(operation) {
    return [...el.historyList.querySelectorAll(".session-group")].filter((row) =>
      [...row.querySelectorAll(".history-item")].some((item) => operation.shotIds.has(item.dataset.shotId)));
  }

  function sessionControls(row, operation) {
    const busy = !!operation?.busy;
    row.setAttribute("aria-busy", String(busy));
    row.querySelectorAll(".session-name-input,.session-bow-input,.session-save-btn,.session-cancel-btn,.session-edit-btn,.session-end-size")
      .forEach((control) => { control.disabled = busy; });
    row.querySelector(".session-edit-status").textContent = operation?.message || "";
  }

  async function persistSessionSettings(group, changes, { editing = false } = {}) {
    if (sessionOperation(group)?.busy) return;
    // Drop an older message for this group, including after its anchor moved.
    for (const [id, operation] of sessionOperations) {
      if (group.shots.some((shot) => operation.shotIds.has(shot.id))) sessionOperations.delete(id);
    }
    const operation = { shotIds: new Set(group.shots.map((shot) => shot.id)), busy: true,
      message: editing ? "Saving session..." : "Saving scorecard grouping..." };
    sessionOperations.set(group.anchorId, operation);
    sessionRows(operation).forEach((row) => sessionControls(row, operation));
    let committed = false;
    try {
      await saveSessionOverride(group.anchorId, changes, { shotIds: [...operation.shotIds] });
      committed = true;
      operation.message = editing ? "Session saved." : "Scorecard grouping saved.";
      if (editing) {
        for (const row of sessionRows(operation)) {
          row.querySelector(".session-editor").classList.add("hidden");
          row.querySelector(".session-edit-btn").setAttribute("aria-expanded", "false");
        }
      }
      bus.emit("log", editing ? `Updated session "${changes.name || defaultSessionName(group.startTime)}".` : "Updated scorecard grouping.");
      if (await loadShotHistoryList() === false) {
        operation.message = "Settings saved. Saved Shots could not refresh; open it again to retry.";
        bus.emit("log", operation.message);
      }
    } catch (error) {
      operation.message = committed ? `Settings saved; the view could not refresh: ${error.message}`
        : `Could not save ${editing ? "session" : "scorecard grouping"}: ${error.message}${editing ? " Your changes are still here; try again." : ""}`;
      bus.emit("log", operation.message);
      if (!editing && !committed) {
        for (const row of sessionRows(operation)) {
          const select = row.querySelector(".session-end-size");
          if (select) select.value = select.dataset.savedValue;
        }
      }
    } finally {
      operation.busy = false;
      const rows = sessionRows(operation);
      for (const row of rows) {
        const ids = new Set([...row.querySelectorAll(".history-item")].map((item) => item.dataset.shotId));
        const pending = [...sessionOperations.values()].find((candidate) => candidate.busy && [...candidate.shotIds].some((id) => ids.has(id)));
        sessionControls(row, pending || operation);
      }
      if (committed) {
        sessionOperations.delete(group.anchorId);
        const focused = document.activeElement;
        if (focused === document.body || rows.some((row) => row.contains(focused))) {
          rows[0]?.querySelector(editing ? ".session-edit-btn" : ".session-end-size")?.focus();
        }
      }
    }
  }

  function focusOutcomeScore() {
    const buttons = el.outcomeScoreButtons;
    (buttons?.querySelector(".selected") || buttons?.querySelector("[data-outcome-score]"))?.focus();
  }

  function updateImpactHint() {
    if (el.outcomeImpactHint) {
      el.outcomeImpactHint.textContent = selectedImpact
        ? `${impactDirectionLabel(selectedImpact)} / ${Math.round(selectedImpact.radius * 100)}% of target radius`
        : "Tap the target, or focus it and press Enter.";
    }
    if (el.clearImpactBtn) el.clearImpactBtn.disabled = outcomeSaving || !selectedImpact;
  }

  impactTarget = mountImpactTarget({
    canvas: el.outcomeImpactCanvas,
    onSelect(impact) {
      if (outcomeSaving) return;
      outcomeDirty = true;
      selectedImpact = impact;
      if (impact) {
        selectedOutcome = { score: impact.score, isX: false };
      }
      updateOutcomeButtons();
      updateImpactHint();
      if (el.reviewOutcomeStatus) {
        el.reviewOutcomeStatus.textContent = impact
          ? `Selected ${impact.score === 0 ? "M" : impact.score} ${impactDirectionLabel(impact)} - save to record`
          : "Impact cleared - save to record";
      }
    },
  });

  function storedOutcomeContext() {
    try {
      const parsed = JSON.parse(localStorage.getItem(OUTCOME_CONTEXT_KEY) || "null");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function roundedScore(raw) {
    const value = scoreValue(raw);
    return value == null ? null : Math.round(value);
  }

  function captureMetrics(shot) {
    const score = roundedScore(shotFloatScore(shot));
    const stability = roundedScore(shot.stability_score);
    const rawPeak = shot.peak_g;
    const peak = typeof rawPeak === "string" && rawPeak.trim() ? Number(rawPeak) : rawPeak;
    return {
      score: score ?? "--",
      stability: stability == null ? "--" : `${stability}%`,
      peakG: typeof peak === "number" && Number.isFinite(peak) && peak >= 0 ? `${peak.toFixed(1)}g` : "--",
    };
  }

  function buildReviewInfo(shot) {
    const { score, peakG, stability } = captureMetrics(shot);
    const outcome = normalizeArrowOutcome(shot);
    const outcomePart = outcome ? ` | Arrow: ${outcome.label}` : "";
    const timeStr = new Date(shot.timestamp).toLocaleTimeString();
    const demoPart = shot.sample === true || shot.device_id === "OpenFloat-Demo" ? "Demo capture | " : "";
    return `${demoPart}Float Score: ${score}${outcomePart} | Peak Force: ${peakG} | Stability: ${stability} | Captured: ${timeStr}`;
  }

  function updateOutcomeButtons() {
    el.reviewOutcomePanel?.setAttribute("aria-busy", String(outcomeSaving));
    for (const input of [el.outcomeDistanceInput, el.outcomeDistanceUnit, el.outcomeFaceInput]) {
      if (input) input.disabled = outcomeSaving;
    }
    el.outcomeScoreButtons?.querySelectorAll("[data-outcome-score]").forEach((button) => {
      const score = Number(button.dataset.outcomeScore);
      const isX = button.dataset.outcomeX === "true";
      const selected = !!selectedOutcome && selectedOutcome.score === score && selectedOutcome.isX === isX;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.disabled = outcomeSaving;
    });
    if (el.saveOutcomeBtn) el.saveOutcomeBtn.disabled = outcomeSaving || !selectedOutcome;
    if (el.saveNextOutcomeBtn) el.saveNextOutcomeBtn.disabled = outcomeSaving || !selectedOutcome;
    if (el.clearOutcomeBtn) el.clearOutcomeBtn.disabled = outcomeSaving || !savedOutcomeExists;
    updateImpactHint();
  }

  function renderOutcomeEditor(shot) {
    outcomeDirty = false;
    const canRecord = canRecordArrowOutcome(shot);
    currentOutcomeShotId = canRecord ? shot.id : null;
    el.reviewOutcomePanel?.classList.toggle("hidden", !canRecord);
    if (!canRecord) return;

    const outcome = normalizeArrowOutcome(shot);
    selectedImpact = normalizeImpact(shot);
    selectedOutcome = outcome ? { score: outcome.score, isX: outcome.isX } : null;
    // Defaults are for new outcomes only. Existing partial context stays blank,
    // and an explicit yards value takes precedence over the last-used meters.
    const context = outcome ? {} : storedOutcomeContext();
    if (el.outcomeDistanceInput) {
      el.outcomeDistanceInput.value = shot.target_distance ?? context.distance ?? "";
    }
    if (el.outcomeDistanceUnit) {
      el.outcomeDistanceUnit.value = ["m", "yd"].includes(shot.target_distance_unit)
        ? shot.target_distance_unit
        : context.unit === "m" ? "m" : "yd";
    }
    if (el.outcomeFaceInput) {
      el.outcomeFaceInput.value = shot.target_face_cm ?? context.faceCm ?? "";
    }
    if (el.reviewOutcomeStatus) {
      el.reviewOutcomeStatus.textContent = outcome
        ? formatShotOutcome(shot, { includeContext: true })
        : "Not scored";
    }
    savedOutcomeExists = !!outcome || !!selectedImpact;
    reviewArrows = reviewArrows.map((arrow) => arrow.id === shot.id ? shot : arrow);
    updateReviewProgress();
    impactTarget?.setImpact(selectedImpact);
    updateImpactHint();
    updateOutcomeButtons();
  }

  function updateReviewProgress() {
    const arrowIndex = reviewArrows.findIndex((arrow) => arrow.id === currentOutcomeShotId);
    const remaining = reviewArrows.filter((arrow) => !normalizeArrowOutcome(arrow)).length;
    if (el.reviewArrowProgress) {
      el.reviewArrowProgress.textContent = arrowIndex < 0 ? "" :
        `Arrow ${arrowIndex + 1} of ${reviewArrows.length} / ${remaining} still to score`;
    }
    if (el.saveNextOutcomeBtn) {
      el.saveNextOutcomeBtn.textContent = arrowIndex >= 0 && arrowIndex < reviewArrows.length - 1
        ? "Save & Next" : "Save & Finish";
    }
  }

  function optionalPositiveNumber(input, label, max) {
    const raw = input?.value?.trim() || "";
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > max) {
      throw new Error(`${label} must be between 0 and ${max}.`);
    }
    return value;
  }

  async function persistArrowOutcome({ clear = false } = {}) {
    if (!currentOutcomeShotId) return;
    if (!clear && !selectedOutcome) return;

    const distance = clear ? null : optionalPositiveNumber(el.outcomeDistanceInput, "Distance", 300);
    const faceCm = clear ? null : optionalPositiveNumber(el.outcomeFaceInput, "Face size", 200);
    const unit = el.outcomeDistanceUnit?.value === "m" ? "m" : "yd";
    const shotId = currentOutcomeShotId;
    const outcome = selectedOutcome;
    const impact = selectedImpact;
    const updatedShot = await saveShotOutcome(shotId, {
      arrow_score: clear ? null : outcome.score,
      arrow_is_x: clear ? false : outcome.isX,
      target_distance: clear ? null : distance,
      target_distance_unit: clear ? null : unit,
      target_face_cm: clear ? null : faceCm,
      outcome_recorded_at: clear ? null : new Date().toISOString(),
      impact_x: clear || !impact ? null : impact.x,
      impact_y: clear || !impact ? null : impact.y,
      impact_recorded_at: clear || !impact ? null : new Date().toISOString(),
    });
    const isDemo = updatedShot.sample === true || updatedShot.device_id === "OpenFloat-Demo";

    if (!clear) {
      try {
        localStorage.setItem(OUTCOME_CONTEXT_KEY, JSON.stringify({ distance, unit, faceCm }));
      } catch (_) {
        // Remembering form defaults is optional; the arrow result has committed.
      }
    }
    if (store.get().reviewShotId === shotId) {
      outcomeDirty = false;
      if (el.reviewOutcomeStatus) el.reviewOutcomeStatus.textContent = "Result saved locally. Refreshing views...";
    }
    let latestShot = updatedShot;
    let refreshed = true;
    try {
      const [views, reviewedShot] = await Promise.all([
        Promise.all([loadRecentShotsList(), loadShotHistoryList()]),
        refreshReviewedCapture(shotId, { restored: true }),
      ]);
      refreshed = views.every((result) => result !== false);
      if (reviewedShot) latestShot = reviewedShot;
    } catch (error) {
      refreshed = false;
      bus.emit("log", `Target result saved locally; view refresh failed: ${error.message}`);
    }
    if (store.get().reviewShotId === shotId && el.reviewOutcomeStatus) {
      const result = formatShotOutcome(latestShot, { includeContext: true });
      const replaced = result !== formatShotOutcome(updatedShot, { includeContext: true })
        || JSON.stringify(normalizeImpact(latestShot)) !== JSON.stringify(normalizeImpact(updatedShot));
      el.reviewOutcomeStatus.textContent = !refreshed
        ? "Result saved locally. Some views could not refresh; reopen Saved Shots to retry."
        : replaced ? `A newer saved result is now shown: ${result}` : clear ? "Result cleared" : `Saved ${result}`;
    }
    if (!isDemo && syncAdapter) {
      Promise.resolve().then(() => syncAdapter.triggerSync()).catch((error) =>
        bus.emit("log", `Target result saved locally; cloud sync failed: ${error.message}`));
    }
    bus.emit(
      "log",
      clear
        ? `Cleared target result for shot ${updatedShot.id.slice(0, 8)}.`
        : `Saved arrow ${formatShotOutcome(updatedShot, { includeContext: true })} for shot ${updatedShot.id.slice(0, 8)}.`,
    );
    return latestShot;
  }

  async function loadShotHistoryList() {
    const request = ++historyRequest;
    if (!el.historyList.querySelector(".session-group")) {
      el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">Loading saved history...</p>`;
    }
    try {
      const [shots, bows, overrides] = await Promise.all([
        getAll("shots"), getAll("bow_profiles"), getAll("session_overrides"),
      ]);
      if (request !== historyRequest) return;
      // Capture interaction state immediately before replacing the rows, so
      // edits or focus changes made while the reads were pending also survive.
      const focused = document.activeElement;
      const focusShotId = focused?.closest("[data-shot-id]")?.dataset.shotId;
      const focusSessionId = focused?.closest(".session-group")?.dataset.sessionId;
      const focusSelector = [".history-item-checkbox", ".history-review-btn", ".history-item-delete-btn", ".history-item-export-btn",
        ".session-toggle", ".session-edit-btn", ".session-name-input", ".session-bow-input", ".session-save-btn",
        ".session-cancel-btn", ".session-end-size"].find((selector) => focused?.matches(selector));
      const focusSelection = focused?.matches(".session-name-input") ? [focused.selectionStart, focused.selectionEnd] : null;
      const drafts = [...el.historyList.querySelectorAll(".session-editor:not(.hidden)")].map((editor) => ({
        shotIds: new Set([...editor.closest(".session-group").querySelectorAll(".history-item")].map((row) => row.dataset.shotId)),
        name: editor.querySelector(".session-name-input").value,
        bow: editor.querySelector(".session-bow-input").value,
      }));
      const expandedSessions = new Set(
        [...el.historyList.querySelectorAll(".session-group:not(.collapsed)")]
          .map((group) => group.dataset.sessionId),
      );
      const expandedShotIds = new Set(
        [...el.historyList.querySelectorAll(".session-group:not(.collapsed) .history-item")]
          .map((item) => item.dataset.shotId),
      );
      const hadSessions = !!el.historyList.querySelector(".session-group");
      const availableIds = new Set(shots.map((shot) => shot.id));
      for (const [id, operation] of sessionOperations) {
        if (!operation.busy && ![...operation.shotIds].some((shotId) => availableIds.has(shotId))) sessionOperations.delete(id);
      }
      for (const id of selectedShotIds) {
        if (!availableIds.has(id)) selectedShotIds.delete(id);
      }
      updateBulkSelectCount();

      if (shots.length === 0) {
        el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet. Shots taken within ${Math.round(SESSION_GAP_MS / 60000)} minutes of each other are grouped into a session automatically.</p>`;
        return true;
      }

      const bowMap = new Map(bows.map(b => [b.id, b]));
      const overrideMap = new Map(overrides.map(o => [o.id, o]));

      // Group shots purely by their timestamps (newest session first).
      const groups = groupShotsByTime(shots);

      el.historyList.innerHTML = "";
      const historyPreviewJobs = [];
      let isFirst = true;
      let sessionIndex = 0;
      for (const group of groups) {
        const contentId = `session-content-${++sessionIndex}`;
        const override = sessionOverrideForGroup(group, overrideMap);
        const groupEl = document.createElement("div");
        const expanded = hadSessions
          ? expandedSessions.has(group.anchorId) || group.shots.some((shot) => expandedShotIds.has(shot.id))
          : isFirst;
        groupEl.className = "session-group" + (expanded ? "" : " collapsed");
        groupEl.dataset.sessionId = group.anchorId;
        isFirst = false;

        const sessionName = (override && override.name) || defaultSessionName(group.startTime);
        const dateStr = new Date(group.startTime).toLocaleString();

        const bow = override && override.bow_profile_id ? bowMap.get(override.bow_profile_id) : null;
        const bowName = override?.bow_profile_id && !bow ? "Unavailable bow profile" : bowDisplayName(bow);

        const shotCount = group.shots.length;
        const avgScore = roundedScore(averageShotScore(group.shots)) ?? "--";

        const draft = drafts.find((candidate) => group.shots.some((shot) => candidate.shotIds.has(shot.id)));
        const editorBowId = draft ? draft.bow : override?.bow_profile_id || "";
        const bowOptions = ['<option value="">Default Bow</option>']
          .concat(bows.map(b => {
            const sel = editorBowId === b.id ? " selected" : "";
            return `<option value="${escapeHtml(b.id)}"${sel}>${escapeHtml(bowDisplayName(b))}</option>`;
          }))
          .concat(editorBowId && !bowMap.has(editorBowId)
            ? [`<option value="${escapeHtml(editorBowId)}" selected>Unavailable bow profile</option>`] : [])
          .join("");

        groupEl.innerHTML = `
          <div class="session-header">
            <button class="session-toggle" type="button" aria-expanded="${expanded}" aria-controls="${contentId}">
            <span class="session-meta">
              <span class="session-title-row">
                <span class="session-arrow-icon" aria-hidden="true">▼</span>
                <span class="session-location">${escapeHtml(sessionName)}</span>
              </span>
              <span class="session-info-row">
                <span class="session-date">${dateStr}</span>
                <span class="session-divider">|</span>
                <span class="session-bow">${escapeHtml(bowName)}</span>
              </span>
            </span>
            <span class="session-stats">
              <span class="session-stat-badge">
                <span class="badge-label">Shots</span>
                <span class="badge-val">${shotCount}</span>
              </span>
              <span class="session-stat-badge">
                <span class="badge-label">Avg Float</span>
                <span class="badge-val">${avgScore}</span>
              </span>
            </span>
            </button>
            <button class="session-edit-btn" type="button" title="Edit session name and bow" aria-label="Edit ${escapeHtml(sessionName)}, ${escapeHtml(dateStr)}" aria-expanded="false">✎</button>
          </div>
          <div class="session-content" id="${contentId}" ${expanded ? "" : "hidden"}>
          <div class="session-editor hidden">
            <div class="field">
              <label for="session-name-${sessionIndex}">Session Name</label>
              <input id="session-name-${sessionIndex}" type="text" class="session-name-input" value="${escapeHtml(sessionName)}" placeholder="e.g. Morning 70m Practice">
            </div>
            <div class="field">
              <label for="session-bow-${sessionIndex}">Bow Used</label>
              <select id="session-bow-${sessionIndex}" class="session-bow-input">${bowOptions}</select>
            </div>
            <div class="session-editor-actions">
              <button class="primary session-save-btn" type="button">Save</button>
              <button class="session-cancel-btn" type="button">Cancel</button>
            </div>
          </div>
          <p class="session-edit-status note" role="status"></p>
          <div class="session-scorecard-slot">${buildSessionScorecard(group.shots, override?.arrows_per_end)}</div>
          ${buildSessionReview(group.shots)}
          ${buildSessionOutcomeReview(group.shots)}
          ${buildSessionImpactReview(group.shots)}
          ${buildSessionFloatPlot(group.shots)}
          <div class="session-shots-container"></div>
          </div>
        `;

        const toggle = groupEl.querySelector(".session-toggle");
        const contentEl = groupEl.querySelector(".session-content");
        const editorEl = groupEl.querySelector(".session-editor");
        const editButton = groupEl.querySelector(".session-edit-btn");
        if (draft) {
          editorEl.classList.remove("hidden");
          editButton.setAttribute("aria-expanded", "true");
          editorEl.querySelector(".session-name-input").value = draft.name;
          editorEl.querySelector(".session-bow-input").value = draft.bow;
        }
        function setExpanded(open) {
          groupEl.classList.toggle("collapsed", !open);
          contentEl.hidden = !open;
          toggle.setAttribute("aria-expanded", String(open));
        }
        toggle.addEventListener("click", () => setExpanded(contentEl.hidden));

        editButton.addEventListener("click", () => {
          if (sessionOperation(group)?.busy) return;
          const open = editorEl.classList.contains("hidden") || contentEl.hidden;
          setExpanded(true);
          editorEl.classList.toggle("hidden", !open);
          editButton.setAttribute("aria-expanded", String(open));
          if (open) groupEl.querySelector(".session-name-input").focus();
        });
        groupEl.querySelector(".session-cancel-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          if (sessionOperation(group)?.busy) return;
          editorEl.classList.add("hidden");
          editButton.setAttribute("aria-expanded", "false");
          editButton.focus();
        });
        groupEl.querySelector(".session-save-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          const nameVal = groupEl.querySelector(".session-name-input").value.trim();
          const bowVal = groupEl.querySelector(".session-bow-input").value || null;
          await persistSessionSettings(group, { name: nameVal || null, bow_profile_id: bowVal }, { editing: true });
        });
        groupEl.addEventListener("click", (event) => {
          const button = event.target.closest("[data-review-shot-id]");
          if (!button) return;
          event.preventDefault();
          const shot = group.shots.find((candidate) => candidate.id === button.dataset.reviewShotId);
          if (shot) reviewShotTrace(shot, { focusOutcome: !!button.closest(".session-scorecard") });
        });
        groupEl.addEventListener("change", async (event) => {
          if (!event.target.matches(".session-end-size")) return;
          await persistSessionSettings(group, { arrows_per_end: Number(event.target.value) === 6 ? 6 : 3 });
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
                updateShotSelection(chk);
              }
              return;
            }
            
            e.stopPropagation();
            reviewShotTrace(shot);
          });
          const deleteBtn = item.querySelector(".history-item-delete-btn");
          if (deleteBtn) deleteBtn.disabled = deletionInProgress || exportInProgress;
          item.querySelector(".history-review-btn").addEventListener("click", (event) => {
            event.stopPropagation();
            reviewShotTrace(shot);
          });
          deleteBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteSavedShot(shot.id);
          });
          const exportBtn = item.querySelector(".history-item-export-btn");
          if (exportBtn) exportBtn.disabled = exportInProgress || deletionInProgress;
          exportBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            return exportSingleShot(shot.id, exportBtn);
          });
          containerEl.appendChild(item);
          historyPreviewJobs.push({ item, shot });
        }

        el.historyList.appendChild(groupEl);
        const endSize = groupEl.querySelector(".session-end-size");
        if (endSize) endSize.dataset.savedValue = endSize.value;
        sessionControls(groupEl, sessionOperation(group));
      }

      if (focusSelector && !focused.isConnected && document.activeElement === document.body) {
        const scope = focusShotId
          ? [...el.historyList.querySelectorAll(".history-item")].find((row) => row.dataset.shotId === focusShotId)
          : [...el.historyList.querySelectorAll(".session-group")].find((group) => group.dataset.sessionId === focusSessionId);
        const replacement = scope?.querySelector(focusSelector);
        replacement?.focus({ preventScroll: true });
        if (replacement && focusSelection) replacement.setSelectionRange(...focusSelection);
      }

      await paintHistoryShotPreviews(historyPreviewJobs);
      updateBulkSelectCount();
      return true;
    } catch (error) {
      if (request !== historyRequest) return;
      console.error("Error loading shot history:", error);
      if (el.historyList.querySelector(".session-group")) {
        let message = el.historyList.querySelector(".history-load-status");
        if (!message) {
          message = document.createElement("p");
          message.className = "history-load-status note";
          message.setAttribute("role", "status");
          el.historyList.prepend(message);
        }
        message.textContent = `Could not refresh Saved Shots: ${error.message}. The displayed history and drafts are kept; open Saved Shots again to retry.`;
      } else {
        el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center; color: var(--red);">Failed to load history: ${escapeHtml(error.message)}</p>`;
      }
      return false;
    }
  }

  function formatShotCompareLabel(shot) {
    const timeStr = new Date(shot.timestamp).toLocaleString();
    const score = roundedScore(shotFloatScore(shot)) ?? "--";
    const label = shotHistoryLabel(shot);
    return `${label} - ${timeStr} (Float Score: ${score})`;
  }

  async function refreshReviewCompareOptions(currentShotId, preserveSelection = true) {
    if (!el.reviewCompareSelect) return;
    const request = ++compareOptionsRequest;
    const shots = await getAll("shots");
    const candidates = [];

    for (const candidate of shots) {
      if (candidate.id === currentShotId) continue;
      const trace = await get("shot_traces", candidate.id);
      if (trace && trace.payload && trace.payload.length >= 2) {
        candidates.push(candidate);
      }
    }

    candidates.sort(newestFirst);
    if (request !== compareOptionsRequest || store.get().reviewShotId !== currentShotId) return;
    const previous = preserveSelection ? el.reviewCompareSelect.value : "";

    el.reviewCompareSelect.innerHTML =
      '<option value="">None</option>' +
      candidates
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(formatShotCompareLabel(s))}</option>`)
        .join("");

    if (previous && [...el.reviewCompareSelect.options].some((opt) => opt.value === previous)) {
      el.reviewCompareSelect.value = previous;
    } else {
      el.reviewCompareSelect.value = "";
    }
  }

  async function loadReviewCompareShot(shotId) {
    const request = ++compareRequest;
    const primaryId = store.get().reviewShotId;
    if (!shotId) {
      store.set({
        compareShotId: null,
        compareTrace: null,
        compareShotLabel: "",
        compareThresholdG: 12,
      });
      return true;
    }

    try {
      const snapshot = await readSavedReview(shotId);
      const shot = snapshot.shots.find((candidate) => candidate.id === shotId);
      const trace = snapshot.trace;
      if (request !== compareRequest || !store.get().reviewMode || store.get().reviewShotId !== primaryId) return;
      if (!shot || !trace || !trace.payload || trace.payload.length < 2) {
        store.set({
          compareShotId: null,
          compareTrace: null,
          compareShotLabel: "",
          compareThresholdG: 12,
        });
        if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
        bus.emit("log", "Compare shot has no saved trace.");
        return true;
      }

      const label = shot.label ? shotHistoryLabel(shot) : formatShotCompareLabel(shot);
      store.set({
        compareShotId: shotId,
        compareTrace: trace.payload,
        compareSampleRateHz: trace.sample_rate_hz || 52,
        compareShotLabel: label,
        compareThresholdG: shot.threshold_g != null ? Number(shot.threshold_g) : 12,
        compareCaptureKind: canRecordArrowOutcome(shot) ? "arrow" : "hold",
        compareTraceSource: trace.source || null,
      });
      bus.emit("log", `Comparing with shot ${shotId.slice(0, 8)}…`);
      return true;
    } catch (error) {
      console.error("Failed to load compare shot:", error);
      bus.emit("log", `Compare load failed: ${error.message}`);
      return false;
    }
  }

  function getReviewArrowSpeed(shot, session, snapshot) {
    try {
      const override = session ? sessionOverrideForGroup(session,
        new Map(snapshot.overrides.map((record) => [record.id, record]))) : null;
      const assignedBowId = override?.bow_profile_id || shot.bow_profile_id;
      const bowId = assignedBowId || localStorage.getItem("openfloat_active_bow_id");
      if (bowId) {
        const profile = snapshot.bowProfiles.find((record) => record.id === bowId);
        const fps = arrowSpeedFps(profile?.arrow_speed);
        if (fps !== null) return { fps, source: assignedBowId ? "assigned" : "active" };
      }
    } catch (error) {
      console.error("Error getting review bow speed:", error);
    }
    return { fps: ASSUMED_ARROW_SPEED_FPS, source: "assumed" };
  }

  function reviewTraceState(shot, trace, speed) {
    const sampleRateHz = trace.sample_rate_hz || 52;
    const thresholdG = shot.threshold_g != null ? Number(shot.threshold_g) : 12;
    const captureKind = canRecordArrowOutcome(shot) ? "arrow" : "hold";
    const phases = tracePhases(trace.payload, { thresholdG, captureKind, source: trace.source, sampleRateHz });
    const micSeries = resolveReviewMicSeries(trace, sampleRateHz);
    const hitTimeMs = phases.hasRelease ? findImpactTimeMs(micSeries, phases.releaseTimeMs) : null;
    const range = calculateRangeFromTimes(phases.releaseTimeMs, hitTimeMs, speed.fps);
    return {
      reviewTrace: trace.payload,
      reviewTraceSource: trace.source || null,
      reviewMicSeries: micSeries,
      reviewSampleRateHz: sampleRateHz,
      reviewThresholdG: thresholdG,
      reviewRangeSpeed: speed,
      reviewRangeEst: formatRangeEstimate(range, speed),
      reviewReleaseIdx: phases.hasRelease ? phases.releaseIdx : null,
      reviewReleaseTimeMs: phases.releaseTimeMs,
      reviewHitIdx: hitTimeMs === null ? null : Math.max(0, timelineIndexAt(traceTimeline(trace.payload, sampleRateHz), hitTimeMs * 1000)),
      reviewHitTimeMs: hitTimeMs,
    };
  }

  function reviewMetrics(shot) {
    const formScore = roundedScore(shotFloatScore(shot));
    const holdStability = roundedScore(shot.hold_stability) ?? (shot.score_version ? null : roundedScore(shot.stability_score));
    const releaseQuality = roundedScore(shot.release_quality);
    const followThrough = roundedScore(shot.follow_through);
    const levelConsistency = roundedScore(shot.level_consistency);
    const roll = shot.cant_angle_deg || shot.roll_angle_deg || 0;
    const coaching = coachForScore({ formScore, holdStability, releaseQuality, followThrough, roll });
    return {
      formScore, holdStability, releaseQuality, followThrough, levelConsistency,
      reviewCaptureKind: canRecordArrowOutcome(shot) ? "arrow" : "hold",
      reviewInfo: buildReviewInfo(shot),
      scoreVersion: shot.score_version || null,
      coachTitle: formScore == null ? "No Float Score" : coaching.coachTitle,
      coachText: formScore == null ? "This capture has no saved Float Score. Its trace and target result can still be reviewed." : coaching.coachText,
      lastShotSummary: { timestamp: shot.timestamp, score: formScore, peakG: shot.peak_g, cant: roll, pitch: shot.pitch_angle_deg || 0 },
    };
  }

  async function reviewShotTrace(selectedShot, { focusOutcome = false } = {}) {
    const request = ++reviewRequest;
    compareRequest += 1;
    if (!store.get().reviewMode) reviewReturnFocus = document.activeElement;
    try {
      // Card handlers may outlive a scoring update. Always reopen the saved
      // capture by id instead of rendering the object captured by that handler.
      const shotId = selectedShot.id;
      let shot = await get("shots", shotId);
      if (!shot || request !== reviewRequest) return;
      let trace = await get("shot_traces", shotId);

      // For shots taken while connected, the device does not store a trace — the
      // browser captures it and only persists it after the follow-through window
      // (~1.5 s + buffer). The shot is clickable immediately, so a just-taken
      // shot's trace may still be in flight. Poll briefly before giving up.
      if (!trace || !trace.payload) {
        const ageMs = Date.now() - new Date(shot.timestamp).getTime();
        if (ageMs >= 0 && ageMs < 4000) {
          bus.emit("log", "Trace still being captured (follow-through); waiting…");
          const deadline = Date.now() + 4000;
          while ((!trace || !trace.payload) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
            if (request !== reviewRequest) return;
            trace = await get("shot_traces", shot.id);
          }
        }
      }

      const snapshot = await readSavedReview(shotId);
      const shots = snapshot.shots;
      shot = shots.find((candidate) => candidate.id === shotId);
      if (!shot || request !== reviewRequest) return;
      trace = snapshot.trace;
      if (!trace || !trace.payload) {
        trace = { payload: [], sample_rate_hz: 52 };
        bus.emit(
          "log",
          "No motion trace is saved for this shot; opening metadata and target-result review.",
        );
      }

      const sessions = groupShotsByTime(shots);
      const session = sessions.find((group) => group.shots.some((arrow) => arrow.id === shot.id));
      const speed = getReviewArrowSpeed(shot, session, snapshot);
      if (request !== reviewRequest) return;
      reviewArrows = buildScorecard(session?.shots || [shot]).arrows;
      reviewedTraceRecord = trace;

      store.set({
        ...reviewMetrics(shot),
        reviewMode: true,
        reviewShotId: shot.id,
        ...reviewTraceState(shot, trace, speed),
        chartView: "target",
        replayActive: false,
        replayPaused: false,
        replayProgress: 1,
        traceZoom: 1,
        compareShotId: null,
        compareTrace: null,
        compareShotLabel: "",
        compareThresholdG: 12,
      });

      if (el.reviewCompareSelect) el.reviewCompareSelect.innerHTML = '<option value="">None</option>';
      renderOutcomeEditor(shot);

      bus.emit("log", `Entering review mode for shot ${shot.id.slice(0, 8)}...`);
      selectViewTab("tabDashboard");
      if (focusOutcome) {
        focusOutcomeScore();
      } else {
        el.exitReviewBtn.focus();
      }
      await refreshReviewCompareOptions(shot.id);
    } catch (error) {
      console.error("Failed to load trace:", error);
      alert("Error fetching trace payload: " + error.message);
    }
  }

  function exitReview({ restoreFocus = true } = {}) {
    reviewRequest += 1;
    compareRequest += 1;
    compareOptionsRequest += 1;
    reviewArrows = [];
    reviewedTraceRecord = null;
    outcomeDirty = false;
    store.set({
      reviewMode: false,
      reviewShotId: null,
      reviewTrace: null,
      reviewMicSeries: null,
      reviewSampleRateHz: 52,
      reviewThresholdG: 12,
      reviewInfo: "",
      reviewRangeEst: "",
      reviewRangeSpeed: null,
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
    currentOutcomeShotId = null;
    selectedOutcome = null;
    selectedImpact = null;
    impactTarget?.setImpact(null);
    el.reviewOutcomePanel?.classList.add("hidden");
    if (!restoreFocus) {
      reviewReturnFocus = null;
    } else if (reviewReturnFocus?.isConnected && reviewReturnFocus.getClientRects().length) {
      reviewReturnFocus.focus();
    } else {
      // Switching views refreshes recent cards, so the original DOM button
      // may have been replaced while its shot is still visible.
      const shotId = reviewReturnFocus?.closest("[data-shot-id]")?.dataset.shotId;
      const recentCard = shotId && [...el.recentShotsList.querySelectorAll(".recent-shot-card")]
        .find((card) => card.dataset.shotId === shotId);
      (recentCard || el.viewTargetBtn)?.focus();
    }
    reviewReturnFocus = null;
    bus.emit("log", "Exited review mode. Returned to live telemetry stream.");
  }
  el.exitReviewBtn.addEventListener("click", () => exitReview());

  function setExportStatus(message, shotId) {
    if (el.historyExportStatus) el.historyExportStatus.textContent = message;
    if (el.reviewExportStatus && store.get().reviewMode && store.get().reviewShotId === shotId) {
      reviewExportShotId = shotId;
      el.reviewExportStatus.textContent = message;
    }
  }

  function restoreExportFocus(control, hadFocus, shotId) {
    if (!hadFocus || document.activeElement !== document.body) return;
    if (control === el.exportShotBtn && store.get().reviewShotId !== shotId) return;
    const replacement = control?.matches(".history-item-export-btn")
      ? [...el.historyList.querySelectorAll(".history-item")].find((row) => row.dataset.shotId === shotId)?.querySelector(".history-item-export-btn")
      : control;
    if (replacement?.isConnected && replacement.getClientRects().length) replacement.focus();
  }

  async function exportSingleShot(shotId, control = document.activeElement) {
    if (exportInProgress || deletionInProgress) return;
    const hadFocus = document.activeElement === control;
    exportInProgress = true;
    updateBulkSelectCount();
    setExportStatus("Preparing shot export...", shotId);
    try {
      const payload = await exportShotData(shotId);
      const shortId = shotId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `openfloat-shot-${shortId}-${exportFileStamp(payload.shot.timestamp)}.json`;
      await download(payload, filename, 2);
      const message = `Exported capture ${shortId}${payload.trace ? "" : " without a saved trace"}. Restore this file from Settings.`;
      setExportStatus(message, shotId);
      bus.emit("log", message);
      return payload;
    } catch (error) {
      setExportStatus(`Export failed: ${error.message}`, shotId);
      bus.emit("log", `Single shot export failed: ${error.message}`);
    } finally {
      exportInProgress = false;
      updateBulkSelectCount();
      restoreExportFocus(control, hadFocus, shotId);
    }
  }

  if (el.exportShotBtn) {
    el.exportShotBtn.addEventListener("click", () => {
      const currentShotId = store.get().reviewShotId;
      if (currentShotId) {
        return exportSingleShot(currentShotId, el.exportShotBtn);
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

  el.outcomeScoreButtons?.querySelectorAll("[data-outcome-score]").forEach((button) => {
    button.addEventListener("click", () => {
      if (outcomeSaving) return;
      outcomeDirty = true;
      selectedOutcome = {
        score: Number(button.dataset.outcomeScore),
        isX: button.dataset.outcomeX === "true",
      };
      updateOutcomeButtons();
      if (el.reviewOutcomeStatus) {
        el.reviewOutcomeStatus.textContent = `Selected ${selectedOutcome.isX ? "X" : selectedOutcome.score === 0 ? "M" : selectedOutcome.score} - save to record`;
      }
    });
  });

  for (const input of [el.outcomeDistanceInput, el.outcomeDistanceUnit, el.outcomeFaceInput]) {
    input?.addEventListener("input", () => { if (!outcomeSaving) outcomeDirty = true; });
    input?.addEventListener("change", () => { if (!outcomeSaving) outcomeDirty = true; });
  }

  async function saveOutcome({ clear = false, advance = false } = {}) {
    if (outcomeSaving) return;
    const returnFocus = document.activeElement;
    const shotId = currentOutcomeShotId;
    let saved = null, nextId = null;
    outcomeSaving = true;
    updateOutcomeButtons();
    try {
      saved = await persistArrowOutcome({ clear });
      if (saved && advance && store.get().reviewShotId === shotId) {
        const arrowIndex = reviewArrows.findIndex((shot) => shot.id === shotId);
        nextId = arrowIndex >= 0 ? reviewArrows[arrowIndex + 1]?.id : null;
        const next = nextId ? await get("shots", nextId) : null;
        if (store.get().reviewShotId !== shotId) return;
        if (next) {
          await reviewShotTrace(next, { focusOutcome: true });
        } else {
          el.exitReviewBtn.click();
          selectViewTab("tabHistory");
          el.navHistoryBtn?.focus();
        }
      }
    } catch (error) {
      console.error("Failed to save arrow outcome:", error);
      bus.emit("log", saved ? `Target result saved; could not advance review: ${error.message}` : `Target result save failed: ${error.message}`);
      if (store.get().reviewShotId === shotId && el.reviewOutcomeStatus) {
        el.reviewOutcomeStatus.textContent = saved ? "Result saved locally. Open the next shot from Saved Shots."
          : `Save failed: ${error.message}`;
      }
      if (!saved) alert(error.message);
    } finally {
      outcomeSaving = false;
      updateOutcomeButtons();
      const review = store.get();
      if (review.reviewMode && (review.reviewShotId === shotId || (advance && review.reviewShotId === nextId))) {
        if (advance) focusOutcomeScore();
        else if (document.activeElement === document.body) {
          if (!returnFocus.disabled && returnFocus.getClientRects().length) returnFocus.focus();
          else focusOutcomeScore();
        }
      }
    }
  }

  el.saveOutcomeBtn?.addEventListener("click", () => saveOutcome());
  el.saveNextOutcomeBtn?.addEventListener("click", () => saveOutcome({ advance: true }));

  el.clearImpactBtn?.addEventListener("click", () => {
    if (outcomeSaving) return;
    outcomeDirty = true;
    selectedImpact = null;
    impactTarget?.setImpact(null);
    updateImpactHint();
    if (el.reviewOutcomeStatus) {
      el.reviewOutcomeStatus.textContent = "Impact cleared - save to record";
    }
  });

  el.clearOutcomeBtn?.addEventListener("click", () => saveOutcome({ clear: true }));

  store.subscribe((currentState) => {
    if (el.reviewExportStatus && (!currentState.reviewMode || currentState.reviewShotId !== reviewExportShotId)) {
      el.reviewExportStatus.textContent = "";
    }
    if (currentState.reviewMode) return;
    currentOutcomeShotId = null;
    selectedOutcome = null;
    selectedImpact = null;
    outcomeDirty = false;
    reviewedTraceRecord = null;
    impactTarget?.setImpact(null);
    el.reviewOutcomePanel?.classList.add("hidden");
  });

  const RECENT_SHOTS_LIMIT = 5;

  function recentShotCardMetrics(shot) {
    const timeStr = new Date(shot.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const { score, stability, peakG } = captureMetrics(shot);
    const arrow = canRecordArrowOutcome(shot) ? formatShotOutcome(shot) : null;
    return { timeStr, score, stability, peakG, arrow };
  }

  function buildHistoryItemElement(shot) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.dataset.shotId = shot.id;

    const isSelectMode = el.historyBulkActions && !el.historyBulkActions.classList.contains("hidden");
    const chkClass = isSelectMode ? "history-item-checkbox" : "history-item-checkbox hidden";

    const timestampStr = new Date(shot.timestamp).toLocaleTimeString();
    const title = shotHistoryLabel(shot);
    const { score, stability, peakG } = captureMetrics(shot);
    const arrow = canRecordArrowOutcome(shot) ? formatShotOutcome(shot) : null;
    const arrowMetric = arrow == null
      ? ""
      : `
          <div class="history-stat">
            <span class="history-stat-label">Arrow</span>
            <span class="history-stat-val arrow">${escapeHtml(arrow)}</span>
          </div>
        `;

    item.innerHTML = `
      <input type="checkbox" class="${chkClass}" data-shot-id="${escapeHtml(shot.id)}" aria-label="Select ${escapeHtml(title)}, ${escapeHtml(new Date(shot.timestamp).toLocaleString())}">
      <div class="history-item-preview-wrap is-empty" aria-hidden="true">
        <canvas class="history-item-trace-preview"></canvas>
      </div>
      <div class="history-item-body">
        <div class="history-meta">
          <button type="button" class="history-title history-review-btn" aria-label="Review ${escapeHtml(title)}, ${escapeHtml(timestampStr)}">${escapeHtml(title)}</button>
          <div class="history-subtitle">${escapeHtml(timestampStr)}</div>
        </div>
        <div class="history-metrics">
          ${arrowMetric}
          <div class="history-stat">
            <span class="history-stat-label">Float</span>
            <span class="history-stat-val score">${score}</span>
          </div>
          <div class="history-stat">
            <span class="history-stat-label">Stability</span>
            <span class="history-stat-val stability">${stability}</span>
          </div>
          <div class="history-stat">
            <span class="history-stat-label">Peak G</span>
            <span class="history-stat-val peak">${peakG}</span>
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
    chk.checked = selectedShotIds.has(shot.id);
    chk?.addEventListener("click", (e) => {
      e.stopPropagation();
      updateShotSelection(chk);
    });
    return item;
  }

  function setDeletionInProgress(value) {
    deletionInProgress = value;
    updateBulkSelectCount();
  }

  async function refreshAfterDeletion(ids) {
    const deleted = new Set(ids);
    reviewRequest += 1;
    for (const id of deleted) selectedShotIds.delete(id);
    updateBulkSelectCount();
    const current = store.get();
    if (deleted.has(current.reviewShotId)) {
      exitReview({ restoreFocus: false });
    } else if (deleted.has(current.compareShotId)) {
      store.set({ compareShotId: null, compareTrace: null, compareShotLabel: "", compareThresholdG: 12 });
      if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
    }
    await withPreservedScroll(() => Promise.all([loadShotHistoryList(), loadRecentShotsList()]));
    const reviewedId = store.get().reviewShotId;
    if (store.get().reviewMode && reviewedId) {
      await refreshReviewCompareOptions(reviewedId);
      const groups = groupShotsByTime(await getAll("shots"));
      const session = groups.find((group) => group.shots.some((shot) => shot.id === reviewedId));
      reviewArrows = buildScorecard(session?.shots || []).arrows;
      updateReviewProgress();
    }
    if (syncAdapter) syncAdapter.updateStatus();
  }

  async function deleteLocalCaptures(ids) {
    const count = await removeSavedShots(ids);
    const message = `Deleted ${count} capture${count === 1 ? "" : "s"} from this browser. Cloud copies are unchanged.`;
    bus.emit("log", message);
    if (el.historyExportStatus) el.historyExportStatus.textContent = message;
    try {
      await refreshAfterDeletion(ids);
    } catch (error) {
      bus.emit("log", `Captures were deleted, but refreshing the view failed: ${error.message}`);
      if (el.historyExportStatus) el.historyExportStatus.textContent = `${message} Reload to refresh the view.`;
    }
    return count;
  }

  async function deleteSavedShot(shotId) {
    if (!shotId || deletionInProgress || exportInProgress) return;
    const returnFocus = document.activeElement;
    setDeletionInProgress(true);
    try {
      const shot = await get("shots", shotId);
      if (!shot) { await refreshAfterDeletion([shotId]); return; }
      const title = shotHistoryLabel(shot);
      const timeStr = new Date(shot.timestamp).toLocaleString();
      const confirmed = confirm(
        `Delete this saved capture from this browser?\n\n${title}\n${timeStr}\n\nCloud copies are unchanged. This cannot be undone.`,
      );
      if (!confirmed) return;
      const rows = [...el.historyList.querySelectorAll(".history-item")];
      const index = rows.findIndex((row) => row.dataset.shotId === shotId);
      const neighborId = (rows[index + 1] || rows[index - 1])?.dataset.shotId;
      await deleteLocalCaptures([shotId]);
      const neighbor = [...el.historyList.querySelectorAll(".history-item")]
        .find((row) => row.dataset.shotId === neighborId)?.querySelector(".history-review-btn");
      (neighbor?.getClientRects().length ? neighbor : el.historySelectModeBtn)?.focus();
    } catch (error) {
      console.error("Failed to delete capture:", error);
      bus.emit("log", `Delete failed: ${error.message}`);
      alert(`Could not delete capture: ${error.message}`);
    } finally {
      setDeletionInProgress(false);
      if (document.activeElement === document.body && returnFocus?.isConnected && returnFocus.getClientRects().length) {
        returnFocus.focus();
      }
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

  function paintShotPreview(canvas, wrap, shot, trace) {
    if (!canvas || !wrap) return;
    const thresholdG = shot.threshold_g != null ? Number(shot.threshold_g) : 12;
    const paint = () => {
      if (trace?.payload?.length >= 2) {
        drawTraceTargetPreview(canvas, trace.payload, { thresholdG,
          captureKind: canRecordArrowOutcome(shot) ? "arrow" : "hold", source: trace.source,
          sampleRateHz: trace.sample_rate_hz });
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recent-shot-card";
    item.dataset.shotId = shot.id;

    const { timeStr, score, stability, peakG, arrow } = recentShotCardMetrics(shot);
    const title = shotHistoryLabel(shot, Math.max(1, totalShots - titleIndex));
    item.setAttribute("aria-label", `Review ${title}, ${timeStr}. Float ${score}${arrow == null ? "" : `, arrow ${arrow}`}`);
    const arrowMetric = arrow == null
      ? ""
      : `
          <span class="recent-shot-metric">
            <span class="metric-label">Arrow</span>
            <strong class="metric-val arrow">${escapeHtml(arrow)}</strong>
          </span>
        `;

    item.innerHTML = `
      <span class="recent-shot-preview-wrap is-empty" aria-hidden="true">
        <canvas class="recent-shot-preview"></canvas>
      </span>
      <span class="recent-shot-header">
        <span class="recent-shot-title">${escapeHtml(title)}</span>
        <span class="recent-shot-time">${escapeHtml(timeStr)}</span>
      </span>
      <span class="recent-shot-metrics">
        ${arrowMetric}
        <span class="recent-shot-metric">
          <span class="metric-label">Float</span>
          <strong class="metric-val score">${score}</strong>
        </span>
        <span class="recent-shot-metric">
          <span class="metric-label">Stability</span>
          <strong class="metric-val stability">${stability}</strong>
        </span>
        <span class="recent-shot-metric">
          <span class="metric-label">Peak G</span>
          <strong class="metric-val peak">${peakG}</strong>
        </span>
      </span>
    `;

    const previewCanvas = item.querySelector(".recent-shot-preview");
    const previewWrap = item.querySelector(".recent-shot-preview-wrap");
    paintShotPreview(previewCanvas, previewWrap, shot, trace);

    item.addEventListener("click", () => {
      reviewShotTrace(shot);
    });
    return item;
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
        return result.then((value) => { finish(); return value; }, (error) => { finish(); throw error; });
      }
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  }

  // Every refresh uses the same newest-first snapshot and request guard.
  async function loadRecentShotsList() {
    if (!el.recentShotsList) return;
    const request = ++recentRequest;
    try {
      const shots = await getAll("shots");
      if (request !== recentRequest) return;
      if (!shots || shots.length === 0) {
        el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">No shots captured in this session yet.</p>`;
        return true;
      }

      shots.sort(newestFirst);
      const recent = shots.slice(0, RECENT_SHOTS_LIMIT);

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
      if (request !== recentRequest) return;

      const focused = document.activeElement;
      const focusedId = el.recentShotsList.contains(focused) ? focused.closest(".recent-shot-card")?.dataset.shotId : null;
      const fragment = document.createDocumentFragment();
      traceEntries.forEach(({ shot, trace }, index) => {
        fragment.appendChild(buildRecentShotCardElement(shot, trace, index, shots.length));
      });
      el.recentShotsList.replaceChildren(fragment);
      if (focusedId && !focused.isConnected && document.activeElement === document.body) {
        [...el.recentShotsList.querySelectorAll(".recent-shot-card")]
          .find((card) => card.dataset.shotId === focusedId)?.focus({ preventScroll: true });
      }
      return true;
    } catch (error) {
      if (request !== recentRequest) return;
      console.error("Error loading recent shots:", error);
      el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">Failed to load recent shots.</p>`;
      return false;
    }
  }

  async function refreshReviewedCapture(localShotId, { restored = false } = {}) {
    if (!localShotId || !store.get().reviewMode || store.get().reviewShotId !== localShotId) return;
    const request = ++reviewUpdateRequest;
    const review = reviewRequest;
    const snapshot = await readSavedReview(localShotId);
    const { shots } = snapshot;
    const shot = shots.find((candidate) => candidate.id === localShotId);
    const trace = snapshot.trace?.payload ? snapshot.trace : { payload: [], sample_rate_hz: 52 };
    if (request !== reviewUpdateRequest || review !== reviewRequest || store.get().reviewShotId !== localShotId) return;
    if (!shot) { exitReview({ restoreFocus: false }); return; }
    const session = groupShotsByTime(shots).find((group) => group.shots.some((arrow) => arrow.id === localShotId));
    const speed = getReviewArrowSpeed(shot, session, snapshot);
    // Refresh telemetry without resetting an unsaved target result or moving
    // focus away from its editor. A changed trace stops the old replay clock.
    const patch = reviewMetrics(shot);
    const current = store.get();
    const traceChanged = JSON.stringify(trace) !== JSON.stringify(reviewedTraceRecord)
      || patch.reviewCaptureKind !== current.reviewCaptureKind || Number(shot.threshold_g ?? 12) !== current.reviewThresholdG;
    if (traceChanged) Object.assign(patch, {
      ...reviewTraceState(shot, trace, speed),
      replayActive: false,
      replayPaused: false,
    });
    else Object.assign(patch, {
      reviewRangeSpeed: speed,
      reviewRangeEst: formatRangeEstimate(calculateRangeFromTimes(current.reviewReleaseTimeMs, current.reviewHitTimeMs, speed.fps), speed),
    });
    reviewedTraceRecord = trace;
    store.set(patch);
    if (restored) {
      reviewArrows = buildScorecard(session?.shots || [shot]).arrows;
      if (!outcomeDirty || !canRecordArrowOutcome(shot)) renderOutcomeEditor(shot);
      else {
        savedOutcomeExists = !!normalizeArrowOutcome(shot) || !!normalizeImpact(shot);
        updateReviewProgress();
        updateOutcomeButtons();
        if (el.reviewOutcomeStatus) el.reviewOutcomeStatus.textContent = "Saved data refreshed. Your unsaved target edits are still here.";
      }
    }
    return shot;
  }

  async function refreshCaptureViews(payload, { restored = false } = {}) {
    if (payload?.duplicate) return;
    try {
      const [views] = await Promise.all([
        withPreservedScroll(() => Promise.all([loadRecentShotsList(), loadShotHistoryList()])),
        refreshReviewedCapture(restored ? store.get().reviewShotId : payload?.localShotId, { restored }),
      ]);
      const current = store.get();
      if (current.reviewMode && current.reviewShotId) await refreshReviewCompareOptions(current.reviewShotId);
      let compared = true;
      if (restored && store.get().reviewMode && store.get().compareShotId) compared = (await loadReviewCompareShot(store.get().compareShotId)) !== false;
      return compared && views.every((result) => result !== false);
    } catch (error) {
      bus.emit("log", `Could not refresh saved captures: ${error.message}`);
      return false;
    }
  }

  bus.on("shot-saved", refreshCaptureViews);
  bus.on("shot-trace-saved", refreshCaptureViews);

  // Keep selection independent of DOM rows, which refresh after saved captures.
  function updateShotSelection(checkbox) {
    if (checkbox.checked) selectedShotIds.add(checkbox.dataset.shotId);
    else selectedShotIds.delete(checkbox.dataset.shotId);
    if (el.historyExportStatus) el.historyExportStatus.textContent = "";
    updateBulkSelectCount();
  }

  function updateBulkSelectCount() {
    const selectedCount = selectedShotIds.size;
    if (el.bulkSelectCount) {
      el.bulkSelectCount.textContent = `${selectedCount} selected`;
    }
    const busy = exportInProgress || deletionInProgress;
    if (el.bulkDeleteBtn) el.bulkDeleteBtn.disabled = selectedCount === 0 || busy;
    if (el.bulkExportBtn) el.bulkExportBtn.disabled = selectedCount === 0 || exportInProgress || deletionInProgress;
    if (el.exportShotBtn) el.exportShotBtn.disabled = busy;
    el.historyList?.querySelectorAll(".history-item-export-btn,.history-item-delete-btn").forEach((button) => { button.disabled = busy; });
  }

  if (el.historySelectModeBtn) {
    el.historySelectModeBtn.addEventListener("click", () => {
      selectedShotIds.clear();
      if (el.historyExportStatus) el.historyExportStatus.textContent = "";
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
      el.bulkSelectAllBtn?.focus();
    });
  }

  if (el.bulkCancelBtn) {
    el.bulkCancelBtn.addEventListener("click", () => {
      selectedShotIds.clear();
      if (el.historyExportStatus) el.historyExportStatus.textContent = "";
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
      el.historySelectModeBtn?.focus();
    });
  }

  if (el.bulkSelectAllBtn) {
    el.bulkSelectAllBtn.addEventListener("click", () => {
      if (!el.historyList) return;
      const checkboxes = el.historyList.querySelectorAll(".history-item-checkbox");
      const allChecked = Array.from(checkboxes).every((chk) => chk.checked);
      checkboxes.forEach((chk) => {
        chk.checked = !allChecked;
        if (chk.checked) selectedShotIds.add(chk.dataset.shotId);
        else selectedShotIds.delete(chk.dataset.shotId);
      });
      if (el.historyExportStatus) el.historyExportStatus.textContent = "";
      updateBulkSelectCount();
    });
  }

  el.bulkExportBtn?.addEventListener("click", async () => {
    if (exportInProgress || deletionInProgress || !selectedShotIds.size) return;
    const ids = [...selectedShotIds];
    const hadFocus = document.activeElement === el.bulkExportBtn;
    exportInProgress = true;
    updateBulkSelectCount();
    el.historyExportStatus.textContent = "Preparing selected shots...";
    try {
      const payload = await exportSelectedShots(ids);
      await download(payload, `openfloat-selected-${exportFileStamp(new Date().toISOString())}.json`);
      const shotCount = payload.stores.shots.length;
      const traceCount = payload.stores.shot_traces.length;
      const message = `Exported ${shotCount} shot${shotCount === 1 ? "" : "s"} and ${traceCount} trace${traceCount === 1 ? "" : "s"}. Restore this file from Settings.`;
      el.historyExportStatus.textContent = message;
      bus.emit("log", message);
      return payload;
    } catch (error) {
      el.historyExportStatus.textContent = `Export failed: ${error.message}`;
      bus.emit("log", `Selected shot export failed: ${error.message}`);
    } finally {
      exportInProgress = false;
      updateBulkSelectCount();
      restoreExportFocus(el.bulkExportBtn, hadFocus);
    }
  });

  if (el.bulkDeleteBtn) {
    el.bulkDeleteBtn.addEventListener("click", async () => {
      if (deletionInProgress || exportInProgress || !selectedShotIds.size) return;
      const ids = [...selectedShotIds];
      const confirmed = confirm(
        `Delete ${ids.length} selected capture${ids.length === 1 ? "" : "s"} from this browser?\n\nCloud copies are unchanged. This cannot be undone.`,
      );
      if (!confirmed) return;
      setDeletionInProgress(true);
      try {
        await deleteLocalCaptures(ids);
        el.historyBulkActions?.classList.add("hidden");
        el.historyDefaultActions?.classList.remove("hidden");
        el.historyList.querySelectorAll(".history-item-checkbox").forEach((checkbox) => checkbox.classList.add("hidden"));
        el.historySelectModeBtn?.focus();
      } catch (error) {
        console.error("Bulk deletion failed:", error);
        alert(`Could not delete captures: ${error.message}`);
      } finally {
        setDeletionInProgress(false);
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
    reviewShotTrace,
    exportSingleShot,
    deleteSavedShot,
    refreshAfterDeletion,
    refreshSavedData: () => refreshCaptureViews(null, { restored: true }),
  };
}
