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

import { decodeBinaryFrame } from "../protocol/frame.js?v=shot-store-123";

const OPENFLOAT_SERVICE = "8f3f3b10-0f5a-4f4c-9a2d-000000000001";
const OPENFLOAT_LIVE = "8f3f3b10-0f5a-4f4c-9a2d-000000000002";
const OPENFLOAT_CONTROL = "8f3f3b10-0f5a-4f4c-9a2d-000000000003";

function sameLow16ShotId(a, b) {
  return a != null && b != null && (Number(a) & 0xffff) === (Number(b) & 0xffff);
}

function eulerDegToQuaternion(rollDeg, pitchDeg, yawDeg) {
  const halfRoll = (rollDeg * Math.PI) / 360;
  const halfPitch = (pitchDeg * Math.PI) / 360;
  const halfYaw = (yawDeg * Math.PI) / 360;
  const cr = Math.cos(halfRoll);
  const sr = Math.sin(halfRoll);
  const cp = Math.cos(halfPitch);
  const sp = Math.sin(halfPitch);
  const cy = Math.cos(halfYaw);
  const sy = Math.sin(halfYaw);

  return {
    qw: cr * cp * cy + sr * sp * sy,
    qx: sr * cp * cy - cr * sp * sy,
    qy: cr * sp * cy + sr * cp * sy,
    qz: cr * cp * sy - sr * sp * cy,
  };
}

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
      const rollDeg = Math.cos(t * 3) * 7;
      const pitchDeg = Math.sin(t * 2.4) * 5;
      const yawDeg = Math.sin(t * 0.8) * 24;
      const quat = eulerDegToQuaternion(rollDeg, pitchDeg, yawDeg);
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
        ...quat,
        rollDeg,
        pitchDeg,
        yawDeg,
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

// Web Bluetooth: the firmware notifies batched compact binary frames.
export class BleAdapter extends BaseAdapter {
  constructor(bus) {
    super(bus);
    this.controlQueue = Promise.resolve();
    this.pendingAckShotIds = new Set();
    this.pendingStoredShots = 0;
    this.storedShotWatchdog = null;
    this.traceDownloadQueue = [];
    this.currentTraceDownloadShotId = null;
    this.currentTraceChunkIndexes = new Set();
    this.currentTraceTotalChunks = 0;
    this.traceTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6;
    this.manualDisconnect = false;
    this.dropHandler = () => this._onDrop();
    this.liveValueHandler = (e) => this._onValue(e);
    this.batteryValueHandler = (e) => {
      const val = e.target.value.getUint8(0);
      this.bus.emit("battery", val);
    };
    this.unsubscribeShotSaved = bus.on("shot-saved", (shot) => {
      if (shot && shot.shotId != null) {
        if (shot.stored) {
          this.ackShot(shot.shotId);
          if (!shot.duplicate) {
            this._enqueueTraceDownload(shot.shotId);
          }
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
    this._stopReconnectTimer();
    this.manualDisconnect = false;

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [OPENFLOAT_SERVICE] }, { namePrefix: "OpenFloat" }],
      optionalServices: [OPENFLOAT_SERVICE, "battery_service"],
    });
    this.device.removeEventListener("gattserverdisconnected", this.dropHandler);
    this.device.addEventListener("gattserverdisconnected", this.dropHandler);

    await this._connectGatt();
  }

