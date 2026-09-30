// Shared review phases. A capture's type and source take precedence over
// motion heuristics; missing release data must not become a guessed shot.
import { traceTimeline } from "./replay.js?v=shot-store-155";

export function tracePhases(trace, { captureKind, source, thresholdG = 12, sampleRateHz = 52, live = false } = {}) {
  const none = { hasRelease: false, releaseIdx: 0, releaseTimeMs: null, breakStart: 0, releaseEnd: 0,
    segments: { hold: 100, break: 0, release: 0, follow: 0 } };
  if (!Array.isArray(trace) || trace.length < 2 || captureKind === "hold" || source === "firmware") return none;

  let releaseIdx = -1;
  // Browser captures and explicitly timed firmware captures anchor their clocks
  // to the recorded device event. Older firmware remains excluded above.
  // Use the nearest recorded sample, even when downsampling misses the impulse.
  const eventTimed = (source === "browser" || source === "firmware-timed") && captureKind === "arrow" &&
    trace.every((point, index) => Number.isFinite(point?.tUs) && (!index || point.tUs >= trace[index - 1].tUs)) &&
    trace[0].tUs <= 0 && trace.at(-1).tUs >= 0 && trace[0].tUs < trace.at(-1).tUs;
  if (eventTimed) {
    releaseIdx = trace.reduce((best, point, index) => Math.abs(point.tUs) < Math.abs(trace[best].tUs) ? index : best, 0);
  } else {
    const threshold = Number.isFinite(Number(thresholdG)) && Number(thresholdG) > 0 ? Number(thresholdG) : 12;
    let maxG = threshold;
    trace.forEach((point, index) => {
      if (![point?.ax, point?.ay, point?.az].every(Number.isFinite)) return;
      const g = Math.hypot(point.ax, point.ay, point.az);
      if (g > maxG) { maxG = g; releaseIdx = index; }
    });
  }
  if (releaseIdx < 0) return none;

  const breakStart = Math.max(0, releaseIdx - Math.max(4, Math.round(trace.length * 0.025)));
  const releaseEnd = Math.min(trace.length - 1, releaseIdx + Math.max(8, Math.round(trace.length * 0.055)));
  // Live buffers mutate in place and their line chart uses sample indices.
  // Only saved recordings use the cached, immutable replay time axis.
  if (live) return { ...none, hasRelease: true, releaseIdx, breakStart, releaseEnd };
  const timeline = traceTimeline(trace, sampleRateHz);
  const elapsed = (index) => timeline.times[index] - timeline.start;
  const total = timeline.durationUs;
  const releaseUs = eventTimed ? 0 : timeline.times[releaseIdx];
  const releaseElapsed = releaseUs - timeline.start;
  const segments = total > 0 ? {
    hold: elapsed(breakStart) / total * 100,
    break: (releaseElapsed - elapsed(breakStart)) / total * 100,
    release: (elapsed(releaseEnd) - releaseElapsed) / total * 100,
    follow: (total - elapsed(releaseEnd)) / total * 100,
  } : none.segments;
  return { hasRelease: true, releaseIdx, releaseTimeMs: releaseUs / 1000, breakStart, releaseEnd, segments };
}

export function phaseForIndex(index, phases) {
  if (!phases.hasRelease || index < phases.breakStart) return "hold";
  if (index < phases.releaseIdx) return "break";
  if (index <= phases.releaseEnd) return "release";
  return "follow";
}
