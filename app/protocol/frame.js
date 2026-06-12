// OpenFloat telemetry frame parsing.
//
// Single source of truth for the on-wire formats shared by every transport:
//   - BLE:    compact binary frames. Live v2 frames are 20 bytes; non-live
//             management/trace frames remain 29 bytes.
//   - Serial: human-readable OFRAW / OFSHOT text lines plus "#" banner lines.
//
// See Blueprint.md section 6 "Implemented v2 Live Frame" for the byte layout.

export const BINARY_FRAME_LEN = 29;
export const BINARY_LIVE_V2_FRAME_LEN = 20;
export const GYRO_Q4 = 16; // BLE gyro is deg/s in Q4 fixed point (LSB = 1/16 dps)
export const ANGLE_CDEG = 100; // binary-frame angles are centi-degrees
export const ACCEL_I8_MG = 100; // v2 live accel is signed deci-g
// micAmp (byte 28): firmware noise-gated peak envelope / 3, range 0-255

const MAGIC_O = 0x4f; // 'O'
const MAGIC_F = 0x46; // 'F'

function normalizeQuaternion({ qw, qx, qy, qz }) {
  const mag = Math.hypot(qw, qx, qy, qz);
  if (!Number.isFinite(mag) || mag <= 0) {
    return { qw: 1, qx: 0, qy: 0, qz: 0 };
  }
  return {
    qw: qw / mag,
    qx: qx / mag,
    qy: qy / mag,
    qz: qz / mag,
  };
}

// Euler remains a derived compatibility view for readouts and legacy scoring.
// Keep quaternion components as the canonical orientation in parsed samples.
export function quaternionToEulerDeg({ qw, qx, qy, qz }) {
  const q = normalizeQuaternion({ qw, qx, qy, qz });

  const sinr_cosp = 2 * (q.qw * q.qx + q.qy * q.qz);
  const cosr_cosp = 1 - 2 * (q.qx * q.qx + q.qy * q.qy);
  const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

  const sinp = 2 * (q.qw * q.qy - q.qz * q.qx);
  const pitch =
    Math.abs(sinp) >= 1
      ? Math.sign(sinp) * 90
      : Math.asin(sinp) * (180 / Math.PI);

  const siny_cosp = 2 * (q.qw * q.qz + q.qx * q.qy);
  const cosy_cosp = 1 - 2 * (q.qy * q.qy + q.qz * q.qz);
  const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

  return { roll, pitch, yaw };
}

// Decode one legacy 29-byte protocol-v1 binary live frame. Returns a Sample or null.
export function parseBinaryFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );

  const quat = normalizeQuaternion({
    qw: view.getInt16(20, true) / 10000,
    qx: view.getInt16(22, true) / 10000,
    qy: view.getInt16(24, true) / 10000,
    qz: view.getInt16(26, true) / 10000,
  });
  const { roll, pitch, yaw } = quaternionToEulerDeg(quat);

  return {
    source: "binary",
    protocol: view.getUint8(2),
    type: view.getUint8(3),
    sequence: view.getUint16(4, true),
    dtUs: view.getUint16(6, true),
    axMg: view.getInt16(8, true),
    ayMg: view.getInt16(10, true),
    azMg: view.getInt16(12, true),
    gxDps: view.getInt16(14, true) / GYRO_Q4,
    gyDps: view.getInt16(16, true) / GYRO_Q4,
    gzDps: view.getInt16(18, true) / GYRO_Q4,
    ...quat,
    rollDeg: roll,
    pitchDeg: pitch,
    yawDeg: yaw,
    flags: 0,
    micAmp: view.getUint8(28),
  };
}

// Decode one 20-byte protocol-v2 live frame. Returns a Sample or null.
export function parseBinaryLiveV2Frame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_LIVE_V2_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_LIVE_V2_FRAME_LEN,
  );
  if (view.getUint8(2) !== 2 || view.getUint8(3) !== 1) return null;

  const quat = normalizeQuaternion({
    qw: view.getInt16(11, true) / 10000,
    qx: view.getInt16(13, true) / 10000,
    qy: view.getInt16(15, true) / 10000,
    qz: view.getInt16(17, true) / 10000,
  });
  const { roll, pitch, yaw } = quaternionToEulerDeg(quat);

  return {
    source: "binary",
    protocol: view.getUint8(2),
    type: view.getUint8(3),
    sequence: view.getUint16(4, true),
    dtUs: view.getUint16(6, true),
    axMg: view.getInt8(8) * ACCEL_I8_MG,
    ayMg: view.getInt8(9) * ACCEL_I8_MG,
    azMg: view.getInt8(10) * ACCEL_I8_MG,
    gxDps: 0,
    gyDps: 0,
    gzDps: 0,
    gyroAvailable: false,
    ...quat,
    rollDeg: roll,
    pitchDeg: pitch,
    yawDeg: yaw,
    flags: 0,
    micAmp: view.getUint8(19),
  };
}

