function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

export function buildSessionReview(shots) {
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

export function buildSessionFloatPlot(shots) {
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
