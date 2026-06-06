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

import { BINARY_FRAME_LEN, decodeBinaryFrame, TextLineParser } from "../protocol/frame.js?v=shot-store-105";

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
        yawDeg: Math.sin(t * 0.8) * 24,
        flags: 0,
        micAmp: Math.round((Math.sin(t * 8) + 1) * 40 + Math.random() * 20),
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

// Web Bluetooth: the firmware notifies batched 29-byte binary frames.
export class BleAdapter extends BaseAdapter {
  constructor(bus) {
    super(bus);
    this.controlQueue = Promise.resolve();
    this.acknowledgedShotIds = new Set();
    this.pendingAckShotIds = new Set();
    this.pendingStoredShots = 0;
    this.storedShotWatchdog = null;
    this.currentTraceDownloadShotId = null;
    this.traceTimer = null;
    this.unsubscribeShotSaved = bus.on("shot-saved", (shot) => {
      if (shot && shot.shotId != null) {
        if (shot.stored) {
          this._startTraceDownload(shot.shotId);
        } else {
          this.ackShot(shot.shotId);
        }
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
      optionalServices: [OPENFLOAT_SERVICE, "battery_service"],
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

    // Discover standard Battery Service
    this.batteryChar = null;
    try {
      const basService = await server.getPrimaryService("battery_service");
      this.batteryChar = await basService.getCharacteristic("battery_level");
    } catch (error) {
      this.log(`BLE Battery Service not found: ${error.message}`);
    }

    this.sampleCount = 0;
    this.live.addEventListener("characteristicvaluechanged", (e) => this._onValue(e));
    await this.live.startNotifications();
    this.log("BLE notifications subscribed.");

    if (this.batteryChar) {
      this.batteryChar.addEventListener("characteristicvaluechanged", (e) => {
        const val = e.target.value.getUint8(0);
        this.bus.emit("battery", val);
      });
      await this.batteryChar.startNotifications();
      try {
        const initVal = await this.batteryChar.readValue();
        this.bus.emit("battery", initVal.getUint8(0));
      } catch (err) {
        this.log(`Initial battery read failed: ${err.message}`);
      }
    }

    await this.sendControl("start");
    await this.sendControl("shotdump");

    this.connected = true;
    this.status("live", `BLE ${this.device.name || ""}`.trim());
    this.log(`BLE connected to ${this.device.name || this.device.id}.`);

    // The firmware streams only once notifications are enabled; if nothing
    // arrives shortly, nudge it with another start command.
    this.watchdog = setTimeout(() => {
      if (this.connected && this.sampleCount === 0 && this.pendingStoredShots === 0 && !this.currentTraceDownloadShotId) {
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
          if (attempt === 2) {
            throw error;
          }
          this.log(`BLE control write attempt ${attempt + 1} failed: ${error.message || error}. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    } catch (error) {
      this.log(`BLE control write failed: ${error.message}`);
      const message = String(error.message || error);
      if (message.includes("disconnected") || message.includes("not connected") || message.includes("Cannot perform GATT operations")) {
        this._onDrop();
      }
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
      }
    } finally {
      this.pendingAckShotIds.delete(shotId);
    }
  }

  async requestTrace(shotId) {
    this.log(`Requesting trace upload for shot ID ${shotId}...`);
    await this.sendControl(`tracereq:${shotId}`);
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
          this._feedStoredShotWatchdog();
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
        this.pendingStoredShots = decoded.storage.pending;
        this.bus.emit("upload-status", {
          pending: decoded.storage.pending,
          shotCount: decoded.storage.shotCount,
        });
        if (this.pendingStoredShots > 0) {
          this._startStoredShotWatchdog();
        } else {
          this._stopStoredShotWatchdog();
        }
      }
      if (decoded && decoded.kind === "trace") {
        decodedCount += 1;
        this.bus.emit("trace-chunk", decoded.trace);
        this._onTraceChunkReceived(decoded.trace);
        continue;
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
    this._stopStoredShotWatchdog();
    this._stopTraceDownloadTimer();
    this.currentTraceDownloadShotId = null;
    this.pendingStoredShots = 0;
    this.bus.emit("upload-status", { pending: 0, shotCount: null });
    this.log("BLE disconnected.");
    this.status("", "Disconnected");
  }

  _startStoredShotWatchdog() {
    this._stopStoredShotWatchdog();
    this.storedShotWatchdog = setInterval(() => {
      if (this.connected && this.pendingStoredShots > 0) {
        this.log(`Watchdog: Stored shot upload stalled (pending: ${this.pendingStoredShots}). Re-sending shotdump...`);
        this.sendControl("shotdump");
      } else {
        this._stopStoredShotWatchdog();
      }
    }, 4000);
  }

  _stopStoredShotWatchdog() {
    if (this.storedShotWatchdog) {
      clearInterval(this.storedShotWatchdog);
      this.storedShotWatchdog = null;
    }
  }

  _feedStoredShotWatchdog() {
    if (this.pendingStoredShots > 0) {
      this._startStoredShotWatchdog();
    }
  }

  _startTraceDownload(shotId) {
    this._stopTraceDownloadTimer();
    this.currentTraceDownloadShotId = shotId;
    this.log(`Starting serialized trace download for shot ${shotId}...`);
    this.requestTrace(shotId);
    
    // 2.5-second fallback timer if device doesn't respond or has no trace
    this.traceTimer = setTimeout(() => {
      this.log(`Trace download timeout for shot ${shotId}. Proceeding to ack.`);
      this._completeTraceDownload(shotId);
    }, 2500);
  }

  _onTraceChunkReceived(trace) {
    if (trace.shotId === this.currentTraceDownloadShotId) {
      this._stopTraceDownloadTimer();
      
      if (trace.chunkIndex === trace.totalChunks - 1) {
        this.log(`Trace download complete for shot ${trace.shotId}.`);
        this._completeTraceDownload(trace.shotId);
      } else {
        // Reset watchdog during active chunk transfer (8 seconds)
        this.traceTimer = setTimeout(() => {
          this.log(`Trace download stalled for shot ${trace.shotId}. Proceeding to ack.`);
          this._completeTraceDownload(trace.shotId);
        }, 8000);
      }
    }
  }

  _completeTraceDownload(shotId) {
    this._stopTraceDownloadTimer();
    this.currentTraceDownloadShotId = null;
    this.ackShot(shotId);
  }

  _stopTraceDownloadTimer() {
    if (this.traceTimer) {
      clearTimeout(this.traceTimer);
      this.traceTimer = null;
    }
  }

  async disconnect() {
    this._stopStoredShotWatchdog();
    this._stopTraceDownloadTimer();
    if (this.unsubscribeShotSaved) {
      this.unsubscribeShotSaved();
      this.unsubscribeShotSaved = null;
    }
    clearTimeout(this.watchdog);
    try {
      if (this.live) await this.live.stopNotifications();
    } catch (_) {}
    try {
      if (this.batteryChar) await this.batteryChar.stopNotifications();
    } catch (_) {}
    this.batteryChar = null;
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
