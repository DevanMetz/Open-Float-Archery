// Experimental acoustic range estimate: arrow flight plus returning sound.
// Keep the existing 1125 fps sound speed and drag approximation; this is not
// a measured target distance. Both automatic and dragged markers use it.
export const ASSUMED_ARROW_SPEED_FPS = 280;

function finiteNumber(value) {
  if (typeof value === "string" && value.trim()) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function arrowSpeedFps(value) {
  const fps = finiteNumber(value);
  return fps !== null && fps > 0 ? fps : null;
}

export function calculateRangeFromTimes(releaseTimeMs, hitTimeMs, speed) {
  const fps = arrowSpeedFps(speed);
  if (!Number.isFinite(releaseTimeMs) || !Number.isFinite(hitTimeMs) || fps === null) return null;
  const seconds = (hitTimeMs - releaseTimeMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const sound = 1125, drag = 0.075;
  const b = -(sound + fps + seconds * drag * sound);
  const c = seconds * fps * sound;
  const discriminant = b * b - 4 * drag * c;
  if (!Number.isFinite(discriminant) || discriminant < 0) return null;
  // The smaller positive quadratic root, avoiding cancellation at short times.
  const feet = 2 * c / (-b + Math.sqrt(discriminant));
  return Number.isFinite(feet) && feet > 0 ? { feet, yards: feet / 3 } : null;
}

export function formatRangeEstimate(range, speed) {
  if (!range) return "";
  const provenance = speed.source === "assumed" ? " (assumed)"
    : speed.source === "active" ? " (current bow)" : "";
  return `| Est. Range: ${range.yards.toFixed(1)} yds (${Math.round(range.feet)} ft) @ ${speed.fps} fps${provenance}`;
}

// Preserve the existing 200-2200 ms search window and envelope thresholds.
// Use the saved microphone clock, which can be finer than the motion samples.
export function findImpactTimeMs(series, releaseTimeMs) {
  if (!Array.isArray(series) || !series.length || !Number.isFinite(releaseTimeMs)) return null;
  series = Array.from(series, (point) => ({ tUs: finiteNumber(point?.tUs), micAmp: finiteNumber(point?.micAmp) }));
  if (!series.every((point, index) => point.tUs !== null && point.micAmp !== null
      && point.micAmp >= 0 && (!index || point.tUs >= series[index - 1].tUs))) return null;
  const start = series.findIndex((point) => point.tUs >= (releaseTimeMs + 200) * 1000);
  if (start < 0) return null;
  const endUs = (releaseTimeMs + 2200) * 1000;
  let first = -1;
  for (let i = start; i < series.length && series[i].tUs <= endUs; i++) {
    if (series[i].micAmp > 15) { first = i; break; }
  }
  if (first < 0) return null;
  let peak = first;
  for (let i = first + 1; i < series.length && series[i].tUs <= endUs && series[i].micAmp > 15; i++) {
    if (series[i].micAmp > series[peak].micAmp) peak = i;
  }
  let onset = peak;
  while (onset > start && series[onset].micAmp >= 10) onset--;
  return series[onset].tUs / 1000;
}
