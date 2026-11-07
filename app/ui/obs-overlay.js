import { fetchLocale, DEFAULT_LOCALE } from "./localization.js?v=1";

const SNAPSHOT_KEY = "openfloat_obs_snapshot";
const CONFIG_KEY = "openfloat_overlay_settings";
const target = document.getElementById("obsTargetCanvas");
const root = document.getElementById("obsOverlayRoot");
const OVERLAY_TYPES = ["counter", "target", "metrics", "review"];
const overlayType = new URLSearchParams(location.search).get("overlay");
const fontOptions = new Set([
  "Inter, Arial, sans-serif",
  "Arial, sans-serif",
  "Georgia, serif",
  "'JetBrains Mono', monospace",
]);
let messages = {};

function readConfig(saved = null) {
  try {
    const config = saved || JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    return {
      font: fontOptions.has(config.font) ? config.font : "Inter, Arial, sans-serif",
      fontSize: Math.min(40, Math.max(14, Number(config.fontSize) || 22)),
      textColor: /^#[0-9a-f]{6}$/i.test(config.textColor) ? config.textColor : "#e6f4ef",
      backgroundColor: /^#[0-9a-f]{6}$/i.test(config.backgroundColor) ? config.backgroundColor : "#071014",
      accentColor: /^#[0-9a-f]{6}$/i.test(config.accentColor) ? config.accentColor : "#35c7e8",
      plannedShots: Math.min(999, Math.max(0, Math.trunc(Number(config.plannedShots) || 0))),
    };
  } catch (error) {
    console.error("Could not read OBS overlay preferences:", error);
    return readConfigDefaults();
  }
}

function readConfigDefaults() {
  return {
    font: "Inter, Arial, sans-serif", fontSize: 22,
    textColor: "#e6f4ef", backgroundColor: "#071014", accentColor: "#35c7e8",
    plannedShots: 0,
  };
}

function applyConfig(config) {
  document.documentElement.style.setProperty("--overlay-font", config.font);
  document.documentElement.style.setProperty("--overlay-font-size", `${config.fontSize}px`);
  document.documentElement.style.setProperty("--overlay-text", config.textColor);
  document.documentElement.style.setProperty("--overlay-background", config.backgroundColor);
  document.documentElement.style.setProperty("--overlay-accent", config.accentColor);
  const isCounter = overlayType === "counter";
  document.querySelector(".obs-overlay-count").classList.toggle("hidden", !isCounter);
  document.getElementById("obsTargetCard").classList.toggle("hidden", overlayType !== "target");
  document.getElementById("obsMetricsCard").classList.toggle("hidden", overlayType !== "metrics");
  document.getElementById("obsReviewCard").classList.toggle("hidden", overlayType !== "review");
}

function metric(label, value) {
  const item = document.createElement("div");
  item.className = "obs-metric";
  const caption = document.createElement("span");
  caption.textContent = messages[label] || label;
  const reading = document.createElement("strong");
  reading.textContent = value != null && Number.isFinite(Number(value))
    ? String(Math.round(Number(value)))
    : "--";
  item.append(caption, reading);
  return item;
}

