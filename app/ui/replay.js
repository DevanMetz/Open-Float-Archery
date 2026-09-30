// Saved review arrays are immutable snapshots. Cache their time axis so a long
// recording or full-rate microphone stream is scanned only once per review.
const timelines = new WeakMap();

export function traceTimeline(trace, sampleRateHz = 52) {
  if (!Array.isArray(trace) || !trace.length) return { times: [], start: 0, end: 0, durationUs: 0 };
  const rate = Number.isFinite(Number(sampleRateHz)) && Number(sampleRateHz) > 0 ? Number(sampleRateHz) : 52;
  const cached = timelines.get(trace);
  if (cached?.rate === rate && cached.times.length === trace.length) return cached;
  let times = trace.map((point) => {
    const value = point?.tUs;
    return value == null || value === "" ? NaN : Number(value);
  });
  const timed = times.every((time, index) => Number.isFinite(time) && (!index || time >= times[index - 1])) &&
    (times.length === 1 || times.at(-1) > times[0]);
  // Old firmware has no timestamps. Incomplete or unordered imported timing
  // also uses a single uniform clock rather than mixing incompatible axes.
  if (!timed) times = trace.map((_, index) => index * 1000000 / rate);
  const timeline = { times, start: times[0], end: times.at(-1), durationUs: times.at(-1) - times[0], rate };
  timelines.set(trace, timeline);
  return timeline;
}

// Hold the last recorded point through a gap; never show a future sample.
// -1 lets the microphone meter stay empty before its shorter pre-roll starts.
export function timelineIndexAt(timeline, timeUs) {
  let low = 0;
  let high = timeline.times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline.times[middle] <= timeUs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function replayPosition(trace, progress = 1, sampleRateHz = 52) {
  const timeline = traceTimeline(trace, sampleRateHz);
  const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 1;
  const timeUs = timeline.start + fraction * timeline.durationUs;
  return { timeUs, durationUs: timeline.durationUs, index: timelineIndexAt(timeline, timeUs) };
}

export function createReplayController(store) {
  let frame = null;
  let generation = 0;
  function cancel() {
    generation += 1;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function toggle() {
    const state = store.get();
    if (!state.reviewMode || state.chartView !== "target") return;
    cancel();
    if (state.replayActive && !state.replayPaused) {
      store.set({ replayPaused: true });
      return;
    }
    const durationMs = traceTimeline(state.reviewTrace, state.reviewSampleRateHz).durationUs / 1000;
    if (durationMs <= 0) return;
    const run = generation;
    let lastTime = performance.now();
    store.set({ replayActive: true, replayPaused: false, replayProgress: state.replayProgress >= 1 ? 0 : (state.replayProgress || 0) });

    function tick(now) {
      if (run !== generation) return;
      frame = null;
      const current = store.get();
      if (!current.reviewMode || current.chartView !== "target" || !current.replayActive || current.replayPaused ||
          current.reviewShotId !== state.reviewShotId || current.reviewTrace !== state.reviewTrace) return;
      const speed = Number(current.replaySpeed) > 0 ? Number(current.replaySpeed) : 1;
      const progress = Math.min(1, current.replayProgress + Math.max(0, now - lastTime) * speed / durationMs);
      lastTime = now;
      store.set({ replayProgress: progress, replayActive: progress < 1, replayPaused: false });
      if (progress < 1 && run === generation) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }

  function seek(progress) {
    cancel();
    store.set({ replayActive: false, replayPaused: false, replayProgress: Math.max(0, Math.min(1, progress)) });
  }

  return { toggle, seek };
}
