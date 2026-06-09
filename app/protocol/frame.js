// OpenFloat telemetry frame parsing.
//
// Single source of truth for the on-wire formats shared by every transport:
//   - BLE:    a fixed 29-byte binary "live" frame (firmware v1).
//   - Serial: human-readable OFRAW / OFSHOT text lines plus "#" banner lines.
//
// See Blueprint.md section 6 "Implemented v1 Live Frame" for the byte layout.

export const BINARY_FRAME_LEN = 29;
export const GYRO_Q4 = 16; // BLE gyro is deg/s in Q4 fixed point (LSB = 1/16 dps)
export const ANGLE_CDEG = 100; // binary-frame angles are centi-degrees
// micAmp (byte 28): firmware noise-gated peak envelope / 3, range 0-255

const MAGIC_O = 0x4f; // 'O'
const MAGIC_F = 0x46; // 'F'

// Decode one 29-byte binary live frame. Returns a Sample or null.
export function parseBinaryFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );

  const qw = view.getInt16(20, true) / 10000;
  const qx = view.getInt16(22, true) / 10000;
  const qy = view.getInt16(24, true) / 10000;
  const qz = view.getInt16(26, true) / 10000;

  // Convert quaternion to Euler angles (Roll, Pitch, Yaw)
  const sinr_cosp = 2 * (qw * qx + qy * qz);
  const cosr_cosp = 1 - 2 * (qx * qx + qy * qy);
  const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

  const sinp = 2 * (qw * qy - qz * qx);
  let pitch;
  if (Math.abs(sinp) >= 1) {
    pitch = Math.sign(sinp) * 90;
  } else {
    pitch = Math.asin(sinp) * (180 / Math.PI);
  }

  const siny_cosp = 2 * (qw * qz + qx * qy);
  const cosy_cosp = 1 - 2 * (qy * qy + qz * qz);
  const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

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
    qw,
    qx,
    qy,
    qz,
    rollDeg: roll,
    pitchDeg: pitch,
    yawDeg: yaw,
    flags: 0,
    micAmp: view.getUint8(28),
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

  return {
    shotCount: view.getUint16(4, true),
    shotId: view.getUint16(6, true),
    axMg: view.getInt16(8, true),
    ayMg: view.getInt16(10, true),
    azMg: view.getInt16(12, true),
    thresholdG: view.getUint16(14, true) / 100,
    rollDeg: view.getInt16(16, true) / ANGLE_CDEG,
    pitchDeg: view.getInt16(18, true) / ANGLE_CDEG,
    yawDeg: view.getInt16(20, true) / ANGLE_CDEG,
    clickerDtMs: view.getUint16(22, true),
    impactDtMs: view.getUint16(24, true),
    shotSequence: view.getUint16(26, true),
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
    uploadShotId: view.getUint16(8, true),
    requested: view.getUint16(10, true) === 1,
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
//       | { kind: "trace", trace } | null.
export function decodeBinaryFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  if (bytes[offset + 3] === 2 || bytes[offset + 3] === 4) {
    const shot = parseBinaryShotFrame(bytes, offset);
    return shot && { kind: "shot", shot };
  }
  if (bytes[offset + 3] === 3) {
    const sync = parseBinaryCountFrame(bytes, offset);
    return sync && { kind: "count", count: sync.count };
  }
  if (bytes[offset + 3] === 5) {
    const storage = parseBinaryStorageFrame(bytes, offset);
    return storage && { kind: "storage", storage };
  }
  if (bytes[offset + 3] === 6) {
    const trace = parseBinaryTraceFrame(bytes, offset);
    return trace && { kind: "trace", trace };
  }
  const sample = parseBinaryFrame(bytes, offset);
  return sample && { kind: "sample", sample };
}