// Decode one 29-byte binary shot-event frame (type=2 live, type=4 stored).
// Returns a Shot or null.
export function parseBinaryShotFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );
  const type = view.getUint8(3);
  if (type !== 2 && type !== 4) return null;
  const lowShotId = view.getUint16(6, true);
  const shotId =
    type === 4 ? lowShotId + view.getUint16(26, true) * 0x10000 : lowShotId;

  return {
    shotCount: view.getUint16(4, true),
    shotId,
    axMg: view.getInt16(8, true),
    ayMg: view.getInt16(10, true),
    azMg: view.getInt16(12, true),
    thresholdG: view.getUint16(14, true) / 100,
    rollDeg: view.getInt16(16, true) / ANGLE_CDEG,
    pitchDeg: view.getInt16(18, true) / ANGLE_CDEG,
    yawDeg: view.getInt16(20, true) / ANGLE_CDEG,
    clickerDtMs: view.getUint16(22, true),
    impactDtMs: view.getUint16(24, true),
    shotSequence: type === 2 ? view.getUint16(26, true) : null,
    stored: type === 4,
  };
}

// Decode one 29-byte count-sync frame (type=3). Returns { count } or null.
// Sent by the device on subscribe so the persisted lifetime count displays
// immediately, without being logged as a new shot.
export function parseBinaryCountFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );
  if (view.getUint8(3) !== 3) return null;

  return { count: view.getUint16(4, true) };
}

export function parseBinaryStorageFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );
  if (view.getUint8(3) !== 5) return null;

  return {
    shotCount: view.getUint16(4, true),
    pending: view.getUint16(6, true),
    uploadShotId: view.getUint16(8, true) + view.getUint16(14, true) * 0x10000,
    requested: view.getUint16(10, true) === 1,
    dropped: view.getUint16(12, true),
    retryAttempts: view.getUint16(16, true),
  };
}

export function parseBinaryTraceStatusFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );
  if (view.getUint8(3) !== 7) return null;

  return {
    shotId: view.getUint16(4, true) + view.getUint16(6, true) * 0x10000,
    status: view.getUint8(8),
  };
}

export function parseBinaryTraceFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );
  if (view.getUint8(3) !== 6) return null;

  const len = view.getUint8(8);
  const payload = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset + offset + 9,
    len
  );

  const chunkIndex = view.getUint8(6);

  return {
    shotId: view.getUint16(4, true),
    chunkIndex,
    totalChunks: view.getUint8(7),
    pointStride: chunkIndex === 0 ? view.getUint8(28) : 0,
    payload: Array.from(payload),
  };
}

// Decode any binary frame, dispatching on the type byte.
// Returns { kind: "sample", sample } | { kind: "shot", shot }
//       | { kind: "count", count } | { kind: "storage", storage }
//       | { kind: "trace", trace } | { kind: "trace-status", traceStatus }
//       | null.
export function decodeBinaryFrame(bytes, offset = 0) {
  if (bytes.length - offset < 4) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  if (bytes[offset + 2] === 2 && bytes[offset + 3] === 1) {
    const sample = parseBinaryLiveV2Frame(bytes, offset);
    return sample && {
      kind: "sample",
      sample,
      byteLength: BINARY_LIVE_V2_FRAME_LEN,
    };
  }

  if (bytes.length - offset < BINARY_FRAME_LEN) return null;

  if (bytes[offset + 3] === 2 || bytes[offset + 3] === 4) {
    const shot = parseBinaryShotFrame(bytes, offset);
    return shot && { kind: "shot", shot, byteLength: BINARY_FRAME_LEN };
  }
  if (bytes[offset + 3] === 3) {
    const sync = parseBinaryCountFrame(bytes, offset);
    return sync && { kind: "count", count: sync.count, byteLength: BINARY_FRAME_LEN };
  }
  if (bytes[offset + 3] === 5) {
    const storage = parseBinaryStorageFrame(bytes, offset);
    return storage && { kind: "storage", storage, byteLength: BINARY_FRAME_LEN };
  }
  if (bytes[offset + 3] === 6) {
    const trace = parseBinaryTraceFrame(bytes, offset);
    return trace && { kind: "trace", trace, byteLength: BINARY_FRAME_LEN };
  }
  if (bytes[offset + 3] === 7) {
    const traceStatus = parseBinaryTraceStatusFrame(bytes, offset);
    return traceStatus && {
      kind: "trace-status",
      traceStatus,
      byteLength: BINARY_FRAME_LEN,
    };
  }
  const sample = parseBinaryFrame(bytes, offset);
  return sample && { kind: "sample", sample, byteLength: BINARY_FRAME_LEN };
}
