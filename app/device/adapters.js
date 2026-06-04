// Device adapters: one small class per transport, all behind the same
// interface so the rest of the app never branches on how data arrives.
//
//   adapter.connect()      -> Promise, begins streaming
//   adapter.disconnect()   -> Promise, stops and cleans up
//   adapter.name           -> human label
//   adapter.sequenceStep   -> expected sequence increment (for loss detection)
//
// Adapters communicate outward only through the shared EventBus:
//   "sample" -> Sample, "shot" -> Shot, "log" -> string,
//   "status" -> { mode, text }

import { BINARY_FRAME_LEN, decodeBinaryFrame, TextLineParser } from "../protocol/frame.js?v=shot-store-7";

const OPENFLOAT_SERVICE = "8f3f3b10-0f5a-4f4c-9a2d-000000000001";
const OPENFLOAT_LIVE = "8f3f3b10-0f5a-4f4c-9a2d-000000000002";
const OPENFLOAT_CONTROL = "8f3f3b10-0f5a-4f4c-9a2d-000000000003";

class BaseAdapter {
  constructor(bus) {
    this.bus = bus;
    this.connected = false;
  }

  log(message) {
    this.bus.emit("log", message);
  }

  status(mode, text) {
    this.bus.emit("status", { mode, text });
  }

  emitSample(sample) {
    this.bus.emit("sample", { ...sample, sequenceStep: this.sequenceStep });
  }

  // Transports that support a control channel override this. Default is a
  // no-op so the UI can call it unconditionally.
  async sendControl(command) {
    this.log(`Control channel not available on ${this.name}.`);
    return false;
  }
}

// Synthetic stream so the dashboard is usable with no hardware attached.
export class DemoAdapter extends BaseAdapter {
  get name() {
    return "Demo";
  }

  get sequenceStep() {
    return 1;
  }

  async connect() {
    this.connected = true;
    let seq = 0;
    this.status("demo", "Demo stream");
    this.log("Demo stream started.");

    this.timer = setInterval(() => {
      const t = performance.now() / 1000;
      this.emitSample({
        source: "demo",
        protocol: 1,
        type: 1,
        sequence: seq++,
        dtUs: 2400,
        axMg: Math.round(Math.sin(t * 4) * 180),
        ayMg: Math.round(Math.cos(t * 3) * 120),
        azMg: Math.round(980 + Math.sin(t * 2) * 35),
        gxDps: Math.sin(t * 5) * 18,
        gyDps: Math.cos(t * 4) * 12,
        gzDps: Math.sin(t * 3) * 8,
        flags: 0,
      });
    }, 16);
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
    this.status("", "Disconnected");
    this.log("Demo stream stopped.");
  }
}

// Web Serial: the firmware emits OFRAW/OFSHOT text lines at 115200 baud.
export class SerialAdapter extends BaseAdapter {
  constructor(bus, { baudRate = 115200 } = {}) {
    super(bus);
    this.baudRate = baudRate;
  }

  get name() {
    return "Serial";
  }

  // Firmware prints every 8th IMU sample, so sequence advances by 8.
  get sequenceStep() {
    return 8;
  }

  async connect() {
    if (!("serial" in navigator)) {
      this.log("Web Serial unavailable. Use Chrome/Edge over https or localhost.");
      throw new Error("Web Serial not supported");
    }

    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    if (this.port.setSignals) {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    }

    this.reader = this.port.readable.getReader();
    this.connected = true;
    this.keepReading = true;

    this.status("live", `Live serial @ ${this.baudRate}`);
    this.log(
      `Serial connected @ ${this.baudRate} (DTR/RTS asserted). ` +
        "Press reset on the module if no frames appear.",
    );

    this._readLoop(new TextLineParser());
  }

  async _readLoop(parser) {
    try {
      while (this.keepReading && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;

        for (const event of parser.feed(value)) {
          if (event.kind === "sample") this.emitSample(event.sample);
          else if (event.kind === "shot") this.bus.emit("shot", event.shot);
          else this.log(event.line);
        }
      }
    } catch (error) {
      if (this.keepReading) this.log(`Serial read error: ${error.message}`);
    } finally {
      await this.disconnect();
    }
  }

  async disconnect() {
    this.keepReading = false;

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (_) {}
      try {
        this.reader.releaseLock();
      } catch (_) {}
      this.reader = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch (_) {}
      this.port = null;
    }

    if (this.connected) this.log("Serial disconnected.");
    this.connected = false;
    this.status("", "Disconnected");
  }
}

// Web Bluetooth: the firmware notifies batched 20-byte binary frames.
export class BleAdapter extends BaseAdapter {
  constructor(bus) {
    super(bus);
    this.controlQueue = Promise.resolve();
    this.acknowledgedShotIds = new Set();
    this.pendingAckShotIds = new Set();
    this.unsubscribeShotSaved = bus.on("shot-saved", (shot) => {
      if (shot && shot.shotId != null) {
        this.ackShot(shot.shotId);
      }
    });
  }

