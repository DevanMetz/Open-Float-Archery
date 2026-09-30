import test from "node:test";
import assert from "node:assert/strict";
import { EXPORT_FORMAT, buildImportSyncTasks, normalizeImportPayload } from "../app/core/db.js";

test("full backup validation preserves known and future record stores", () => {
  const stores = { shots: [{ id: "arrow-1" }], future_store: [{ id: "future" }] };
  assert.equal(normalizeImportPayload({ format: EXPORT_FORMAT, version: 1, stores }).stores, stores);
  assert.equal(normalizeImportPayload({ format: EXPORT_FORMAT, stores }).version, 1);
});

test("single-shot imports normalize to the same atomic backup envelope", () => {
  const shot = { id: "arrow-1" };
  const trace = { shot_id: "arrow-1", payload: [] };
  const result = normalizeImportPayload({ format: "openfloat-shot-export", version: 1, shot, trace });
  assert.equal(result.format, EXPORT_FORMAT);
  assert.deepEqual(result.stores, { shots: [shot], shot_traces: [trace] });
  assert.deepEqual(normalizeImportPayload({ format: "openfloat-shot-export", shot }).stores.shot_traces, []);
});

test("single-shot imports reject mismatched traces before any database write", () => {
  for (const trace of [{ shot_id: "different-arrow" }, [], "invalid"]) {
    assert.throws(() => normalizeImportPayload({
      format: "openfloat-shot-export", shot: { id: "arrow-1" }, trace,
    }), /does not belong/);
  }
  for (const shot of [null, [], {}, { id: " " }]) {
    assert.throws(() => normalizeImportPayload({ format: "openfloat-shot-export", shot }), /valid shot id/);
  }
});

test("malformed backup envelopes and unsupported versions fail visibly", () => {
  for (const payload of [null, [], { format: "unknown" }]) {
    assert.throws(() => normalizeImportPayload(payload), /Unrecognized/);
  }
  assert.throws(() => normalizeImportPayload({ format: EXPORT_FORMAT, version: 2, stores: {} }), /Unsupported/);
  for (const stores of [null, [], "invalid"]) {
    assert.throws(() => normalizeImportPayload({ format: EXPORT_FORMAT, stores }), /data stores/);
  }
  for (const shots of [null, {}, "invalid", [null], [false], [[]]]) {
    assert.throws(() => normalizeImportPayload({ format: EXPORT_FORMAT, stores: { shots } }), /list of records/);
  }
});

test("import queues fresh uploads in dependency order instead of replaying exported work", () => {
  const tasks = buildImportSyncTasks({
    shot_traces: [{ shot_id: "arrow" }],
    shots: [{ id: "arrow", arrow_score: 7 }, { id: "arrow", arrow_score: 9 }],
    sessions: [{ id: "practice" }],
    bow_profiles: [{ id: "bow" }],
    sync_queue: [{ id: 1, table: "shots", action: "DELETE", targetId: "unrelated" }],
  });
  assert.deepEqual(tasks.map((task) => task.table), ["bow_profiles", "sessions", "shots", "shot_traces"]);
  assert.equal(tasks[2].payload.arrow_score, 9);
  assert.ok(tasks.every((task) => task.action === "CREATE" && task.status === "pending" && task.id === undefined));
});

test("imported sample shots and their unflagged traces never enter the upload queue", () => {
  const tasks = buildImportSyncTasks({
    shots: [{ id: "sample", sample: true }, { id: "demo", device_id: "OpenFloat-Demo" }, { id: "real" }],
    shot_traces: [{ shot_id: "sample" }, { shot_id: "demo" }, { shot_id: "legacy", source: "sample" }, { shot_id: "real" }],
    session_overrides: [{ id: "real", name: "Local session" }],
  });
  assert.deepEqual(tasks.map((task) => [task.table, task.targetId]), [["shots", "real"], ["shot_traces", "real"]]);
});
