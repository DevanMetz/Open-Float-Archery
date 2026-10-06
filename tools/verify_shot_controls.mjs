// Verify actual C counter transitions through the browser's wire decoder.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { decodeBinaryFrame } from "../app/protocol/frame.js";

const bytes = readFileSync(process.argv[2]);
const transitions = [
  { kind: "shot", count: 100, id: 70000 },
  { kind: "count", count: 10 },
  { kind: "shot", count: 11, id: 70001 },
  { kind: "count", count: 0 },
  { kind: "shot", count: 1, id: 70002 },
];
const recovery = [
  { count: 51, id: 70003 }, { count: 1, id: 70005 },
  { count: 201, id: 90001 }, { count: 4294967295, id: 1 },
  { count: 101, id: 1 }, { count: 1, id: 0 },
  { count: 1, id: 0 }, { count: 12346, id: 70002 },
];
assert.equal(bytes.length, (transitions.length + 2 + recovery.length) * 29);
for (const [index, expected] of transitions.entries()) {
  const frame = decodeBinaryFrame(bytes, index * 29);
  assert.equal(frame.kind, expected.kind);
  assert.equal(frame.byteLength, 29);
  assert.equal(frame.count ?? frame.shot?.shotCount, expected.count);
  if (expected.kind === "shot") assert.equal(frame.shot.shotId, expected.id);
}
for (let index = 0; index < 2; index++) {
  const frame = decodeBinaryFrame(bytes, (transitions.length + index) * 29);
  assert.equal(frame.kind, "trace");
  assert.equal(frame.trace.shotId, 70002);
  assert.equal(frame.trace.chunkIndex, index);
  assert.equal(frame.trace.totalChunks, 2);
  assert.equal(frame.trace.pointStride, 7);
  assert.equal(frame.trace.payload.length, index === 0 ? 15 : 6);
}
for (const [index, expected] of recovery.entries()) {
  const frame = decodeBinaryFrame(bytes, (transitions.length + 2 + index) * 29);
  assert.equal(frame.kind, "shot");
  assert.equal(frame.shot.shotCount, expected.count);
  assert.equal(frame.shot.shotId, expected.id);
}
console.log("Verified C-to-browser counter corrections, reset, and boot ID recovery, including unsigned wrap.");
