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

import { decodeBinaryFrame } from "../protocol/frame.js?v=shot-store-199";

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

  get deviceId() {
    return "OpenFloat-Sensor";
  }

  log(message) {
    this.bus.emitAsync("log", message);
  }

  status(mode, text) {
    this.bus.emit("status", { mode, text, deviceId: this.deviceId });
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

  get deviceId() {
    return "OpenFloat-Demo";
  }

  get sequenceStep() {
    return 1;
  }

  async connect() {
    this.connected = true;
    let seq = 0;
    this.status("demo", "Demo stream");
    this.log("Demo stream started.");

    let previousMs = performance.now();
    this.timer = setInterval(() => {
      const nowMs = performance.now();
      const dtUs = Math.max(1, Math.round((nowMs - previousMs) * 1000));
      previousMs = nowMs;
      const t = nowMs / 1000;
      const rollDeg = Math.cos(t * 3) * 7;
      const pitchDeg = Math.sin(t * 2.4) * 5;
      const yawDeg = Math.sin(t * 0.8) * 24;
      const quat = eulerDegToQuaternion(rollDeg, pitchDeg, yawDeg);
      this.emitSample({
        source: "demo",
        protocol: 1,
        type: 1,
        sequence: seq++,
        dtUs,
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
    this.connectionEpoch = 0;
    this.connectionToken = {};
    this.pendingAckShotIds = new Set();
    this.pendingStoredShots = 0;
    this.storedShotWatchdog = null;
    this.traceDownloadQueue = [];
    // Keep acknowledged metadata's exact local ID until its replay commits.
    // Firmware can stop re-uploading metadata before the trace has arrived.
    this.traceLocalShotIds = new Map();
    this.interruptedTraceShotIds = [];
    this.currentTraceDownloadShotId = null;
    this.currentTraceChunkIndexes = new Set();
    this.currentTraceTotalChunks = 0;
    // Request modes: 3 = timed v2 stream, 2 = untimed v2, 1 = legacy v1.
    this.traceProtocol = 3;
    this.traceDownloadAttempt = null;
    this.traceTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6;
    this.manualDisconnect = false;
    this.dropHandler = () => this._onDrop();
    this.liveValueHandler = (e) => {
      if (e.target === this.live) this._onValue(e);
    };
    this.batteryValueHandler = (e) => {
      if (e.target === this.batteryChar && e.target.value?.byteLength) {
        this.bus.emit("battery", e.target.value.getUint8(0));
      }
    };
    this.unsubscribeShotSaved = bus.on("shot-saved", (shot) => {
      if (shot && shot.shotId != null) {
        const source = shot.sourceConnection;
        if (source && (source.token !== this.connectionToken || source.epoch !== this.connectionEpoch ||
            (source.deviceId != null && source.deviceId !== this.deviceId))) return;
        const acknowledgement = this.ackShot(shot.shotId);
        if (shot.stored && (!shot.duplicate || shot.traceNeeded === true)) this._enqueueTraceDownload(shot.shotId, shot.localShotId);
        return acknowledgement;
      }
    });
    this.unsubscribeTraceSaved = bus.on("shot-trace-saved", (trace) => {
      if (this.traceLocalShotIds.get(trace?.deviceShotId) === trace?.localShotId && trace?.localShotId) {
        this._forgetTraceDownload(trace.deviceShotId);
      }
    });
  }

  get name() {
    return "Bluetooth";
  }

  get deviceId() {
    const id = this.device?.id;
    return typeof id === "string" && id ? `OpenFloat-BLE:${id}` : "OpenFloat-Sensor";
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
    const epoch = ++this.connectionEpoch;

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [OPENFLOAT_SERVICE] }, { namePrefix: "OpenFloat" }],
      optionalServices: [OPENFLOAT_SERVICE, "battery_service"],
    });
    if (this.manualDisconnect || epoch !== this.connectionEpoch) return false;
    this.device = device;
    this.device.removeEventListener("gattserverdisconnected", this.dropHandler);
    this.device.addEventListener("gattserverdisconnected", this.dropHandler);

    return this._connectGatt();
  }

  async _connectGatt() {
    const device = this.device;
    const epoch = ++this.connectionEpoch;
    const active = () => !this.manualDisconnect && epoch === this.connectionEpoch;
    const server = await device.gatt.connect();
    if (!active()) {
      // disconnect() may have run before gatt.connect() finished opening.
      if (this.manualDisconnect && server.connected) server.disconnect();
      return false;
    }
    const service = await server.getPrimaryService(OPENFLOAT_SERVICE);
    if (!active()) return false;
    const live = await service.getCharacteristic(OPENFLOAT_LIVE);
    if (!active()) return false;
    let control = null;
    try {
      control = await service.getCharacteristic(OPENFLOAT_CONTROL);
    } catch (error) {
      if (!active()) return false;
      this.log(`BLE control characteristic not found: ${error.message}`);
    }
    if (!active()) return false;

    // Discover standard Battery Service
    let batteryChar = null;
    try {
      const basService = await server.getPrimaryService("battery_service");
      if (!active()) return false;
      batteryChar = await basService.getCharacteristic("battery_level");
    } catch (error) {
      if (!active()) return false;
      this.log(`BLE Battery Service not found: ${error.message}`);
    }
    if (!active()) return false;

    this.live = live;
    this.control = control;
    this.batteryChar = batteryChar;
    this.sampleCount = 0;
    live.addEventListener("characteristicvaluechanged", this.liveValueHandler);
    await live.startNotifications();
    if (!active()) return false;
    this.log("BLE notifications subscribed.");

    if (batteryChar) {
      batteryChar.addEventListener("characteristicvaluechanged", this.batteryValueHandler);
      try {
        await batteryChar.startNotifications();
      } catch (error) {
        if (!active()) return false;
        this.log(`BLE battery notifications unavailable: ${error.message}`);
      }
      if (!active()) return false;
      try {
        const initVal = await batteryChar.readValue();
        if (!active()) return false;
        if (initVal.byteLength) this.bus.emit("battery", initVal.getUint8(0));
      } catch (err) {
        if (!active()) return false;
        this.log(`Initial battery read failed: ${err.message}`);
      }
    }

    await this.sendControl("start");
    if (!active()) return false;
    await this.sendControl("shotdump");
    if (!active()) return false;

    this.connected = true;
    this.reconnectAttempts = 0;
    this.status("live", `BLE ${device.name || ""}`.trim());
    this.log(`BLE connected to ${device.name || device.id}.`);
    await this._resumeTraceDownloads(epoch);
    if (!active()) return false;

    // The firmware streams only once notifications are enabled; if nothing
    // arrives shortly, nudge it with another start command.
    this.watchdog = setTimeout(() => {
      if (active() && this.connected && this.sampleCount === 0 && this.pendingStoredShots === 0 && this.currentTraceDownloadShotId == null) {
        this.log("No BLE frames after 2s — re-sending start.");
        this.sendControl("start");
      }
    }, 2000);
    return true;
  }

  async sendControl(command) {
    const control = this.control;
    const epoch = this.connectionEpoch;
    this.controlQueue = this.controlQueue
      .catch(() => {})
      .then(() => this.writeControl(command, control, epoch));
    return this.controlQueue;
  }

  async writeControl(command, control = this.control, epoch = this.connectionEpoch) {
    const active = () => !this.manualDisconnect && epoch === this.connectionEpoch && control === this.control;
    if (!active()) return false;
    if (!control) {
      this.log("No control characteristic available.");
      return false;
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!active()) return false;
        try {
          await control.writeValue(new TextEncoder().encode(command));
          if (!active()) return false;
          this.log(`Sent BLE control: ${command}.`);
          return true;
        } catch (error) {
          if (!active()) return false;
          if (attempt === 2) {
            throw error;
          }
          this.log(`BLE control write attempt ${attempt + 1} failed: ${error.message || error}. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    } catch (error) {
      if (!active()) return false;
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
    const pending = this.pendingAckShotIds;
    if (pending.has(shotId)) {
      return;
    }

    pending.add(shotId);
    try {
      return await this.sendControl(`shotack:${shotId}`);
    } finally {
      pending.delete(shotId);
    }
  }

  async requestTrace(shotId, protocol = this.traceProtocol) {
    this.log(`Requesting trace upload for shot ID ${shotId}...`);
    const command = protocol === 3 ? "tracetimed" : (protocol === 2 ? "tracereq2" : "tracereq");
    return this.sendControl(`${command}:${shotId}`);
  }

  _onValue(event) {
    const sourceConnection = { token: this.connectionToken, epoch: this.connectionEpoch, deviceId: this.deviceId };
    const dv = event.target.value;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

    let decodedCount = 0;
    for (let offset = 0; offset + 4 <= bytes.length;) {
      if (sourceConnection.epoch !== this.connectionEpoch) return;
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
        this.bus.emit("shot", { ...decoded.shot, sourceConnection });
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
        if (decoded.storage.pending > 0 && decoded.storage.retryAttempts > 1) {
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
          decoded.trace.protocol !== 2 &&
          this.currentTraceDownloadShotId != null &&
          decoded.trace.shotId !== this.currentTraceDownloadShotId &&
          sameLow16ShotId(decoded.trace.shotId, this.currentTraceDownloadShotId)
        ) {
          decoded.trace = {
            ...decoded.trace,
            shotId: this.currentTraceDownloadShotId,
          };
        }
        if (this._onTraceChunkReceived(decoded.trace)) {
          this.bus.emit("trace-chunk", decoded.trace);
        }
        continue;
      }
      if (decoded && decoded.kind === "trace-status") {
        decodedCount += 1;
        if (decoded.traceStatus.status === 0 || decoded.traceStatus.status === 2) {
          this.log(decoded.traceStatus.status === 2
            ? `Firmware trace for shot ${decoded.traceStatus.shotId} needs the extended transfer format.`
            : `No firmware trace available for shot ${decoded.traceStatus.shotId}.`);
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
    this.connectionEpoch += 1;
    // Old GATT promises may still settle. A new link must not wait for them.
    this.controlQueue = Promise.resolve();
    this.pendingAckShotIds = new Set();
    this.live?.removeEventListener("characteristicvaluechanged", this.liveValueHandler);
    this.batteryChar?.removeEventListener("characteristicvaluechanged", this.batteryValueHandler);
    const wasConnected = this.connected;
    this.connected = false;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    this._stopStoredShotWatchdog();
    this._stopTraceDownloadTimer();
    if (this.manualDisconnect) {
      this.interruptedTraceShotIds = [];
      this.traceLocalShotIds.clear();
    } else {
      this.interruptedTraceShotIds = [...new Set([
        this.currentTraceDownloadShotId, ...this.traceDownloadQueue,
        ...this.interruptedTraceShotIds, ...this.traceLocalShotIds.keys(),
      ])].filter((shotId) => this.traceLocalShotIds.has(shotId));
    }
    this.traceDownloadQueue = [];
    this.currentTraceDownloadShotId = null;
    this.currentTraceChunkIndexes.clear();
    this.currentTraceTotalChunks = 0;
    this.traceDownloadAttempt = null;
    this.traceProtocol = 3;
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
      let epoch;
      try {
        this.log(`BLE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
        const connecting = this._connectGatt();
        epoch = this.connectionEpoch;
        if (!await connecting) return;
        this.log("BLE reconnected.");
      } catch (error) {
        if (this.manualDisconnect || epoch !== this.connectionEpoch) return;
        this.log(`BLE reconnect failed: ${error.message}`);
        this._onDrop();
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

  async _resumeTraceDownloads(epoch) {
    const active = () => !this.manualDisconnect && this.connected && epoch === this.connectionEpoch;
    for (const shotId of [...this.interruptedTraceShotIds]) {
      if (!active()) return;
      const localShotId = this.traceLocalShotIds.get(shotId);
      if (!localShotId) continue;
      if (shotId === this.currentTraceDownloadShotId || this.traceDownloadQueue.includes(shotId)) {
        this.interruptedTraceShotIds = this.interruptedTraceShotIds.filter((id) => id !== shotId);
        continue;
      }
      // Rebind only if the exact saved capture still needs its replay. A new
      // connection has already discarded the previous partial chunk buffer.
      const results = await this.bus.emitAsync("trace-resume", { shotId, localShotId });
      if (!active()) return;
      if (this.traceLocalShotIds.get(shotId) !== localShotId) continue;
      if (results.some((result) => result.status === "fulfilled" && result.value === true)) {
        this.interruptedTraceShotIds = this.interruptedTraceShotIds.filter((id) => id !== shotId);
        this._enqueueTraceDownload(shotId, localShotId);
      } else if (results.some((result) => result.status === "rejected")) {
        this.log(`Saved trace check failed for shot ${shotId}; retrying on the next reconnect.`);
      } else {
        this._forgetTraceDownload(shotId);
      }
    }
  }

  _forgetTraceDownload(shotId) {
    this.traceLocalShotIds.delete(shotId);
    this.interruptedTraceShotIds = this.interruptedTraceShotIds.filter((id) => id !== shotId);
    this.traceDownloadQueue = this.traceDownloadQueue.filter((id) => id !== shotId);
  }

  _enqueueTraceDownload(shotId, localShotId) {
    if (typeof localShotId === "string" && localShotId) this.traceLocalShotIds.set(shotId, localShotId);
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

  _startTraceDownload(shotId, protocol = this.traceProtocol) {
    this._stopTraceDownloadTimer();
    this.currentTraceDownloadShotId = shotId;
    this.currentTraceChunkIndexes.clear();
    this.currentTraceTotalChunks = 0;
    const attempt = { shotId, protocol };
    this.traceDownloadAttempt = attempt;
    // Restart reassembly before a queued write can deliver any fresh chunks.
    this.bus.emit("trace-start", { shotId });
    if (this.traceDownloadAttempt !== attempt) return;
    this.log(`Starting serialized trace download for shot ${shotId}...`);
    this.requestTrace(shotId, protocol).then((sent) => {
      // A reply or disconnect can arrive before the control-write promise settles.
      if (this.traceDownloadAttempt !== attempt || this.currentTraceChunkIndexes.size) return;
      if (!sent) {
        this._completeTraceDownload(shotId, true);
        return;
      }
      this.traceTimer = setTimeout(() => {
        if (this.traceDownloadAttempt !== attempt) return;
        if (protocol > 1) {
          this.log(protocol === 3 ? "No timed trace response; trying extended recovery." :
            "No extended trace response; trying the legacy firmware command.");
          this.traceProtocol = protocol - 1;
          this._startTraceDownload(shotId, this.traceProtocol);
        } else {
          this.log(`Trace download timeout for shot ${shotId}.`);
          this._completeTraceDownload(shotId, true);
        }
      }, 1500);
    });
  }

  _onTraceChunkReceived(trace) {
    if (trace.shotId === this.currentTraceDownloadShotId &&
        (trace.timed ? 3 : (trace.protocol || 1)) === this.traceDownloadAttempt?.protocol) {
      if (this.currentTraceTotalChunks && this.currentTraceTotalChunks !== trace.totalChunks) {
        this.log(`Trace chunk count changed for shot ${trace.shotId}; discarded transfer.`);
        this._completeTraceDownload(trace.shotId);
        return false;
      }
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
        this._completeTraceDownload(trace.shotId, true);
      } else {
        // Reset watchdog during active chunk transfer (8 seconds)
        this.traceTimer = setTimeout(() => {
          this.log(`Trace download stalled for shot ${trace.shotId}. Proceeding to ack.`);
          this._completeTraceDownload(trace.shotId, true);
        }, 8000);
      }
      return true;
    }
    return false;
  }

  _completeTraceDownload(shotId, retainForReconnect = false) {
    // A delayed status from an earlier request must not finish the next shot.
    if (shotId !== this.currentTraceDownloadShotId) return;
    // A timeout may precede the OS reporting a radio drop. Unavailable replies
    // or changed chunk counts end recovery; silence and uncommitted bytes do not.
    if (!retainForReconnect) this._forgetTraceDownload(shotId);
    this._stopTraceDownloadTimer();
    this.currentTraceDownloadShotId = null;
    this.currentTraceChunkIndexes.clear();
    this.currentTraceTotalChunks = 0;
    this.traceDownloadAttempt = null;
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
    if (this.unsubscribeTraceSaved) {
      this.unsubscribeTraceSaved();
      this.unsubscribeTraceSaved = null;
    }
    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.dropHandler);
    }
    // Disconnecting GATT also stops its notifications. Invalidate callbacks
    // synchronously, without waiting for another GATT operation to finish.
    this._onDrop();
    try {
      if (this.device?.gatt.connected) this.device.gatt.disconnect();
    } catch (_) {}
  }
}

export function createAdapter(kind, bus, options) {
  if (kind === "ble") return new BleAdapter(bus, options);
  return new DemoAdapter(bus, options);
}
