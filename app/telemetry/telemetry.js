// TelemetryStore ingests Samples from the bus, derives live metrics, tracks
// packet loss against the active transport's sequence step, and maintains a
// rolling trace buffer for the chart. It is the only thing that writes app
// state into the reactive store.

import { get, getAll, saveCapture, saveShotTrace, generateUUID } from "../core/db.js?v=shot-store-176";
import {
  buildShotTraceRecord,
  decodeFirmwareTraceBytes,
  decodeTimedFirmwareTrace,
  extractMicWindow,
  prepareTimedTrace,
} from "../protocol/trace.js?v=shot-store-155";
import {
  computeFloatScoreFromTrace,
  computeLiveFloatScore,
  FLOAT_SCORE_VERSION,
  scoreValue,
} from "./score.js?v=shot-store-150";

export const MAX_TRACE_POINTS = 1000;

const ACCEL_TILT_MIN_G = 0.7;
const ACCEL_TILT_MAX_G = 1.35;
const ORIENTATION_CORRECTION_TIME_S = 0.45;
const MAX_ORIENTATION_DT_S = 0.05;
const BROWSER_SHOT_TRACE_RATES = [0, 208, 416, 832];
const BROWSER_SHOT_TRACE_SECONDS = 20;
const BROWSER_SHOT_PRE_MS = 3500;
const DEFAULT_FOLLOW_THROUGH_MS = 1500;
const MAX_FOLLOW_THROUGH_MS = 3000;
const MIC_RING_PRE_MS = 500;
const MIC_RING_POST_PAD_MS = 500;
const MIC_RING_CAPACITY = 4000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function captureDeviceId(deviceId) {
  return typeof deviceId === "string" && deviceId ? deviceId : "OpenFloat-Sensor";
}

export function coachForScore({ formScore, holdStability, releaseQuality, followThrough, roll }) {
  if (scoreValue(formScore) == null) {
    return {
      coachTitle: "Waiting for movement",
      coachText: "Connect a sensor or run the demo to start reading hold stability.",
    };
  }

  if (Math.abs(roll) > 6) {
    return {
      coachTitle: "Watch bow cant",
      coachText: "Level the riser before expansion; cant drift is the biggest score limiter right now.",
    };
  }
  holdStability = scoreValue(holdStability);
  releaseQuality = scoreValue(releaseQuality);
  followThrough = scoreValue(followThrough);
  if (holdStability != null && holdStability < 65) {
    return {
      coachTitle: "Settle the hold",
      coachText: "Movement is building before the shot. Let the float shrink before you commit.",
    };
  }
  if (holdStability != null && releaseQuality == null && followThrough == null) {
    return {
      coachTitle: "Steady hold practice",
      coachText: "Focus on maintaining bubble level consistency and reducing hand drift during the hold.",
    };
  }
  if (releaseQuality != null && releaseQuality < 65) {
    return {
      coachTitle: "Soften the break",
      coachText: "Release motion is sharp. Keep pulling through instead of punching the shot.",
    };
  }
  if (followThrough != null && followThrough < 65) {
    return {
      coachTitle: "Stay in the shot",
      coachText: "The bow is moving quickly after release. Hold posture through impact.",
    };
  }
  if (holdStability == null || releaseQuality == null || followThrough == null) {
    return {
      coachTitle: "More trace data needed",
      coachText: "Some form measurements are unavailable. Record another capture to review the full sequence.",
    };
  }
  return {
    coachTitle: "Strong sequence",
    coachText: "Hold, release, and follow-through are all tracking cleanly.",
  };
}

