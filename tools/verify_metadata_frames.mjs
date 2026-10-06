// Decode bytes from the firmware's actual counter writer with the browser parser.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { decodeBinaryFrame } from "../app/protocol/frame.js";

const bytes = readFileSync(process.argv[2]);
const cases = [[0, 0], [65535, 65535], [65536, 65536], [2147483647, 0xfedcba98], [0xffffffff, 0xffffffff]];
assert.equal(bytes.length, cases.length * 3 * 29);
for (const [index, [shotCount, shotId]] of cases.entries()) {
  const offset = index * 3 * 29;
  assert.deepEqual(decodeBinaryFrame(bytes, offset), { kind: "shot", byteLength: 29, shot: {
    shotCount, shotId, axMg: -1200, ayMg: 250, azMg: 16000, thresholdG: 3.25,
    rollDeg: -1.23, pitchDeg: 4.56, yawDeg: -7.89,
    clickerDtMs: null, impactDtMs: null, shotSequence: 65535, stored: false,
  } });
  assert.equal(decodeBinaryFrame(bytes, offset + 29).count, shotCount);
  assert.deepEqual(decodeBinaryFrame(bytes, offset + 58).storage, {
    shotCount, pending: 7, uploadShotId: shotId, requested: true, dropped: 3, retryAttempts: 4,
  });
}
console.log("Verified 15 firmware metadata frames: full counters, motion, sequence, and queue status.");
