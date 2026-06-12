import test from "node:test";
import assert from "node:assert/strict";

import {
  BINARY_FRAME_LEN,
  BINARY_LIVE_V2_FRAME_LEN,
  decodeBinaryFrame,
  parseBinaryLiveV2Frame,
  quaternionToEulerDeg,
} from "../app/protocol/frame.js";

function frame29(type) {
  const bytes = new Uint8Array(BINARY_FRAME_LEN);
  bytes[0] = 0x4f;
  bytes[1] = 0x46;
  bytes[2] = 1;
  bytes[3] = type;
  return bytes;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function setU16(bytes, offset, value) {
  view(bytes).setUint16(offset, value, true);
}

function setI16(bytes, offset, value) {
  view(bytes).setInt16(offset, value, true);
}

function liveV2Frame({
  sequence,
  dtUs = 900,
  axDeciG = 0,
  ayDeciG = 0,
  azDeciG = 10,
  quat = [10000, 0, 0, 0],
  micAmp = 0,
}) {
  const bytes = new Uint8Array(BINARY_LIVE_V2_FRAME_LEN);
  bytes[0] = 0x4f;
  bytes[1] = 0x46;
  bytes[2] = 2;
  bytes[3] = 1;
  setU16(bytes, 4, sequence);
  setU16(bytes, 6, dtUs);
  bytes[8] = axDeciG & 0xff;
  bytes[9] = ayDeciG & 0xff;
  bytes[10] = azDeciG & 0xff;
  for (let i = 0; i < quat.length; i++) {
    setI16(bytes, 11 + i * 2, quat[i]);
  }
  bytes[19] = micAmp;
  return bytes;
}

test("parseBinaryLiveV2Frame decodes the 20-byte firmware live layout", () => {
  const sample = parseBinaryLiveV2Frame(liveV2Frame({
    sequence: 65535,
    axDeciG: -2,
    ayDeciG: 3,
    azDeciG: 10,
    micAmp: 77,
  }));

  assert.equal(sample.protocol, 2);
  assert.equal(sample.type, 1);
  assert.equal(sample.sequence, 65535);
  assert.equal(sample.dtUs, 900);
  assert.equal(sample.axMg, -200);
  assert.equal(sample.ayMg, 300);
  assert.equal(sample.azMg, 1000);
  assert.equal(sample.gyroAvailable, false);
  assert.equal(sample.qw, 1);
  assert.equal(sample.qx, 0);
  assert.equal(sample.qy, 0);
  assert.equal(sample.qz, 0);
  assert.equal(sample.rollDeg, 0);
  assert.equal(sample.pitchDeg, 0);
  assert.equal(sample.yawDeg, 0);
  assert.equal(sample.micAmp, 77);
});

test("decodeBinaryFrame walks a 120-byte batched notification as six v2 frames", () => {
  const notification = new Uint8Array(BINARY_LIVE_V2_FRAME_LEN * 6);
  const sequences = [65534, 65535, 0, 1, 2, 3];

  for (let i = 0; i < sequences.length; i++) {
    notification.set(liveV2Frame({
      sequence: sequences[i],
      micAmp: 20 + i,
      azDeciG: 10 + i,
    }), i * BINARY_LIVE_V2_FRAME_LEN);
  }

  const decoded = [];
  for (let offset = 0; offset < notification.length;) {
    const frame = decodeBinaryFrame(notification, offset);
    assert.equal(frame.kind, "sample");
    decoded.push(frame.sample);
    offset += frame.byteLength;
  }

  assert.deepEqual(decoded.map((sample) => sample.sequence), sequences);
  assert.deepEqual(decoded.map((sample) => sample.micAmp), [20, 21, 22, 23, 24, 25]);
  assert.deepEqual(decoded.map((sample) => sample.azMg), [1000, 1100, 1200, 1300, 1400, 1500]);
});

test("decodeBinaryFrame decodes a 29-byte shot event frame", () => {
  const bytes = frame29(2);
  setU16(bytes, 4, 321);
  setU16(bytes, 6, 1234);
  setI16(bytes, 8, -1200);
  setI16(bytes, 10, 250);
  setI16(bytes, 12, 980);
  setU16(bytes, 14, 275);
  setI16(bytes, 16, -123);
  setI16(bytes, 18, 456);
  setI16(bytes, 20, 789);
  setU16(bytes, 22, 12);
  setU16(bytes, 24, 34);
  setU16(bytes, 26, 65535);

  assert.deepEqual(decodeBinaryFrame(bytes), {
    kind: "shot",
    byteLength: BINARY_FRAME_LEN,
    shot: {
      shotCount: 321,
      shotId: 1234,
      axMg: -1200,
      ayMg: 250,
      azMg: 980,
      thresholdG: 2.75,
      rollDeg: -1.23,
      pitchDeg: 4.56,
      yawDeg: 7.89,
      clickerDtMs: 12,
      impactDtMs: 34,
      shotSequence: 65535,
      stored: false,
    },
  });
});

test("decodeBinaryFrame decodes count-sync, storage-status, stored-shot, trace-status, and trace-chunk envelopes", () => {
  const count = frame29(3);
  setU16(count, 4, 4321);
  assert.deepEqual(decodeBinaryFrame(count), {
    kind: "count",
    count: 4321,
    byteLength: BINARY_FRAME_LEN,
  });

  const storage = frame29(5);
  setU16(storage, 4, 500);
  setU16(storage, 6, 7);
  setU16(storage, 8, 0x5678);
  setU16(storage, 10, 1);
  setU16(storage, 12, 3);
  setU16(storage, 14, 0x1234);
  setU16(storage, 16, 4);
  assert.deepEqual(decodeBinaryFrame(storage), {
    kind: "storage",
    byteLength: BINARY_FRAME_LEN,
    storage: {
      shotCount: 500,
      pending: 7,
      uploadShotId: 0x12345678,
      requested: true,
      dropped: 3,
      retryAttempts: 4,
    },
  });

  const storedShot = frame29(4);
  setU16(storedShot, 4, 222);
  setU16(storedShot, 6, 0x5678);
  setI16(storedShot, 8, 1000);
  setI16(storedShot, 10, -2000);
  setI16(storedShot, 12, 500);
  setU16(storedShot, 14, 300);
  setI16(storedShot, 16, 100);
  setI16(storedShot, 18, -250);
  setI16(storedShot, 20, 0);
  setU16(storedShot, 22, 40);
  setU16(storedShot, 24, 60);
  setU16(storedShot, 26, 0x1234);
  assert.equal(decodeBinaryFrame(storedShot).shot.shotId, 0x12345678);
  assert.equal(decodeBinaryFrame(storedShot).shot.stored, true);

  const traceStatus = frame29(7);
  setU16(traceStatus, 4, 0xdef0);
  setU16(traceStatus, 6, 0x9abc);
  traceStatus[8] = 2;
  assert.deepEqual(decodeBinaryFrame(traceStatus), {
    kind: "trace-status",
    byteLength: BINARY_FRAME_LEN,
    traceStatus: {
      shotId: 0x9abcdef0,
      status: 2,
    },
  });

  const traceChunk = frame29(6);
  setU16(traceChunk, 4, 0xbeef);
  traceChunk[6] = 0;
  traceChunk[7] = 3;
  traceChunk[8] = 5;
  traceChunk.set([9, 8, 7, 6, 5], 9);
  traceChunk[28] = 7;
  assert.deepEqual(decodeBinaryFrame(traceChunk), {
    kind: "trace",
    byteLength: BINARY_FRAME_LEN,
    trace: {
      shotId: 0xbeef,
      chunkIndex: 0,
      totalChunks: 3,
      pointStride: 7,
      payload: [9, 8, 7, 6, 5],
    },
  });
});

test("malformed or unknown binary input returns null or the legacy fallback without throwing", () => {
  assert.doesNotThrow(() => decodeBinaryFrame(new Uint8Array([0x4f, 0x46, 2])));
  assert.equal(decodeBinaryFrame(new Uint8Array([0x4f, 0x46, 2])), null);
  assert.doesNotThrow(() => decodeBinaryFrame(new Uint8Array(BINARY_FRAME_LEN)));
  assert.equal(decodeBinaryFrame(new Uint8Array(BINARY_FRAME_LEN)), null);

  const unknown = frame29(99);
  assert.doesNotThrow(() => decodeBinaryFrame(unknown));
  assert.equal(decodeBinaryFrame(unknown).kind, "sample");
  assert.equal(decodeBinaryFrame(unknown).sample.type, 99);
});

test("quaternionToEulerDeg normalizes inputs and decodes cardinal rotations", () => {
  const identity = quaternionToEulerDeg({ qw: 2, qx: 0, qy: 0, qz: 0 });
  assert.equal(identity.roll, 0);
  assert.equal(identity.pitch, 0);
  assert.equal(identity.yaw, 0);

  const halfSqrt = Math.SQRT1_2;
  const yaw90 = quaternionToEulerDeg({ qw: halfSqrt, qx: 0, qy: 0, qz: halfSqrt });
  assert.equal(Math.round(yaw90.roll), 0);
  assert.equal(Math.round(yaw90.pitch), 0);
  assert.equal(Math.round(yaw90.yaw), 90);
});
