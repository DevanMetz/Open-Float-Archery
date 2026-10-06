// Decode stored metadata produced by the actual firmware restore and encoder.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeBinaryFrame } from "../app/protocol/frame.js";

const bytes = readFileSync(process.argv[2]);
const first = {
  shotCount: 65535, axMg: -1200, ayMg: 250, azMg: 16000, thresholdG: 3.25,
  rollDeg: -1.23, pitchDeg: 4.56, yawDeg: -7.89, clickerDtMs: 15, impactDtMs: 65535,
  shotSequence: null, stored: true,
};
const second = {
  shotCount: 0, axMg: -32768, ayMg: 32767, azMg: -1, thresholdG: 30,
  rollDeg: 0, pitchDeg: -327.68, yawDeg: 327.67, clickerDtMs: 0, impactDtMs: 0,
  shotSequence: null, stored: true,
};
const cases = [
  {...first, shotId: 0xfedcba98}, {...second, shotId: 0},
  {...first, shotId: 0xba98}, {...second, shotId: 65535},
  {...first, shotId: 0xba98, clickerDtMs: 0, impactDtMs: 0}, {...second, shotId: 65535},
  {...first, shotId: 0xffffffff},
];
assert.equal(bytes.length, cases.length * 29);
for (const [index, shot] of cases.entries()) {
  assert.deepEqual(decodeBinaryFrame(bytes, index * 29), {kind: "shot", byteLength: 29, shot});
}
console.log("Verified seven C-restored stored frames: legacy migration, signed fields, full IDs, and timing.");