  get name() {
    return "Bluetooth";
  }

  // Firmware adds a BLE frame every IMU sample, so sequence advances by 1.
  get sequenceStep() {
    return 1;
  }

  async connect() {
    if (!("bluetooth" in navigator)) {
      this.log("Web Bluetooth unavailable. Use Chrome/Edge over https or localhost.");
      throw new Error("Web Bluetooth not supported");
    }

    // Match by advertised service UUID (carried in the primary advertisement)
    // or by name prefix (carried in the scan response) — service is the more
    // reliable of the two for discovery.
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [OPENFLOAT_SERVICE] }, { namePrefix: "OpenFloat" }],
      optionalServices: [OPENFLOAT_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () => this._onDrop());

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(OPENFLOAT_SERVICE);
    this.live = await service.getCharacteristic(OPENFLOAT_LIVE);
    try {
      this.control = await service.getCharacteristic(OPENFLOAT_CONTROL);
    } catch (error) {
      this.control = null;
      this.log(`BLE control characteristic not found: ${error.message}`);
    }

    this.sampleCount = 0;
    this.live.addEventListener("characteristicvaluechanged", (e) => this._onValue(e));
    await this.live.startNotifications();
    this.log("BLE notifications subscribed.");
    await this.sendControl("start");
    await this.sendControl("shotdump");

    this.connected = true;
    this.status("live", `BLE ${this.device.name || ""}`.trim());
    this.log(`BLE connected to ${this.device.name || this.device.id}.`);

    // The firmware streams only once notifications are enabled; if nothing
    // arrives shortly, nudge it with another start command.
    this.watchdog = setTimeout(() => {
      if (this.connected && this.sampleCount === 0) {
        this.log("No BLE frames after 2s — re-sending start.");
        this.sendControl("start");
      }
    }, 2000);
  }

  async sendControl(command) {
    this.controlQueue = this.controlQueue
      .catch(() => {})
      .then(() => this.writeControl(command));
    return this.controlQueue;
  }

  async writeControl(command) {
    if (!this.control) {
      this.log("No control characteristic available.");
      return false;
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.control.writeValue(new TextEncoder().encode(command));
          this.log(`Sent BLE control: ${command}.`);
          return true;
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          if (!message.includes("GATT operation already in progress") || attempt === 2) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    } catch (error) {
      this.log(`BLE control write failed: ${error.message}`);
      return false;
    }
    return false;
  }

  async ackShot(shotId) {
    if (this.acknowledgedShotIds.has(shotId) || this.pendingAckShotIds.has(shotId)) {
      return;
    }

    this.pendingAckShotIds.add(shotId);
    try {
      const acked = await this.sendControl(`shotack:${shotId}`);
      if (acked) {
        this.acknowledgedShotIds.add(shotId);
        await this.sendControl("shotdump");
      }
    } finally {
      this.pendingAckShotIds.delete(shotId);
    }
  }

  _onValue(event) {
    const dv = event.target.value;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

    let decodedCount = 0;
    for (let offset = 0; offset + BINARY_FRAME_LEN <= bytes.length; offset += BINARY_FRAME_LEN) {
      const decoded = decodeBinaryFrame(bytes, offset);
      if (decoded && decoded.kind === "sample") {
        if (this.sampleCount === 0) this.log("BLE frames flowing.");
        this.sampleCount += 1;
        decodedCount += 1;
        this.emitSample(decoded.sample);
        continue;
      }
      if (decoded && decoded.kind === "shot") {
        decodedCount += 1;
        if (decoded.shot.stored) {
          this.log(`Stored shot upload received: id ${decoded.shot.shotId}.`);
        }
        this.bus.emit("shot", decoded.shot);
        continue;
      }
      if (decoded && decoded.kind === "count") {
        decodedCount += 1;
        this.bus.emit("shotcount", decoded.count);
        continue;
      }
      if (decoded && decoded.kind === "storage") {
        decodedCount += 1;
        this.log(
          `Device stored shots pending: ${decoded.storage.pending} ` +
            `(shot count ${decoded.storage.shotCount}).`,
        );
      }
    }

    if (decodedCount === 0) {
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
      this.log(`BLE frame not decoded (${dv.byteLength} bytes): ${hex}`);
    }
  }

  _onDrop() {
    if (!this.connected) return;
    this.connected = false;
    this.log("BLE disconnected.");
    this.status("", "Disconnected");
  }

  async disconnect() {
    if (this.unsubscribeShotSaved) {
      this.unsubscribeShotSaved();
      this.unsubscribeShotSaved = null;
    }
    clearTimeout(this.watchdog);
    try {
      if (this.live) await this.live.stopNotifications();
    } catch (_) {}
    try {
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    } catch (_) {}
    this._onDrop();
  }
}

export function createAdapter(kind, bus, options) {
  if (kind === "serial") return new SerialAdapter(bus, options);
  if (kind === "ble") return new BleAdapter(bus, options);
  return new DemoAdapter(bus, options);
}