function drawTarget(trace = []) {
  const side = Math.max(1, Math.min(target.clientWidth || 280, target.clientHeight || 280));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  target.width = Math.round(side * dpr);
  target.height = Math.round(side * dpr);
  const ctx = target.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, side, side);
  const center = side / 2;
  const radius = side * 0.46;
  const colors = ["#f5f1e8", "#171b21", "#2494ca", "#e34c52", "#f3bf4c"];
  for (let index = 0; index < colors.length; index += 1) {
    ctx.beginPath();
    ctx.arc(center, center, radius * (1 - index * 0.2), 0, Math.PI * 2);
    ctx.fillStyle = colors[index];
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.42)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (trace.length < 2) return;
  const usable = trace.filter((point) => Number.isFinite(point.roll) && Number.isFinite(point.pitch));
  const max = Math.max(0.01, ...usable.map((point) => Math.hypot(point.roll, point.pitch)));
  const scale = radius * 0.85 / max;
  ctx.beginPath();
  usable.forEach((point, index) => {
    const x = center - point.roll * scale;
    const y = center - point.pitch * scale;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--overlay-accent").trim();
  ctx.lineWidth = Math.max(2, side / 100);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function renderSnapshot(snapshot) {
  const config = readConfig(snapshot?.overlayConfig);
  applyConfig(config);
  const planned = Number(snapshot?.plannedShots ?? config.plannedShots) || 0;
  document.getElementById("obsShotCount").textContent = String(Math.max(0, Number(snapshot?.shotCount) || 0));
  document.getElementById("obsPlannedCount").textContent = String(planned);

  const latest = snapshot?.latestShot || null;
  const metrics = document.getElementById("obsLastShotMetrics");
  metrics.replaceChildren();
  if (latest) {
    metrics.append(
      metric("metricScore", latest.shot_score),
      metric("metricHold", latest.hold_stability),
      metric("metricRelease", latest.release_quality),
      metric("metricFollowThrough", latest.follow_through),
      metric("metricPeak", latest.peak_g),
    );
  } else {
    metrics.textContent = messages.noShotData || "Waiting for shot data";
  }
  if (overlayType === "target") drawTarget(snapshot?.latestTrace || []);

  const review = document.getElementById("obsSessionReview");
  review.replaceChildren();
  const summary = snapshot?.sessionReview;
  if (summary) {
    review.append(
      metric("metricSessionAverage", summary.average),
      metric("metricSessionBest", summary.best),
      metric("metricSessionTrend", summary.trend),
      metric("metricSessionShots", summary.total),
      metric("metricScoredShots", summary.scored),
    );
  } else {
    review.textContent = messages.noShotData || "Waiting for shot data";
  }
}

function readSnapshot() {
  try {
    const snapshot = localStorage.getItem(SNAPSHOT_KEY);
    renderSnapshot(snapshot ? JSON.parse(snapshot) : null);
  } catch (error) {
    console.error("Could not read OBS overlay session data:", error);
    document.getElementById("obsSessionReview").textContent = messages.overlayLoadError || "Could not read live session data.";
  }
}

async function start() {
  if (!OVERLAY_TYPES.includes(overlayType)) {
    root.classList.remove("hidden");
    root.textContent = messages.overlayInvalidType || "Choose a valid overlay type in Settings.";
    return;
  }
  root.classList.remove("hidden");
  document.querySelector(".app")?.classList.add("hidden");
  let locale = DEFAULT_LOCALE;
  try {
    locale = localStorage.getItem("openfloat_locale") || DEFAULT_LOCALE;
  } catch (error) {
    console.error("Could not read overlay language preference:", error);
  }
  try {
    const loaded = await fetchLocale(locale);
    messages = loaded.messages;
    document.documentElement.lang = loaded.locale;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const message = messages[element.dataset.i18n];
      if (message) element.textContent = message;
    });
    document.title = messages.appTitle || document.title;
  } catch (error) {
    console.error("Failed to load overlay language:", error);
  }
  readSnapshot();
  window.addEventListener("storage", (event) => {
    if (event.key === SNAPSHOT_KEY || event.key === CONFIG_KEY) readSnapshot();
    if (event.key === "openfloat_locale") void refreshLocale(event.newValue || DEFAULT_LOCALE);
  });
  window.addEventListener("openfloat-locale-changed", (event) => {
    void refreshLocale(event.detail.locale);
  });
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel("openfloat-obs");
    channel.addEventListener("message", (event) => renderSnapshot(event.data));
  }
}

async function refreshLocale(locale) {
  try {
    const loaded = await fetchLocale(locale);
    messages = loaded.messages;
    document.documentElement.lang = loaded.locale;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const message = messages[element.dataset.i18n];
      if (message) element.textContent = message;
    });
    document.title = messages.appTitle || document.title;
    readSnapshot();
  } catch (error) {
    console.error("Failed to update OBS overlay language:", error);
  }
}

window.addEventListener("resize", () => {
  try {
    const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
    drawTarget(snapshot?.latestTrace || []);
  } catch (error) {
    console.error("Could not resize OBS target:", error);
  }
});

start();