  async _connectGatt() {
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
    this.live.removeEventListener("characteristicvaluechanged", this.liveValueHandler);
    this.live.addEventListener("characteristicvaluechanged", this.liveValueHandler);
    await this.live.startNotifications();
    this.log("BLE notifications subscribed.");

    if (this.batteryChar) {
      this.batteryChar.removeEventListener("characteristicvaluechanged", this.batteryValueHandler);
      this.batteryChar.addEventListener("characteristicvaluechanged", this.batteryValueHandler);
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
    this.reconnectAttempts = 0;
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
    if (this.pendingAckShotIds.has(shotId)) {
      return;
    }

    this.pendingAckShotIds.add(shotId);
    try {
      await this.sendControl(`shotack:${shotId}`);
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
    for (let offset = 0; offset + 4 <= bytes.length;) {
      const decoded = decodeBinaryFrame(bytes, offset);
      if (!decoded || !decoded.byteLength) {
        break;
      }
      offset += decoded.byteLength;
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
        const parts = [
          `Device stored shots pending: ${decoded.storage.pending}`,
          `shot count ${decoded.storage.shotCount}`,
        ];
        if (decoded.storage.dropped > 0) {
          parts.push(`dropped ${decoded.storage.dropped}`);
        }
        if (decoded.storage.retryAttempts > 1 && decoded.storage.uploadShotId) {
          parts.push(`retry ${decoded.storage.retryAttempts} for ${decoded.storage.uploadShotId}`);
        }
        this.log(`${parts[0]} (${parts.slice(1).join(", ")}).`);
        this.pendingStoredShots = decoded.storage.pending;
        this.bus.emit("upload-status", {
          pending: decoded.storage.pending,
          shotCount: decoded.storage.shotCount,
          dropped: decoded.storage.dropped,
          uploadShotId: decoded.storage.uploadShotId,
          retryAttempts: decoded.storage.retryAttempts,
        });
        if (this.pendingStoredShots > 0) {
          this._startStoredShotWatchdog();
        } else {
          this._stopStoredShotWatchdog();
        }
      }
      if (decoded && decoded.kind === "trace") {
        decodedCount += 1;
        if (
          this.currentTraceDownloadShotId != null &&
          decoded.trace.shotId !== this.currentTraceDownloadShotId &&
          sameLow16ShotId(decoded.trace.shotId, this.currentTraceDownloadShotId)
        ) {
          decoded.trace = {
            ...decoded.trace,
            shotId: this.currentTraceDownloadShotId,
          };
        }
        this.bus.emit("trace-chunk", decoded.trace);
        this._onTraceChunkReceived(decoded.trace);
        continue;
      }
      if (decoded && decoded.kind === "trace-status") {
        decodedCount += 1;
        if (decoded.traceStatus.status === 0) {
          this.log(`No firmware trace available for shot ${decoded.traceStatus.shotId}; acking metadata.`);
          this._completeTraceDownload(decoded.traceStatus.shotId);
        }
        continue;
      }
    }

    if (decodedCount === 0) {
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
      this.log(`BLE frame not decoded (${dv.byteLength} bytes): ${hex}`);
    }
  }

  _onDrop() {
    const wasConnected = this.connected;
    this.connected = false;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    this._stopStoredShotWatchdog();
    this._stopTraceDownloadTimer();
    this.traceDownloadQueue = [];
    this.currentTraceDownloadShotId = null;
    this.currentTraceChunkIndexes.clear();
    this.currentTraceTotalChunks = 0;
    this.pendingStoredShots = 0;
    this.live = null;
    this.control = null;
    this.batteryChar = null;
    this.bus.emit("upload-status", { pending: 0, shotCount: null });
    if (wasConnected) {
      this.log("BLE disconnected.");
    }
    if (this.manualDisconnect) {
      this.status("", "Disconnected");
      return;
    }
    this.status("reconnecting", "BLE reconnecting...");
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.device || this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.status("", "Disconnected");
        this.log("BLE reconnect stopped. Click the status badge to choose the sensor again.");
      }
      return;
    }

    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.manualDisconnect || this.connected) return;
      try {
        this.log(`BLE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
        await this._connectGatt();
        this.log("BLE reconnected.");
      } catch (error) {
        this.log(`BLE reconnect failed: ${error.message}`);
        this._scheduleReconnect();
      }
    }, delayMs);
  }

  _stopReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  _enqueueTraceDownload(shotId) {
    if (
      this.currentTraceDownloadShotId === shotId ||
      this.traceDownloadQueue.includes(shotId)
    ) {
      return;
    }
    this.traceDownloadQueue.push(shotId);
    this._pumpTraceDownloadQueue();
  }

  _pumpTraceDownloadQueue() {
    if (this.currentTraceDownloadShotId != null) return;
    const nextShotId = this.traceDownloadQueue.shift();
    if (nextShotId != null) {
      this._startTraceDownload(nextShotId);
    }
  }

  _startTraceDownload(shotId) {
    this._stopTraceDownloadTimer();
    this.currentTraceDownloadShotId = shotId;
    this.currentTraceChunkIndexes.clear();
    this.currentTraceTotalChunks = 0;
    this.log(`Starting serialized trace download for shot ${shotId}...`);
    this.requestTrace(shotId);
    
    // Fallback if an older firmware does not send a missing-trace status frame.
    this.traceTimer = setTimeout(() => {
      this.log(`Trace download timeout for shot ${shotId}. Proceeding to ack.`);
      this._completeTraceDownload(shotId);
    }, 1500);
  }

  _onTraceChunkReceived(trace) {
    if (trace.shotId === this.currentTraceDownloadShotId) {
      this._stopTraceDownloadTimer();

      if (
        trace.totalChunks > 0 &&
        trace.chunkIndex >= 0 &&
        trace.chunkIndex < trace.totalChunks
      ) {
        this.currentTraceTotalChunks = trace.totalChunks;
        this.currentTraceChunkIndexes.add(trace.chunkIndex);
      }
      
      if (
        this.currentTraceTotalChunks > 0 &&
        this.currentTraceChunkIndexes.size === this.currentTraceTotalChunks
      ) {
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
    this.currentTraceChunkIndexes.clear();
    this.currentTraceTotalChunks = 0;
    this.ackShot(shotId);
    this._pumpTraceDownloadQueue();
  }

  _stopTraceDownloadTimer() {
    if (this.traceTimer) {
      clearTimeout(this.traceTimer);
      this.traceTimer = null;
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    this._stopReconnectTimer();
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
    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.dropHandler);
    }
    this._onDrop();
  }
}

export function createAdapter(kind, bus, options) {
  if (kind === "ble") return new BleAdapter(bus, options);
  return new DemoAdapter(bus, options);
}
