// OpenFloat telemetry frame parsing.
//
// Single source of truth for the on-wire formats shared by every transport:
//   - BLE:    a fixed 29-byte binary "live" frame (firmware v1).
//   - Serial: human-readable OFRAW / OFSHOT text lines plus "#" banner lines.
//
// See Blueprint.md section 6 "Implemented v1 Live Frame" for the byte layout.

export const BINARY_FRAME_LEN = 29;
export const GYRO_Q4 = 16; // BLE gyro is deg/s in Q4 fixed point (LSB = 1/16 dps)
export const GYRO_MDPS = 1000; // OFRAW gyro is milli-deg/s
export const ANGLE_CDEG = 100; // OFRAW angles are centi-degrees
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

  return {
    shotId: view.getUint16(4, true),
    chunkIndex: view.getUint8(6),
    totalChunks: view.getUint8(7),
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

// Decode an OFRAW serial line. Returns a Sample or null.
export function parseOfrawLine(line) {
  const parts = line.split(",");
  if (parts[0] !== "OFRAW" || parts.length < 19) return null;
  const n = (i) => Number(parts[i]);

  return {
    source: "text",
    protocol: n(1),
    type: 1,
    sequence: n(2),
    uptimeUs: n(3),
    dtUs: n(4),
    axMg: n(5),
    ayMg: n(6),
    azMg: n(7),
    gxDps: n(8) / GYRO_MDPS,
    gyDps: n(9) / GYRO_MDPS,
    gzDps: n(10) / GYRO_MDPS,
    rollDeg: n(11) / ANGLE_CDEG,
    pitchDeg: n(12) / ANGLE_CDEG,
    yawDeg: n(13) / ANGLE_CDEG,
    flags: 0,
    shotCount: n(18),
    micAmp: 0,
  };
}

// Decode an OFSHOT serial event line. Returns a Shot or null.
export function parseOfshotLine(line) {
  const parts = line.split(",");
  if (parts[0] !== "OFSHOT" || parts.length < 8) return null;

  return {
    shotId: Number(parts[2]),
    uptimeUs: Number(parts[3]),
    axMg: Number(parts[4]),
    ayMg: Number(parts[5]),
    azMg: Number(parts[6]),
    shotCount: Number(parts[7]),
  };
}

// Buffers a newline-delimited text byte stream (serial) and yields decoded
// events: { kind: "sample" | "shot" | "line", ... }.
export class TextLineParser {
  constructor() {
    this.buffer = "";
    this.decoder = new TextDecoder();
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events = [];

    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      const sample = parseOfrawLine(line);
      if (sample) {
        events.push({ kind: "sample", sample });
        continue;
      }

      const shot = parseOfshotLine(line);
      if (shot) {
        events.push({ kind: "shot", shot });
        continue;
      }

      events.push({ kind: "line", line });
    }

    return events;
  }
}
