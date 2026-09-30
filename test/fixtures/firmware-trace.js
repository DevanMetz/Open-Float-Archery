// Wire fixture shared by Node and the native browser storage checks.
export function firmwareTraceFrames(shotId = 0xfedcba98, count = 1000) {
  const bytes = new Uint8Array(count * 7);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    view.setInt16(i * 7, i - 500, true);
    view.setInt16(i * 7 + 2, 1000 - i, true);
    view.setInt16(i * 7 + 4, i * 3 - 1500, true);
    view.setUint8(i * 7 + 6, i % 256);
  }
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
    frame[13] = 7;
    frame.set(payload, 14);
    frames.push(frame);
  }
  return { bytes, frames };
}
