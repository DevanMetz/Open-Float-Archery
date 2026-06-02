// OpenFloat telemetry frame parsing.
//
// Single source of truth for the on-wire formats shared by every transport:
//   - BLE:    a fixed 20-byte binary "live" frame (firmware v1).
//   - Serial: human-readable OFRAW / OFSHOT text lines plus "#" banner lines.
//
// See Blueprint.md section 6 "Implemented v1 Live Frame" for the byte layout.

export const BINARY_FRAME_LEN = 20;
export const GYRO_Q4 = 16; // BLE gyro is deg/s in Q4 fixed point (LSB = 1/16 dps)
export const GYRO_MDPS = 1000; // OFRAW gyro is milli-deg/s
export const ANGLE_CDEG = 100; // OFRAW angles are centi-degrees

const MAGIC_O = 0x4f; // 'O'
const MAGIC_F = 0x46; // 'F'

// Decode one 20-byte binary live frame. Returns a Sample or null.
export function parseBinaryFrame(bytes, offset = 0) {
  if (bytes.length - offset < BINARY_FRAME_LEN) return null;
  if (bytes[offset] !== MAGIC_O || bytes[offset + 1] !== MAGIC_F) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    BINARY_FRAME_LEN,
  );

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
    flags: 0,
  };
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
