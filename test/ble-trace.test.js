import test from "node:test";
import assert from "node:assert/strict";
import { BleAdapter } from "../app/device/adapters.js";
import { EventBus } from "../app/core/store.js";
import { decodeBinaryFrame } from "../app/protocol/frame.js";
import { decodeFirmwareTraceBytes } from "../app/protocol/trace.js";
import { firmwareTraceFrames } from "./fixtures/firmware-trace.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const notify = (adapter, bytes) => adapter._onValue({ target: {
  value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
} });

function adapterForTest(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = new EventBus();
  const adapter = new BleAdapter(bus);
  const commands = [];
  adapter.sendControl = async (command) => { commands.push(command); return true; };
  t.after(() => adapter._stopTraceDownloadTimer());
  return { bus, adapter, commands };
}

test("extended traces round trip all 1000 points with a full 32-bit shot ID", () => {
  const { frames, bytes } = firmwareTraceFrames();
  assert.equal(frames.length, 467);
  const chunks = frames.map((frame) => decodeBinaryFrame(frame).trace);
  assert.equal(chunks[256].chunkIndex, 256);
  assert.ok(chunks.every((chunk) => chunk.shotId === 0xfedcba98 && chunk.totalChunks === 467 && chunk.pointStride === 7));
  assert.deepEqual(new Uint8Array(chunks.flatMap((chunk) => chunk.payload)), bytes);
  const { trace } = decodeFirmwareTraceBytes(bytes, chunks[0].pointStride);
  assert.equal(trace.length, 1000);
  assert.deepEqual(trace[999], { roll: 4.99, pitch: 0.01, yaw: 14.97, micAmp: 231 });
});

test("trace decoder rejects invalid envelope lengths, indexes, versions, strides and counts", () => {
  const good = firmwareTraceFrames().frames[0];
  for (const corrupt of [
    (frame) => frame[12] = 255,
    (frame) => frame[12] = 0,
    (frame) => frame[12] = 14,
    (frame) => frame[13] = 5,
    (frame) => frame[2] = 3,
    (frame) => new DataView(frame.buffer).setUint16(8, 467, true),
    (frame) => new DataView(frame.buffer).setUint16(10, 0, true),
    (frame) => new DataView(frame.buffer).setUint16(10, 468, true),
  ]) {
    const frame = good.slice();
    corrupt(frame);
    assert.equal(decodeBinaryFrame(frame), null);
  }
  const legacy = new Uint8Array(29);
  legacy.set([0x4f, 0x46, 1, 6, 1, 0, 0, 1, 20]);
  const batched = new Uint8Array(58);
  batched.set(legacy);
  batched.set(good, 29);
  assert.equal(decodeBinaryFrame(batched), null, "Length read into the following frame");
  assert.equal(decodeBinaryFrame(batched, 29).trace.shotId, 0xfedcba98);
  assert.equal(decodeBinaryFrame(batched.subarray(29)).trace.totalChunks, 467);
});

test("BLE recovery serializes large uploads, ignores duplicates and rejects stale IDs/status", async (t) => {
  const { adapter, commands, bus } = adapterForTest(t);
  const received = [];
  bus.on("trace-chunk", (trace) => received.push(trace));
  adapter._enqueueTraceDownload(0xfedcba98);
  adapter._enqueueTraceDownload(22);
  await flush();
  assert.deepEqual(commands, ["tracereq2:4275878552"]);
  // Same low 16 bits must not alias an unrelated extended transfer.
  notify(adapter, firmwareTraceFrames(0x0000ba98, 1).frames[0]);
  const frames = firmwareTraceFrames().frames;
  for (const frame of frames.slice(1)) notify(adapter, frame);
  notify(adapter, frames[256]);
  assert.equal(adapter.currentTraceDownloadShotId, 0xfedcba98, "An out-of-order duplicate completed a missing chunk");
  notify(adapter, frames[0]);
  await flush();
  assert.equal(received.length, 468);
  assert.equal(adapter.currentTraceDownloadShotId, 22);
  assert.ok(commands.includes("tracereq2:22"));
  adapter._completeTraceDownload(0xfedcba98);
  assert.equal(adapter.currentTraceDownloadShotId, 22, "An old status finished the next transfer");
});

test("silent older firmware falls back once and preserves legacy low-16-bit ID mapping", async (t) => {
  const { adapter, commands, bus } = adapterForTest(t);
  let received;
  bus.on("trace-chunk", (trace) => { received = trace; });
  adapter._enqueueTraceDownload(0x12345678);
  await flush();
  t.mock.timers.tick(1500);
  await flush();
  assert.deepEqual(commands, ["tracereq2:305419896", "tracereq:305419896"]);
  const frame = new Uint8Array(29);
  frame.set([0x4f, 0x46, 1, 6, 0x78, 0x56, 0, 1, 7]);
  frame[28] = 7;
  notify(adapter, frame);
  assert.equal(received.shotId, 0x12345678);
  adapter._enqueueTraceDownload(33);
  await flush();
  assert.ok(commands.includes("tracereq:33"));
  t.mock.timers.tick(1500);
  assert.equal(adapter.currentTraceDownloadShotId, null);
});

test("trace timeout starts after its queued write and a disconnect cancels delayed work", async (t) => {
  const { adapter, commands } = adapterForTest(t);
  let release;
  adapter.sendControl = (command) => {
    commands.push(command);
    return new Promise((resolve) => { release = resolve; });
  };
  adapter._enqueueTraceDownload(44);
  t.mock.timers.tick(10000);
  assert.equal(commands.length, 1, "Timeout fired while a control write was still queued");
  adapter.manualDisconnect = true;
  adapter._onDrop();
  release(true);
  await flush();
  t.mock.timers.tick(10000);
  assert.equal(commands.length, 1, "Disconnected request scheduled a fallback");
  assert.equal(adapter.currentTraceDownloadShotId, null);
});
