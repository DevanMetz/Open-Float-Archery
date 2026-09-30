// Consume the golden wire transfer emitted by firmware/tests/trace_buffer_test.c.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeBinaryFrame } from "../app/protocol/frame.js";
import { decodeTimedFirmwareTrace } from "../app/protocol/trace.js";
import { timedFirmwareTraceFrames } from "../test/fixtures/firmware-trace.js";

const bytes = readFileSync(process.argv[2]);
assert.equal(bytes.length, 535 * 29);
assert.deepEqual(new Uint8Array(bytes), new Uint8Array(timedFirmwareTraceFrames().frames.flatMap((frame) => Array.from(frame))));
const payload = [];
for (let i = 0; i < 535; i++) {
  const chunk = decodeBinaryFrame(bytes, i * 29).trace;
  assert.equal(chunk.chunkIndex, i);
  assert.equal(chunk.totalChunks, 535);
  assert.equal(chunk.shotId, 0xfedcba98);
  assert.equal(chunk.timed, true);
  payload.push(...chunk.payload);
}
const decoded = decodeTimedFirmwareTrace(new Uint8Array(payload));
assert.equal(decoded.trace.length, 1000);
assert.equal(decoded.sampleRateHz, 88);
assert.equal(decoded.timing, "device-ms");
let timeMs = -11000;
decoded.trace.forEach((point, i) => {
  if (i) timeMs += i % 3 === 0 ? 19 : (i % 3 === 1 ? 10 : 5);
  assert.deepEqual(point, { roll: (i - 500) / 100, pitch: (1000 - i) / 100,
    yaw: (i * 3 - 1500) / 100, micAmp: i % 256, tUs: timeMs * 1000 });
});
assert.equal(timeMs, 322);
console.log("C-to-JavaScript transfer passed: 535 frames, all 1000 points/timestamps, release origin, and CRC.");
