// Wire fixture shared by Node and the native browser storage checks.
import { traceCrc32 } from "../../app/protocol/trace.js?v=shot-store-155";
export function firmwareTraceFrames(shotId = 0xfedcba98, count = 1000) {
  const bytes = new Uint8Array(count * 7);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    view.setInt16(i * 7, i - 500, true);
    view.setInt16(i * 7 + 2, 1000 - i, true);
    view.setInt16(i * 7 + 4, i * 3 - 1500, true);
    view.setUint8(i * 7 + 6, i % 256);
  }
  return { bytes, frames: encodeFrames(bytes, shotId, 7) };
}

export function timedFirmwareTraceFrames({ shotId = 0xfedcba98, count = 1000, flags = 1,
  firstTimeMs = -11000, intervals = [19, 10, 5] } = {}) {
  const bytes = new Uint8Array(12 + count * 8);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = flags;
  view.setUint16(2, count, true);
  view.setInt32(4, firstTimeMs, true);
  for (let i = 0; i < count; i++) {
    const offset = 8 + i * 8;
    view.setInt16(offset, i - 500, true);
    view.setInt16(offset + 2, 1000 - i, true);
    view.setInt16(offset + 4, i * 3 - 1500, true);
    bytes[offset + 6] = i % 256;
    bytes[offset + 7] = flags && i ? intervals[i % intervals.length] : 0;
  }
  view.setUint32(bytes.length - 4, traceCrc32(bytes.subarray(0, -4)), true);
  return { bytes, frames: encodeFrames(bytes, shotId, 0x88) };
}

function encodeFrames(bytes, shotId, format) {
  const frames = [];
  const total = Math.ceil(bytes.length / 15);
  for (let i = 0; i < total; i++) {
    const frame = new Uint8Array(29);
    const header = new DataView(frame.buffer);
    frame.set([0x4f, 0x46, 2, 6]);
    header.setUint32(4, shotId, true);
    header.setUint16(8, i, true);
    header.setUint16(10, total, true);
    const payload = bytes.subarray(i * 15, (i + 1) * 15);
    frame[12] = payload.length;
    frame[13] = format;
    frame.set(payload, 14);
    frames.push(frame);
  }
  return frames;
}
