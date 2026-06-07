// Demo shots shown on first load (no device, empty DB) so new visitors see a
// populated dashboard, history, and shot review. The data is a curated set of
// real OpenFloat captures (decimated to keep the bundle small) in
// sample-shots-data.js. Records are flagged `sample: true` and use device_id
// SAMPLE_DEVICE_ID so the app never syncs them to the cloud and can remove them
// on request.

import { SAMPLE_SHOTS } from "./sample-shots-data.js?v=shot-store-112";

export const SAMPLE_DEVICE_ID = "OpenFloat-Demo";

// Demo shots can persist alongside real practice until the user removes them, so
// date the session a couple of days back to keep it from blending into a real
// same-day session.
const DEMO_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const SHOT_SPACING_MS = 95 * 1000; // ~1.5 min between shots, one session

// Returns { shots: [...], traces: [...] } ready to put() into IndexedDB. Stable
// ids and runtime-applied timestamps make re-seeding idempotent.
export function generateSampleData(now = Date.now()) {
  const shots = [];
  const traces = [];
  const base = now - DEMO_AGE_MS; // timestamp of the most-recent demo shot
  const count = SAMPLE_SHOTS.length;

  SAMPLE_SHOTS.forEach((entry, idx) => {
    const id = `sample-shot-${idx + 1}`;
    // Oldest first in time; most recent demo shot is last.
    const ts = new Date(base - (count - 1 - idx) * SHOT_SPACING_MS).toISOString();

    shots.push({
      id,
      sample: true,
      session_id: null,
      device_id: SAMPLE_DEVICE_ID,
      timestamp: ts,
      label: "Sample shot",
      ...entry.shot,
    });

    const t = entry.trace;
    traces.push({
      shot_id: id,
      sample: true,
      sample_rate_hz: t.sample_rate_hz,
      source: "sample",
      has_mic: !!t.has_mic,
      mic_sample_rate_hz: t.mic_sample_rate_hz || null,
      payload: t.payload,
      mic_series: t.mic_series,
    });
  });

  return { shots, traces };
}
