import test from "node:test";
import assert from "node:assert/strict";
import { EXPORT_FORMAT, normalizeImportPayload } from "../app/core/db.js";

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
