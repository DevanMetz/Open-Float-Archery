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
const SAMPLE_ARROW_SCORES = [6, 6, 8, 9, 8, 5];
// Normalized to target radius: +x is right and +y is high. These placements
// match the sample scores closely enough to demonstrate group analysis while
// preserving the measured telemetry attached to each capture.
const SAMPLE_IMPACTS = [
  { x: 0.10, y: 0.44 },
  { x: 0.30, y: -0.33 },
  { x: 0.12, y: 0.18 },
  { x: -0.12, y: 0.09 },
  { x: -0.20, y: 0.12 },
  { x: -0.45, y: 0.33 },
];

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
      arrow_score: SAMPLE_ARROW_SCORES[idx] ?? null,
      arrow_is_x: false,
      target_distance: 20,
      target_distance_unit: "yd",
      target_face_cm: 40,
      outcome_recorded_at: ts,
      impact_x: SAMPLE_IMPACTS[idx]?.x ?? null,
      impact_y: SAMPLE_IMPACTS[idx]?.y ?? null,
      impact_recorded_at: ts,
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
