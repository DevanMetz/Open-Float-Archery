import test from "node:test";
import assert from "node:assert/strict";

import { CloudSyncAdapter } from "../app/telemetry/sync.js";

test("cloud upsert can strip every outcome field for an older schema", async () => {
  const unsupported = new Set([
    "arrow_score",
    "arrow_is_x",
    "target_distance",
    "target_distance_unit",
    "target_face_cm",
    "outcome_recorded_at",
    "impact_x",
    "impact_y",
    "impact_recorded_at",
  ]);
  const attempts = [];
  const logs = [];
  const supabase = {
    from(table) {
      assert.equal(table, "shots");
      return {
        async upsert(payload) {
          attempts.push({ ...payload });
          const missing = Object.keys(payload).find((key) => unsupported.has(key));
          return missing
            ? { error: { message: `Could not find the '${missing}' column of 'shots' in the schema cache` } }
            : { error: null };
        },
      };
    },
  };
  const adapter = Object.create(CloudSyncAdapter.prototype);
  adapter.user = { id: "user-1" };
  adapter.reportedSchemaSkips = new Set();
  adapter.bus = { emit: (_event, message) => logs.push(message) };

  await adapter.syncTask(supabase, {
    table: "shots",
    action: "UPDATE",
    targetId: "shot-1",
    payload: {
      id: "shot-1",
      arrow_score: 10,
      arrow_is_x: true,
      target_distance: 20,
      target_distance_unit: "yd",
      target_face_cm: 40,
      outcome_recorded_at: "2026-01-01T00:00:00Z",
      impact_x: 0.1,
      impact_y: -0.2,
      impact_recorded_at: "2026-01-01T00:00:00Z",
    },
  });

  assert.equal(attempts.length, 10);
  assert.deepEqual(attempts.at(-1), { id: "shot-1", user_id: "user-1" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /arrow_score/);
});