function wrapAngleDeg(value) {
  let wrapped = value;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

function blendAngleDeg(current, target, weight) {
  return wrapAngleDeg(current + wrapAngleDeg(target - current) * weight);
}

function configuredFollowThroughMs() {
  try {
    const settings = JSON.parse(localStorage.getItem("openfloat_settings") || "{}");
    const value = Number(settings.followThrough);
    if (Number.isFinite(value)) {
      return clamp(value, 0, MAX_FOLLOW_THROUGH_MS);
    }
  } catch (_) {}
  return DEFAULT_FOLLOW_THROUGH_MS;
}

function configuredBrowserShotTraceRateHz() {
  try {
    const settings = JSON.parse(localStorage.getItem("openfloat_settings") || "{}");
    const index = Number(settings.bufferRate);
    if (Number.isInteger(index) && index >= 0 && index < BROWSER_SHOT_TRACE_RATES.length) {
      return BROWSER_SHOT_TRACE_RATES[index];
    }
  } catch (_) {}
  return BROWSER_SHOT_TRACE_RATES[1];
}

function accelTiltDeg(ax, ay, az) {
  return {
    roll: Math.atan2(ay, az) * (180 / Math.PI),
    pitch: Math.atan2(-ax, Math.hypot(ay, az)) * (180 / Math.PI),
  };
}

function sequenceDistance(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  const diff = Math.abs((left & 0xffff) - (right & 0xffff));
  return Math.min(diff, 0x10000 - diff);
}

function angleDistanceDeg(a, b) {
  return Math.abs(wrapAngleDeg(Number(a) - Number(b)));
}

function sampleQuaternion(sample) {
  const qw = Number(sample.qw);
  const qx = Number(sample.qx);
  const qy = Number(sample.qy);
  const qz = Number(sample.qz);
  if (![qw, qx, qy, qz].every(Number.isFinite)) return null;
  const mag = Math.hypot(qw, qx, qy, qz);
  if (!Number.isFinite(mag) || mag <= 0) return null;
  return {
    qw: qw / mag,
    qx: qx / mag,
    qy: qy / mag,
    qz: qz / mag,
  };
}

function quaternionAngularSpeedDps(previous, current, dtUs) {
  if (!previous || !current || !(dtUs > 0)) return 0;
  const dot = Math.abs(
    previous.qw * current.qw +
      previous.qx * current.qx +
      previous.qy * current.qy +
      previous.qz * current.qz,
  );
  const clampedDot = clamp(dot, -1, 1);
  const angleRad = 2 * Math.acos(clampedDot);
  return (angleRad * 180) / Math.PI / (dtUs / 1000000);
}

export class TelemetryStore {
  constructor(bus, store) {
    this.bus = bus;
    this.store = store;
    this.trace = [];
    this.shotTraceBuffer = [];
    this.micRingBuffer = [];
    this.history30s = []; // Rolling 30s telemetry buffer for manual captures
    this.pendingTraces = new Map();
    this.reset();

    bus.on("sample", (sample) => this.ingest(sample));
    bus.on("shot", (shot) => this.onShot(shot));
    bus.on("trace-chunk", (chunk) => this.onTraceChunk(chunk));
    // Same-link retries and protocol fallback also start a fresh assembly.
    bus.on("trace-start", ({ shotId }) => this.pendingTraces.delete(shotId));
    bus.on("trace-resume", (capture) => this.resumeFirmwareTrace(capture));
    // Device-reported lifetime count (e.g. restored from NVS on connect).
    // Updates the displayed counter only; not logged as a new shot.
    bus.on("shotcount", (count) => {
      this.deviceCountSynced = true;
      this.store.set({ shotCount: count });
    });
    // Device-reported backlog of shots saved before connecting, uploaded on
    // reconnect. Drives the inline "Uploading" status indicator.
    bus.on("upload-status", ({ pending, shotCount }) => {
      const patch = { uploadPending: Math.max(0, pending | 0) };
      if (Number.isInteger(shotCount) && shotCount >= 0 && shotCount <= 0xffffffff) {
        this.deviceCountSynced = true;
        patch.shotCount = shotCount;
      }
      this.store.set(patch);
    });
    bus.on("status", ({ mode, text, deviceId }) => {
      const connected = mode === "live" || mode === "demo";
      if (!connected && this.isRecordingManual) {
        this.isRecordingManual = false;
        this.manualRecordingEndLost = this.lost;
        this.manualRecordingStoppedAt = new Date().toISOString();
        store.set({
          manualRecordingPaused: true,
          manualRecordMessage: this.manualRecordingBuffer.length
            ? "Connection ended. Save or discard this recording before reconnecting."
            : "Connection ended before any samples arrived. Discard this recording to reconnect.",
        });
      }
      if (!connected) {
        this.connectionEpoch += 1;
        this.deviceCountSynced = false;
        this.connectionShotIds.clear();
        this.pendingTraces.clear();
        this.pendingShotSaves = new Map();
        this.trace.length = 0;
        this.shotTraceBuffer = [];
        this.micRingBuffer = [];
        this.history30s.length = 0;
        this.lastShotTracePushUs = 0;
        this.lastSeq = null;
        this.lastQuat = null;
        this.orientationReady = false;
      }
      store.set({
        statusMode: mode,
        statusText: text,
        connected,
        deviceId: connected ? (mode === "demo" ? "OpenFloat-Demo" : captureDeviceId(deviceId)) : null,
      });
    });

    // Per-second frame rate.
    setInterval(() => {
      this.store.set({ hz: this.framesThisSecond });
      this.framesThisSecond = 0;
    }, 1000);
  }

  reset() {
    // Switching transports must never erase an unsaved or pending capture.
    if (this.store.get().manualRecordingActive || this.isSavingManual) return false;
    this.connectionEpoch = (this.connectionEpoch || 0) + 1;
    this.deviceCountSynced = false;
    this.lastSeq = null;
    this.frameCount = 0;
    this.lost = 0;
    this.framesThisSecond = 0;
    this.orientationReady = false;
    this.filteredRoll = 0;
    this.filteredPitch = 0;
    this.filteredYaw = 0;
    this.lastQuat = null;
    this.trace.length = 0;
    // Pending captures retain their original buffers across a reconnect.
    this.shotTraceBuffer = [];
    this.micRingBuffer = [];
    this.pendingTraces.clear();
    this.history30s.length = 0; // Reset history buffer
    this.elapsedUs = 0;
    this.lastShotTracePushUs = 0;
    this.shotTraceRateHz = configuredBrowserShotTraceRateHz();
    this.shotTraceDtUs =
      this.shotTraceRateHz > 0 ? Math.round(1000000 / this.shotTraceRateHz) : 0;
    this.shotTraceCapacity = Math.max(
      1,
      Math.round(this.shotTraceRateHz * BROWSER_SHOT_TRACE_SECONDS),
    );
    // Sessions are now derived from shot timestamps at display time, not tracked
    // live. Shots are saved with session_id = null.
    this.currentSessionId = null;

    // device_shot_id values already saved during the current connection. Used
    // to dedup the device re-uploading the same shot (watchdog re-send of
    // shotdump, or a lost ack). Scoped per-connection because older firmware
    // and erased settings can reuse IDs, which would otherwise collide with
    // older shots in IndexedDB and wrongly drop new ones.
    // Keep the exact local id even if the record is deleted before its trace.
    this.connectionShotIds = new Map();
    this.pendingShotSaves = new Map();

    this.isRecordingManual = false;
    this.isSavingManual = false;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";
    this.manualRecordingDeviceId = null;

    this.store.set({
      frameCount: 0,
      lost: 0,
      hz: 0,
      shotCount: 0,
      roll: 0,
      pitch: 0,
      yaw: 0,
      qw: null,
      qx: null,
      qy: null,
      qz: null,
      sample: null,
      formScore: null,
      holdStability: null,
      releaseQuality: null,
      followThrough: null,
      levelConsistency: null,
      scoreVersion: FLOAT_SCORE_VERSION,
      lastShotSummary: null,
      deviceId: null,
      manualRecordingActive: false,
      manualRecordingPaused: false,
      manualRecordingSaving: false,
      manualRecordMessage: "",
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
    return true;
  }

  ingest(sample) {
    const sampleDtUs = sample.dtUs || 1000;
    this.elapsedUs += sampleDtUs;

    if (this.lastSeq !== null) {
      // Binary sequence is u16 and wraps; text sequence is effectively u32.
      const mask = sample.source === "binary" ? 0xffff : 0xffffffff;
      const delta = (sample.sequence - this.lastSeq) & mask;
      const gap = delta - (sample.sequenceStep || 1);
      if (gap > 0) this.lost += gap;
    }
    this.lastSeq = sample.sequence;
    this.frameCount += 1;
    this.framesThisSecond += 1;

    const ax = sample.axMg / 1000;
    const ay = sample.ayMg / 1000;
    const az = sample.azMg / 1000;
    const accelG = Math.hypot(sample.axMg, sample.ayMg, sample.azMg) / 1000;

    const { roll: accelRoll, pitch: accelPitch } = accelTiltDeg(ax, ay, az);
    let roll;
    let pitch;
    let yaw;

    if (sample.rollDeg !== undefined && sample.pitchDeg !== undefined) {
      roll = sample.rollDeg;
      pitch = sample.pitchDeg;
      yaw = sample.yawDeg !== undefined ? sample.yawDeg : this.filteredYaw;
      this.filteredRoll = roll;
      this.filteredPitch = pitch;
      this.filteredYaw = yaw;
      this.orientationReady = true;
    } else {
      // Legacy/custom transport fallback. Current BLE and demo samples provide
      // rollDeg/pitchDeg derived from the firmware Madgwick quaternion.
      const accelLooksLikeGravity =
        accelG >= ACCEL_TILT_MIN_G && accelG <= ACCEL_TILT_MAX_G;
      const dtS = Math.min(
        Math.max(sampleDtUs / 1000000, 0),
        MAX_ORIENTATION_DT_S,
      );

      if (!this.orientationReady) {
        this.filteredRoll = accelLooksLikeGravity ? accelRoll : 0;
        this.filteredPitch = accelLooksLikeGravity ? accelPitch : 0;
        this.filteredYaw = 0;
        this.orientationReady = true;
      } else {
        const gyroRoll = this.filteredRoll + (sample.gxDps || 0) * dtS;
        const gyroPitch = this.filteredPitch + (sample.gyDps || 0) * dtS;
        const gyroYaw = this.filteredYaw + (sample.gzDps || 0) * dtS;

        if (accelLooksLikeGravity) {
          const correctionWeight =
            1 - Math.exp(-dtS / ORIENTATION_CORRECTION_TIME_S);
          this.filteredRoll = blendAngleDeg(
            gyroRoll,
            accelRoll,
            correctionWeight,
          );
          this.filteredPitch = blendAngleDeg(
            gyroPitch,
            accelPitch,
            correctionWeight,
          );
        } else {
          this.filteredRoll = wrapAngleDeg(gyroRoll);
          this.filteredPitch = wrapAngleDeg(gyroPitch);
        }
        this.filteredYaw = wrapAngleDeg(gyroYaw);
      }

      roll = this.filteredRoll;
      pitch = this.filteredPitch;
      yaw = this.filteredYaw;
    }

    const quat = sampleQuaternion(sample);
    const rawGyroMag = Math.hypot(sample.gxDps || 0, sample.gyDps || 0, sample.gzDps || 0);
    const quatRateDps =
      quat && sample.gyroAvailable === false
        ? quaternionAngularSpeedDps(this.lastQuat, quat, sampleDtUs)
        : 0;
    const gyroMag = sample.gyroAvailable === false ? quatRateDps : rawGyroMag;
    this.lastQuat = quat || null;

    const tracePoint = {
      ax,
      ay,
      az,
      gx: sample.gxDps,
      gy: sample.gyDps,
      gz: sample.gzDps,
      rotDps: gyroMag,
      roll,
      pitch,
      yaw,
      ...(quat || {}),
      micAmp: sample.micAmp || 0,
      tUs: this.elapsedUs
    };

    this.trace.push(tracePoint);
    
    // Prune the live trace rolling buffer based on the configured live duration (in seconds).
    // Instead of shift()-ing one element at a time (O(n) per shift), we find
    // the first in-range index and batch-splice when the stale head grows large
    // enough to amortise the array reindex cost.
    const liveDurationSec = this.store.get().liveTraceDuration ?? 10;
    const durationUs = liveDurationSec * 1000000;
    const cutoffUs = this.elapsedUs - durationUs;
    if (this.trace.length > 0 && this.trace[0].tUs < cutoffUs) {
      // Binary search for the first index >= cutoffUs
      let lo = 0, hi = this.trace.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.trace[mid].tUs < cutoffUs) lo = mid + 1;
        else hi = mid;
      }
      // Only splice when we have a meaningful batch to remove (amortised O(1))
      if (lo >= 512 || lo >= this.trace.length * 0.25) {
        this.trace.splice(0, lo);
      }
    }

    const configuredShotTraceRate = configuredBrowserShotTraceRateHz();
    if (configuredShotTraceRate !== this.shotTraceRateHz) {
      this.shotTraceRateHz = configuredShotTraceRate;
      this.shotTraceDtUs =
        this.shotTraceRateHz > 0 ? Math.round(1000000 / this.shotTraceRateHz) : 0;
      this.shotTraceCapacity = Math.max(
        1,
        Math.round(this.shotTraceRateHz * BROWSER_SHOT_TRACE_SECONDS),
      );
      this.shotTraceBuffer = [];
      this.lastShotTracePushUs = this.elapsedUs;
    }
    if (
      this.shotTraceRateHz > 0 &&
      (this.shotTraceBuffer.length === 0 ||
        this.elapsedUs - this.lastShotTracePushUs >= this.shotTraceDtUs)
    ) {
      this.shotTraceBuffer.push({
        ...tracePoint,
        tUs: this.elapsedUs,
        sequence: sample.sequence,
        deviceUptimeUs: sample.uptimeUs,
        lost: this.lost,
      });
      this.lastShotTracePushUs = this.elapsedUs;
      if (this.shotTraceBuffer.length > this.shotTraceCapacity) {
        this.shotTraceBuffer.shift();
      }

      this.history30s.push({
        ...tracePoint,
        sample: sample.source === "demo",
        lost: this.lost
      });
      const historyCutoffUs = this.elapsedUs - 30000000;
      while (this.history30s[0]?.tUs < historyCutoffUs) {
        this.history30s.shift();
      }
    }

    this.micRingBuffer.push({
      tUs: this.elapsedUs,
      micAmp: sample.micAmp || 0,
    });
    if (this.micRingBuffer.length > MIC_RING_CAPACITY) {
      this.micRingBuffer.shift();
    }

    if (this.isRecordingManual) {
      this.manualRecordingBuffer.push({
        ...tracePoint,
        sample: sample.source === "demo",
      });
      this.manualRecordingDurationUs += sampleDtUs;
      this.store.set({
        manualRecordSamples: this.manualRecordingBuffer.length,
        manualRecordElapsedSec: Number((this.manualRecordingDurationUs / 1000000).toFixed(1))
      });
    }

    const score = computeLiveFloatScore({ roll, pitch, gyroMag, accelG, trace: this.trace });
    const coaching = coachForScore({ ...score, roll });

    this.store.set({
      sample,
      frameCount: this.frameCount,
      lost: this.lost,
      accelG,
      gyroMag,
      shotCount:
        sample.shotCount != null ? sample.shotCount : this.store.get().shotCount,
      roll,
      pitch,
      yaw,
      qw: quat ? quat.qw : null,
      qx: quat ? quat.qx : null,
      qy: quat ? quat.qy : null,
      qz: quat ? quat.qz : null,
      ...score,
      ...coaching,
    });
  }

  // Newest shot record with this sensor key and device_shot_id within the dedup
  // window, or null. The 24 h window bounds how long a re-uploaded shot is
  // treated as a duplicate, so a same-id shot after a firmware reset on a
  // later day is still saved as new.
  async findRecentShotByDeviceId(deviceShotId, deviceId = this.store.get().deviceId) {
    const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
    deviceId = captureDeviceId(deviceId);
    try {
      const shots = await getAll("shots");
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      let newest = null;
      for (const record of shots) {
        if (record.device_id !== deviceId) continue;
        if (record.device_shot_id !== deviceShotId) continue;
        const savedAt = Date.parse(record.timestamp);
        if (!Number.isFinite(savedAt) || savedAt < cutoff) continue;
        if (!newest || savedAt > Date.parse(newest.timestamp)) {
          newest = record;
        }
      }
      return newest;
    } catch (err) {
      // Dedup is best-effort; on a DB read failure fall through and save,
      // matching the pre-dedup behavior.
      return null;
    }
  }

  async needsFirmwareTrace(localShotId) {
    try {
      // A deleted capture stays deleted; otherwise an absent or empty replay
      // still needs recovery even when its metadata was already committed.
      if (!await get("shots", localShotId)) return false;
      const trace = await get("shot_traces", localShotId);
      return !Array.isArray(trace?.payload) || trace.payload.length === 0;
    } catch (error) {
      // Metadata remains committed. A read failure can still try the device's
      // retained trace without rewriting metadata or losing acknowledgement.
      this.bus.emitAsync("log", `Saved trace check failed: ${error?.message || "Storage unavailable"}. Requesting firmware recovery.`);
      return true;
    }
  }

  async resumeFirmwareTrace({ shotId, localShotId } = {}) {
    if (!Number.isInteger(shotId) || shotId < 0 || shotId > 0xffffffff ||
        typeof localShotId !== "string" || !localShotId || !this.store.get().connected) return false;
    const epoch = this.connectionEpoch;
    const deviceId = captureDeviceId(this.store.get().deviceId);
    const shot = await get("shots", localShotId);
    // Restore this capture's exact mapping, never a recent reused counter.
    if (!shot || shot.device_id !== deviceId || shot.device_shot_id !== shotId) return false;
    const needed = await this.needsFirmwareTrace(localShotId);
    if (!needed || epoch !== this.connectionEpoch || !this.store.get().connected ||
        captureDeviceId(this.store.get().deviceId) !== deviceId) return false;
    const current = this.connectionShotIds.get(shotId);
    if (current && current !== localShotId) return false;
    this.connectionShotIds.set(shotId, localShotId);
    this.pendingTraces.delete(shotId);
    return true;
  }

  async onShot(shot) {
    const pending = this.pendingShotSaves;
    if (shot.shotId != null && pending.has(shot.shotId)) return pending.get(shot.shotId);
    const work = this.saveDeviceShot(shot);
    if (shot.shotId != null) pending.set(shot.shotId, work);
    try {
      return await work;
    } finally {
      if (pending.get(shot.shotId) === work) pending.delete(shot.shotId);
    }
  }

  async saveDeviceShot(shot) {
    const peakG = Math.hypot(shot.axMg, shot.ayMg, shot.azMg) / 1000;
    const shotTimeUs = this.elapsedUs;
    const capturedAt = new Date().toISOString();
    const activeState = this.store.get();
    // Notifications can precede the live status; the receiving adapter supplies
    // their identity. Snapshot it before storage waits or a transport switch.
    const deviceId = captureDeviceId(shot.sourceConnection?.deviceId ?? activeState.deviceId);
    const startLost = this.lost;
    const captureContext = { epoch: this.connectionEpoch, motion: this.shotTraceBuffer, mic: this.micRingBuffer };
    const followThroughMs = configuredFollowThroughMs();
    const browserTraceRateHz = configuredBrowserShotTraceRateHz();
    const displayedCount = shot.stored && this.deviceCountSynced ? activeState.shotCount : shot.shotCount;
    if (!shot.stored) this.deviceCountSynced = true;
    this.store.set({ shotCount: displayedCount, lastShot: shot });

    // Repeated frames re-acknowledge their committed capture without waiting
    // for view callbacks or creating another write.
    if (shot.shotId != null && this.connectionShotIds.has(shot.shotId)) {
      const localShotId = this.connectionShotIds.get(shot.shotId);
      const traceNeeded = !!shot.stored && await this.needsFirmwareTrace(localShotId);
      this.bus.emitAsync("log", `Shot id ${shot.shotId} already handled this connection; re-acknowledging.`);
      this.notifySavedShot({ shotId: captureContext.epoch === this.connectionEpoch ? shot.shotId : null,
        stored: !!shot.stored, duplicate: true, traceNeeded,
        localShotId, sourceConnection: shot.sourceConnection });
      return localShotId;
    }

    // Stored re-uploads can recover a lost acknowledgement across connections.
    // Older firmware and erased settings can reuse IDs; match only recent records.
    if (shot.stored && shot.shotId != null) {
      const recentMatch = await this.findRecentShotByDeviceId(shot.shotId, deviceId);
      if (recentMatch) {
        const traceNeeded = await this.needsFirmwareTrace(recentMatch.id);
        this.bus.emitAsync("log", `Stored shot id ${shot.shotId} already saved at ${recentMatch.timestamp}; re-acknowledging.`);
        if (captureContext.epoch !== this.connectionEpoch) return recentMatch.id;
        this.connectionShotIds.set(shot.shotId, recentMatch.id);
        this.notifySavedShot({ shotId: shot.shotId, stored: true, duplicate: true, traceNeeded,
          localShotId: recentMatch.id, sourceConnection: shot.sourceConnection });
        return recentMatch.id;
      }
    }

    this.bus.emitAsync(
      "log",
      `Shot #${shot.shotCount} (id ${shot.shotId}) peak ~${peakG.toFixed(1)} g`,
    );

    let localShotId;
    let shotRecord;
    try {
      // Save metadata and its upload task as one transaction.
      localShotId = generateUUID();
      const ax = (shot.axMg || 0) / 1000;
      const ay = (shot.ayMg || 0) / 1000;
      const az = (shot.azMg ?? 1000) / 1000;
      const computedRoll = Math.atan2(ay, az) * (180 / Math.PI);
      const computedPitch = Math.atan2(-ax, Math.hypot(ay, az)) * (180 / Math.PI);

      const yaw = Number.isFinite(shot.yawDeg) ? shot.yawDeg
        : !shot.stored && Number.isFinite(activeState.yaw) ? activeState.yaw : null;
      shotRecord = {
        id: localShotId,
        session_id: null,
        device_id: deviceId,
        capture_kind: "arrow",
        device_shot_id: shot.shotId,
        stored_upload: !!shot.stored,
        timestamp: capturedAt,
        peak_g: peakG,
        cant_angle_deg: Number((shot.rollDeg !== undefined ? shot.rollDeg : computedRoll).toFixed(1)),
        pitch_angle_deg: Number((shot.pitchDeg !== undefined ? shot.pitchDeg : computedPitch).toFixed(1)),
        yaw_angle_deg: yaw == null ? null : Number(yaw.toFixed(1)),
        roll_angle_deg: Number((shot.rollDeg !== undefined ? shot.rollDeg : computedRoll).toFixed(1)),
        // Event metadata has no hold/release windows. Live dashboard metrics
        // can belong to a different movement, especially during stored uploads.
        // Only this capture's browser trace can supply its full v1 score.
        stability_score: null,
        shot_score: null,
        hold_stability: null,
        release_quality: null,
        follow_through: null,
        level_consistency: null,
        score_version: FLOAT_SCORE_VERSION,
        packet_loss_count: null
      };

      await saveCapture(shotRecord);
    } catch (error) {
      console.error("Local storage / sync queuing failed for shot:", error);
      this.bus.emitAsync("log", `Offline save error: ${error.message}`);
      return null;
    }
    // Mark handled only after a successful save, so a failed write can still
    // be retried when the device re-sends the shot.
    const sameConnection = captureContext.epoch === this.connectionEpoch;
    if (shot.shotId != null && sameConnection) {
      this.connectionShotIds.set(shot.shotId, localShotId);
    }

    if (!shot.stored && browserTraceRateHz > 0) {
      this.scheduleBrowserShotTraceCapture(
        localShotId,
        shot.shotId,
        shotTimeUs,
        shot,
        followThroughMs,
        browserTraceRateHz,
        startLost,
        captureContext,
      );
    }

    this.bus.emitAsync(
      "log",
      shot.stored
        ? `Stored shot metadata saved; waiting for firmware trace upload.`
        : browserTraceRateHz > 0
          ? `Shot metadata saved; browser ${browserTraceRateHz} Hz trace will freeze after ${(followThroughMs / 1000).toFixed(1)} s.`
          : `Shot metadata saved; browser trace capture is off.`,
    );
    if (sameConnection) this.store.set({
      lastShotSummary: {
        timestamp: shotRecord.timestamp,
        score: shotRecord.shot_score,
        peakG: shotRecord.peak_g,
        cant: shotRecord.cant_angle_deg,
        pitch: shotRecord.pitch_angle_deg,
        yaw: shotRecord.yaw_angle_deg,
      },
    });
    this.notifySavedShot({
      shotId: sameConnection ? shot.shotId : null,
      stored: !!shot.stored,
      localShotId,
      sourceConnection: shot.sourceConnection,
    });

    // Dispatch the queued upload without delaying the committed capture.
    this.triggerCaptureSync("Shot");
    return localShotId;
  }

  notifySavedShot(payload) {
    // Metadata's pending promise represents its write, not an asynchronous
    // view refresh. Firmware chunks can proceed while a saved view is busy.
    this.bus.emitAsync("shot-saved", payload).then((results) => {
      if (results.some((result) => result.status === "rejected" || result.value === false)) {
        this.bus.emitAsync("log", "Shot saved locally. Some saved views or device callbacks could not finish. Reopen Saved Shots or reconnect to retry.");
      }
    });
  }

  resolveShotTimeUs(shot, fallbackUs = this.elapsedUs, traceBuffer = this.shotTraceBuffer) {
    if (!shot || !traceBuffer.length) return fallbackUs;

    const uptimeUs = Number(shot.uptimeUs);
    if (Number.isFinite(uptimeUs)) {
      let best = null;
      let bestDiff = Infinity;
      for (const point of traceBuffer) {
        const pointUptimeUs = Number(point.deviceUptimeUs);
        if (!Number.isFinite(pointUptimeUs)) continue;
        const diff = Math.abs(pointUptimeUs - uptimeUs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = point;
        }
      }
      if (best && bestDiff <= 50000) {
        return best.tUs;
      }
    }

    const shotSequence = Number(shot.shotSequence);
    if (Number.isFinite(shotSequence) && shotSequence > 0) {
      let best = null;
      let bestDiff = Infinity;
      for (const point of traceBuffer) {
        const diff = sequenceDistance(point.sequence, shotSequence);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = point;
        }
      }
      if (best && bestDiff <= 24) {
        return best.tUs;
      }
    }

    const shotAx = Number(shot.axMg) / 1000;
    const shotAy = Number(shot.ayMg) / 1000;
    const shotAz = Number(shot.azMg) / 1000;
    const hasAccel =
      Number.isFinite(shotAx) &&
      Number.isFinite(shotAy) &&
      Number.isFinite(shotAz) &&
      Math.hypot(shotAx, shotAy, shotAz) >= 2;

    if (hasAccel) {
      let best = null;
      let bestError = Infinity;
      for (const point of traceBuffer) {
        const accelError =
          Math.abs((point.ax || 0) - shotAx) +
          Math.abs((point.ay || 0) - shotAy) +
          Math.abs((point.az || 0) - shotAz);
        const rollError = Number.isFinite(Number(shot.rollDeg))
          ? angleDistanceDeg(point.roll || 0, shot.rollDeg) / 10
          : 0;
        const pitchError = Number.isFinite(Number(shot.pitchDeg))
          ? angleDistanceDeg(point.pitch || 0, shot.pitchDeg) / 10
          : 0;
        const error = accelError + rollError + pitchError;
        if (error < bestError) {
          bestError = error;
          best = point;
        }
      }
      if (best && bestError <= 1.5) {
        return best.tUs;
      }
    }

    return fallbackUs;
  }

  scheduleBrowserShotTraceCapture(localShotId, deviceShotId, shotTimeUs, shot, followThroughMs, sampleRateHz, startLost,
    captureContext = { epoch: this.connectionEpoch, motion: this.shotTraceBuffer, mic: this.micRingBuffer }) {
    const delayMs = Math.max(0, followThroughMs + 100);

    setTimeout(() => {
      return this.saveBrowserShotTrace(
        localShotId,
        deviceShotId,
        shotTimeUs,
        shot,
        sampleRateHz,
        followThroughMs,
        startLost,
        captureContext,
      );
    }, delayMs);
  }

  buildMicSeriesForShot(shotTimeUs, followThroughMs = configuredFollowThroughMs(), micBuffer = this.micRingBuffer) {
    return extractMicWindow(
      micBuffer,
      shotTimeUs,
      MIC_RING_PRE_MS,
      followThroughMs + MIC_RING_POST_PAD_MS,
    );
  }

  async saveBrowserShotTrace(
    localShotId,
    deviceShotId,
    shotTimeUs,
    shot,
    sampleRateHz,
    followThroughMs = configuredFollowThroughMs(),
    startLost = this.lost,
    captureContext = { epoch: this.connectionEpoch, motion: this.shotTraceBuffer, mic: this.micRingBuffer },
  ) {
    const resolvedShotTimeUs = this.resolveShotTimeUs(shot, shotTimeUs, captureContext.motion);
    const resolvedFreezeAtUs = resolvedShotTimeUs + followThroughMs * 1000;
    const startAtUs = resolvedShotTimeUs - BROWSER_SHOT_PRE_MS * 1000;
    const frozenWithTime = captureContext.motion
      .filter((point) => point.tUs >= startAtUs && point.tUs <= resolvedFreezeAtUs);
    const frozen = frozenWithTime.map(({ tUs, sequence, deviceUptimeUs, lost, ...point }) => ({
      ...point,
      tUs: tUs - resolvedShotTimeUs,
    }));

    if (frozen.length === 0) {
      this.bus.emitAsync("log", `No browser trace samples available for shot ID ${deviceShotId}.`);
      return;
    }

    let micSeries = this.buildMicSeriesForShot(resolvedShotTimeUs, followThroughMs, captureContext.mic);
    if (micSeries.length === 0 && frozenWithTime.length > 0) {
      micSeries = frozenWithTime.map((point) => ({
        tUs: point.tUs - resolvedShotTimeUs,
        micAmp: point.micAmp || 0,
      }));
    }
    const tracePayload = buildShotTraceRecord({
      localShotId,
      sampleRateHz,
      payload: frozen,
      micSeries,
      source: "browser",
    });

    let updatedShot;
    let traceScore;
    try {
      const releaseIndex = frozenWithTime.findIndex((point) => point.tUs >= resolvedShotTimeUs);
      traceScore = computeFloatScoreFromTrace(frozen, {
        sampleRateHz,
        releaseIndex: releaseIndex >= 0 ? releaseIndex : undefined,
      });
      const endLost = frozenWithTime.at(-1)?.lost ?? startLost;
      updatedShot = await saveShotTrace(tracePayload, {
        stability_score: traceScore.holdStability,
        shot_score: traceScore.formScore,
        hold_stability: traceScore.holdStability,
        release_quality: traceScore.releaseQuality,
        follow_through: traceScore.followThrough,
        level_consistency: traceScore.levelConsistency,
        score_version: traceScore.scoreVersion,
        packet_loss_count: Math.max(0, endLost - startLost),
      });
    } catch (error) {
      console.error("Delayed browser trace save failed:", error);
      this.bus.emitAsync("log", `Browser trace save error: ${error.message}`);
      return null;
    }
    if (!updatedShot) {
      this.bus.emitAsync("log", `Capture ${localShotId.slice(0, 8)} was deleted; skipped its delayed trace.`);
      return null;
    }
    const active = this.store.get();
    // History refreshes an active review from its current committed snapshot.
    // A delayed writer must not put older metrics or samples back into it.
    if (captureContext.epoch === this.connectionEpoch && !active.reviewMode &&
        active.lastShot?.shotId === deviceShotId) {
      this.store.set({
        formScore: traceScore.formScore,
        holdStability: traceScore.holdStability,
        releaseQuality: traceScore.releaseQuality,
        followThrough: traceScore.followThrough,
        levelConsistency: traceScore.levelConsistency,
        scoreVersion: traceScore.scoreVersion,
        lastShotSummary: {
          timestamp: updatedShot.timestamp,
          score: updatedShot.shot_score,
          peakG: updatedShot.peak_g,
          cant: updatedShot.cant_angle_deg,
          pitch: updatedShot.pitch_angle_deg,
          yaw: updatedShot.yaw_angle_deg,
        },
      });
    }
    this.bus.emitAsync(
      "log",
      `Browser trace saved for shot ID ${deviceShotId} (${frozen.length} motion samples, ${(BROWSER_SHOT_PRE_MS / 1000).toFixed(1)} s pre + ${(followThroughMs / 1000).toFixed(1)} s follow @ ${sampleRateHz} Hz` +
        `${micSeries.length ? `, ${micSeries.length} mic samples` : ""}).`,
    );
    await this.notifySavedTrace(localShotId, deviceShotId);
    return localShotId;
  }

  triggerCaptureSync(capture) {
    const syncAdapter = this.syncAdapter;
    if (!syncAdapter) return;
    // Uploads stay queued locally. Their dispatch cannot reject a committed
    // capture, delay view refresh, or change a newer recording's status.
    Promise.resolve().then(() => syncAdapter.triggerSync()).catch((error) => {
      console.warn(`${capture} saved locally; cloud sync could not start:`, error);
      this.bus.emitAsync("log", `${capture} saved locally; cloud sync will retry: ${error?.message || "Sync unavailable"}`);
    });
  }

  async notifySavedTrace(localShotId, deviceShotId) {
    this.triggerCaptureSync("Trace");
    let refreshed = false;
    try {
      const notifications = await this.bus.emitAsync("shot-trace-saved", { localShotId, deviceShotId });
      refreshed = notifications.every((result) => result.status === "fulfilled" && result.value !== false);
    } catch (error) {
      console.warn("Trace saved locally; saved views could not refresh:", error);
    }
    if (!refreshed) {
      this.bus.emitAsync("log", `Trace saved locally for ${localShotId.slice(0, 8)}. Some views could not refresh. Reopen Saved Shots or Training to retry the views.`);
    }
  }

  async saveManual30sCapture() {
    if (this.history30s.length === 0) {
      this.bus.emit("log", "No telemetry data recorded yet to save.");
      return;
    }

    const deviceId = captureDeviceId(this.store.get().deviceId);
    const { payload: timedBuffer, sampleRateHz: hz } = prepareTimedTrace(
      this.history30s, this.shotTraceRateHz > 0 ? this.shotTraceRateHz : 52,
    );
    const isDemo = this.history30s.some((point) => point.sample);
    const durationSec = (timedBuffer.at(-1)?.tUs || 0) / 1000000;
    this.bus.emit("log", `Saving last ${durationSec.toFixed(1)}s of live telemetry (${timedBuffer.length} samples at about ${hz} Hz)...`);

    try {
      // 1. Compute metrics from the 30s buffer
      let maxG = 0;
      let sumStability = 0;
      
      const parsedTrace = timedBuffer.map((pt) => {
        const g = Math.hypot(pt.ax, pt.ay, pt.az);
        if (g > maxG) maxG = g;
        
        const gyroMag = Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
        const stability = 100 - Math.min(100, gyroMag);
        sumStability += stability;

        return {
          ax: pt.ax,
          ay: pt.ay,
          az: pt.az,
          gx: pt.gx || 0,
          gy: pt.gy || 0,
          gz: pt.gz || 0,
          rotDps: pt.rotDps || 0,
          roll: pt.roll,
          pitch: pt.pitch,
          yaw: pt.yaw || 0,
          ...(sampleQuaternion(pt) || {}),
          micAmp: pt.micAmp || 0,
          tUs: pt.tUs,
        };
      });

      const avgStability = Number((sumStability / timedBuffer.length).toFixed(1));
      const floatScore = computeFloatScoreFromTrace(parsedTrace, { sampleRateHz: hz, isManual: true });

      // 3. Save shot metadata (representing the manual capture)
      const startLost = this.history30s[0]?.lost ?? this.lost;
      const shotLoss = Math.max(0, this.lost - startLost);
      const manualShotId = generateUUID();
      const shotRecord = {
        id: manualShotId,
        session_id: null,
        device_id: isDemo ? "OpenFloat-Demo" : deviceId,
        capture_kind: "hold",
        sample: isDemo,
        timestamp: new Date().toISOString(),
        peak_g: Number(maxG.toFixed(2)),
        cant_angle_deg: 0,
        pitch_angle_deg: 0,
        yaw_angle_deg: 0,
        roll_angle_deg: 0,
        stability_score: avgStability,
        shot_score: floatScore.formScore,
        hold_stability: floatScore.holdStability,
        release_quality: floatScore.releaseQuality,
        follow_through: floatScore.followThrough,
        level_consistency: floatScore.levelConsistency,
        score_version: floatScore.scoreVersion,
        packet_loss_count: shotLoss
      };

      // 4. Save trace payload (the full history buffer)
      const tracePayload = buildShotTraceRecord({
        localShotId: manualShotId,
        sampleRateHz: hz,
        payload: parsedTrace,
        micSeries: parsedTrace.map((point) => ({
          tUs: point.tUs,
          micAmp: point.micAmp || 0,
        })),
        source: isDemo ? "sample" : "browser-manual-30s",
      });
      tracePayload.sample = isDemo;
      await saveCapture(shotRecord, tracePayload);

      this.bus.emit("log", `Manual 30s capture saved successfully (ID: ${manualShotId.slice(0, 8)}).`);
      this.store.set({
        lastShotSummary: {
          timestamp: shotRecord.timestamp,
          score: shotRecord.shot_score,
          peakG: shotRecord.peak_g,
          cant: shotRecord.cant_angle_deg,
          pitch: shotRecord.pitch_angle_deg,
          yaw: shotRecord.yaw_angle_deg,
        },
      });

      this.bus.emit("shot-saved", {
        shotId: null,
        stored: false,
        localShotId: manualShotId,
      });

      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }
    } catch (error) {
      console.error("Failed to save manual capture:", error);
      this.bus.emit("log", `Manual capture failed: ${error.message}`);
    }
  }

  startManualRecording(label) {
    if (!this.store.get().connected || this.store.get().manualRecordingActive || this.isSavingManual) return false;
    this.isRecordingManual = true;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = String(label || "");
    this.manualRecordingDeviceId = captureDeviceId(this.store.get().deviceId);
    this.manualRecordingStartLost = this.lost;
    this.manualRecordingEndLost = null;
    this.manualRecordingStoppedAt = null;
    
    this.store.set({
      manualRecordingActive: true,
      manualRecordingPaused: false,
      manualRecordingSaving: false,
      manualRecordMessage: "Recording. Stop to save, or discard when finished.",
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
    this.bus.emitAsync("log", `Manual recording started: "${label || 'Untitled'}"`);
    return true;
  }

  discardManualRecording() {
    if (this.isSavingManual) return false;
    this.isRecordingManual = false;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";
    this.manualRecordingDeviceId = null;
    
    this.store.set({
      manualRecordingActive: false,
      manualRecordingPaused: false,
      manualRecordMessage: "Recording discarded.",
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
    this.bus.emitAsync("log", "Manual recording discarded.");
    return true;
  }

  async saveManualRecording() {
    if (this.isSavingManual) return null;
    if (this.manualRecordingBuffer.length === 0) {
      this.store.set({ manualRecordMessage: "No samples to save yet. Wait for telemetry or discard this recording." });
      this.bus.emitAsync("log", "No telemetry data recorded yet to save.");
      return null;
    }

    this.isRecordingManual = false;
    this.isSavingManual = true;
    this.manualRecordingEndLost ??= this.lost;
    this.manualRecordingStoppedAt ??= new Date().toISOString();
    this.store.set({ manualRecordingPaused: true, manualRecordingSaving: true, manualRecordMessage: "Saving recording..." });
    let label;
    let manualShotId;
    let shotRecord;
    try {
      const isDemo = this.manualRecordingBuffer.some((point) => point.sample);
      const durationSec = this.manualRecordingDurationUs / 1000000;
      const rawSampleRateHz = durationSec > 0 ? this.manualRecordingBuffer.length / durationSec : 52;
      const { payload: decimatedBuffer, sampleRateHz } = prepareTimedTrace(this.manualRecordingBuffer, 52, rawSampleRateHz);
      label = this.manualRecordingLabel.trim() || "Manual Recording";
      this.bus.emitAsync("log", `Saving manual recording: "${label}" (${durationSec.toFixed(1)}s, ${decimatedBuffer.length} replay points at about ${sampleRateHz} Hz)...`);

      // 1. Compute metrics
      let maxG = 0;
      let sumStability = 0;
      const parsedTrace = decimatedBuffer.map((pt) => {
        const g = Math.hypot(pt.ax, pt.ay, pt.az);
        if (g > maxG) maxG = g;
        
        const gyroMag = Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
        const stability = 100 - Math.min(100, gyroMag);
        sumStability += stability;

        return {
          ax: pt.ax,
          ay: pt.ay,
          az: pt.az,
          gx: pt.gx || 0,
          gy: pt.gy || 0,
          gz: pt.gz || 0,
          rotDps: pt.rotDps || 0,
          roll: pt.roll,
          pitch: pt.pitch,
          yaw: pt.yaw || 0,
          ...(sampleQuaternion(pt) || {}),
          micAmp: pt.micAmp || 0,
          tUs: pt.tUs,
        };
      });

      const avgStability = decimatedBuffer.length > 0
        ? Number((sumStability / decimatedBuffer.length).toFixed(1))
        : 100;
      const floatScore = computeFloatScoreFromTrace(parsedTrace, { sampleRateHz, isManual: true });

      // 2. Save shot record
      const startLost = this.manualRecordingStartLost ?? this.lost;
      const shotLoss = Math.max(0, this.manualRecordingEndLost - startLost);
      manualShotId = generateUUID();
      shotRecord = {
        id: manualShotId,
        session_id: null,
        device_id: isDemo ? "OpenFloat-Demo" : captureDeviceId(this.manualRecordingDeviceId ?? this.store.get().deviceId),
        capture_kind: "hold",
        sample: isDemo,
        timestamp: this.manualRecordingStoppedAt,
        peak_g: Number(maxG.toFixed(2)),
        cant_angle_deg: 0,
        pitch_angle_deg: 0,
        yaw_angle_deg: 0,
        roll_angle_deg: 0,
        stability_score: avgStability,
        shot_score: floatScore.formScore,
        hold_stability: floatScore.holdStability,
        release_quality: floatScore.releaseQuality,
        follow_through: floatScore.followThrough,
        level_consistency: floatScore.levelConsistency,
        score_version: floatScore.scoreVersion,
        packet_loss_count: shotLoss,
        label: label
      };

      // 4. Save trace record
      const tracePayload = buildShotTraceRecord({
        localShotId: manualShotId,
        sampleRateHz,
        payload: parsedTrace,
        micSeries: parsedTrace.map((point) => ({
          tUs: point.tUs,
          micAmp: point.micAmp || 0,
        })),
        source: isDemo ? "sample" : "browser-manual-recording",
      });
      tracePayload.sample = isDemo;
      await saveCapture(shotRecord, tracePayload);
    } catch (error) {
      console.error("Failed to save manual recording:", error);
      this.isSavingManual = false;
      this.store.set({
        manualRecordingSaving: false,
        manualRecordMessage: "Could not save. Your recording is still in this tab; press Save to retry.",
      });
      this.bus.emitAsync("log", `Manual recording save failed: ${error.message}`);
      return null;
    }

    // The transaction committed. Clear the unsaved draft before notifying
    // views, and keep controls locked until those notifications settle.
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";
    this.store.set({
      manualRecordingActive: false,
      manualRecordingPaused: false,
      manualRecordMessage: "Recording saved locally. Refreshing saved views...",
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0,
      lastShotSummary: {
        timestamp: shotRecord.timestamp,
        score: shotRecord.shot_score,
        peakG: shotRecord.peak_g,
        cant: shotRecord.cant_angle_deg,
        pitch: shotRecord.pitch_angle_deg,
        yaw: shotRecord.yaw_angle_deg,
      }
    });

    this.bus.emitAsync("log", `Manual recording saved successfully: "${label}" (ID: ${manualShotId.slice(0, 8)}).`);
    this.triggerCaptureSync("Recording");
    let refreshed = false;
    try {
      const notifications = await this.bus.emitAsync("shot-saved", {
        shotId: null,
        stored: false,
        localShotId: manualShotId,
      });
      refreshed = notifications.every((result) => result.status === "fulfilled" && result.value !== false);
    } catch (error) {
      console.warn("Manual recording saved locally; saved views could not refresh:", error);
    }
    this.isSavingManual = false;
    this.store.set({
      manualRecordingSaving: false,
      manualRecordMessage: refreshed
        ? "Recording saved locally."
        : "Recording saved locally. Some views could not refresh. Reopen Saved Shots or Training to retry the views.",
    });
    return manualShotId;
  }

  getTrace() {
    return this.trace;
  }

  async onTraceChunk(chunk) {
    const protocol = chunk.protocol || 1;
    const payloadSize = protocol === 2 ? 15 : 19;
    if (!Number.isInteger(chunk.totalChunks) || chunk.totalChunks <= 0 ||
        chunk.totalChunks > (protocol === 2 ? (chunk.timed ? 535 : 534) : 255) ||
        !Number.isInteger(chunk.shotId) || chunk.shotId < 0 || chunk.shotId > 0xffffffff ||
        !Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunk.totalChunks ||
        ![1, 2].includes(protocol) || (chunk.timed && (protocol !== 2 || chunk.pointStride !== 8)) ||
        !(Array.isArray(chunk.payload) || chunk.payload instanceof Uint8Array) ||
        !chunk.payload.length || chunk.payload.length > payloadSize ||
        !chunk.payload.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
        (protocol === 2 && (![4, 6, 7, 8].includes(chunk.pointStride) ||
          (chunk.chunkIndex < chunk.totalChunks - 1 && chunk.payload.length !== payloadSize)))) {
      this.bus.emitAsync("log", `Ignoring invalid trace chunk ${chunk.chunkIndex}/${chunk.totalChunks} for shot ID ${chunk.shotId}.`);
      return;
    }
    const epoch = this.connectionEpoch;
    const pendingSaves = this.pendingShotSaves;
    if (!this.pendingTraces.has(chunk.shotId)) {
      this.pendingTraces.set(chunk.shotId, { chunks: new Map(), totalChunks: chunk.totalChunks, pointStride: 0, protocol, timed: !!chunk.timed });
    }
    const pending = this.pendingTraces.get(chunk.shotId);
    if (pending.saving) return;
    const previous = pending.chunks.get(chunk.chunkIndex);
    if (pending.totalChunks !== chunk.totalChunks || pending.protocol !== protocol || pending.timed !== !!chunk.timed ||
        (pending.pointStride && chunk.pointStride && pending.pointStride !== chunk.pointStride) ||
        (previous && (previous.length !== chunk.payload.length || previous.some((byte, i) => byte !== chunk.payload[i])))) {
      this.pendingTraces.delete(chunk.shotId);
      this.bus.emitAsync("log", `Discarded inconsistent trace transfer for shot ID ${chunk.shotId}.`);
      return;
    }
    pending.chunks.set(chunk.chunkIndex, chunk.payload);
    if (chunk.pointStride > 0) {
      pending.pointStride = chunk.pointStride;
    }

    if (pending.chunks.size === 1 || pending.chunks.size % 50 === 0) {
      this.bus.emitAsync("log", `Received trace chunk ${pending.chunks.size}/${pending.totalChunks} for shot ID ${chunk.shotId}.`);
    }

    let complete = pending.totalChunks > 0;
    for (let i = 0; i < pending.totalChunks; i++) {
      if (!pending.chunks.has(i)) {
        complete = false;
        break;
      }
    }

    if (complete) {
      pending.saving = true;
      this.bus.emitAsync("log", `All trace chunks received for shot ID ${chunk.shotId}. Reassembling...`);

      // 1. Flatten all chunks in order
      const bytesList = [];
      for (let i = 0; i < pending.totalChunks; i++) {
        const payload = pending.chunks.get(i);
        if (payload) {
          bytesList.push(...payload);
        }
      }

      const rawBytes = new Uint8Array(bytesList);
      // 3. Save to database
      try {
        const { trace, bytesPerPoint, sampleRateHz = 52, timing = null } = pending.timed
          ? decodeTimedFirmwareTrace(rawBytes) : decodeFirmwareTraceBytes(rawBytes, pending.pointStride);
        if ((!pending.timed && rawBytes.length % bytesPerPoint) || trace.length === 0 || trace.length > MAX_TRACE_POINTS) {
          throw new Error("Firmware trace contains incomplete points or exceeds the 1000-point buffer.");
        }
        // Metadata and chunks may arrive together. Wait for that exact shot's
        // pending commit, then use its connection-scoped local id. Never fall
        // back to an older capture that happened to reuse the device counter.
        await pendingSaves.get(chunk.shotId);
        if (epoch !== this.connectionEpoch || this.pendingTraces.get(chunk.shotId) !== pending) return;
        const localShotId = this.connectionShotIds.get(chunk.shotId);
        if (localShotId) {
          const tracePayload = buildShotTraceRecord({
            localShotId,
            sampleRateHz,
            payload: trace,
            source: timing === "device-ms" ? "firmware-timed" : "firmware",
          });

          const shotRecord = await saveShotTrace(tracePayload);
          if (!shotRecord) {
            this.bus.emitAsync("log", `Skipped firmware trace for ${localShotId.slice(0, 8)}: capture was deleted or already has a richer recording.`);
            return;
          }

          const micCount = trace.filter((point) => (point.micAmp || 0) > 0).length;
          this.bus.emitAsync(
            "log",
            `Trace for shot ID ${chunk.shotId} saved (${trace.length} samples` +
              `${micCount ? `, ${micCount} with mic` : ""}).`,
          );
          await this.notifySavedTrace(shotRecord.id, chunk.shotId);
          return shotRecord.id;
        } else {
          this.bus.emitAsync("log", `No saved capture for shot ID ${chunk.shotId} in this connection; skipped the firmware trace.`);
        }
      } catch (error) {
        console.error("Failed to save reassembled trace:", error);
        this.bus.emitAsync("log", `Firmware trace save failed for shot ID ${chunk.shotId}: ${error.message}`);
      } finally {
        if (this.pendingTraces.get(chunk.shotId) === pending) this.pendingTraces.delete(chunk.shotId);
      }
    }
  }
}
