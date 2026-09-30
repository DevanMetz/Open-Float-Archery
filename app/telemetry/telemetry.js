// TelemetryStore ingests Samples from the bus, derives live metrics, tracks
// packet loss against the active transport's sequence step, and maintains a
// rolling trace buffer for the chart. It is the only thing that writes app
// state into the reactive store.

import { getAll, saveCapture, saveShotTrace, generateUUID } from "../core/db.js?v=shot-store-147";
import {
  buildShotTraceRecord,
  decodeFirmwareTraceBytes,
  extractMicWindow,
  prepareTimedTrace,
} from "../protocol/trace.js?v=shot-store-144";
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
    // Device-reported lifetime count (e.g. restored from NVS on connect).
    // Updates the displayed counter only; not logged as a new shot.
    bus.on("shotcount", (count) => this.store.set({ shotCount: count }));
    // Device-reported backlog of shots saved before connecting, uploaded on
    // reconnect. Drives the inline "Uploading" status indicator.
    bus.on("upload-status", ({ pending }) =>
      this.store.set({ uploadPending: Math.max(0, pending | 0) }),
    );
    bus.on("status", ({ mode, text }) => {
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
    if (this.store.get().manualRecordingActive) return false;
    this.connectionEpoch = (this.connectionEpoch || 0) + 1;
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
    // shotdump, or a lost ack). Scoped per-connection because the device's
    // shot_id restarts at 0 after a firmware `shotreset`/reflash, which would
    // otherwise collide with older shots in IndexedDB and wrongly drop new ones.
    // Keep the exact local id even if the record is deleted before its trace.
    this.connectionShotIds = new Map();
    this.pendingShotSaves = new Map();

    this.isRecordingManual = false;
    this.isSavingManual = false;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";

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

  // Newest shot record with this device_shot_id saved within the dedup
  // window, or null. The 24 h window bounds how long a re-uploaded shot is
  // treated as a duplicate, so a same-id shot after a firmware reset on a
  // later day is still saved as new.
  async findRecentShotByDeviceId(deviceShotId) {
    const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
    try {
      const shots = await getAll("shots");
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      let newest = null;
      for (const record of shots) {
        if (record.device_id !== "OpenFloat-Sensor") continue;
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
    const startLost = this.lost;
    const captureContext = { epoch: this.connectionEpoch, motion: this.shotTraceBuffer, mic: this.micRingBuffer };
    const followThroughMs = configuredFollowThroughMs();
    const browserTraceRateHz = configuredBrowserShotTraceRateHz();
    this.store.set({ shotCount: shot.shotCount, lastShot: shot });

    try {
      // 1. Skip a shot the device re-uploaded within this connection (watchdog
      //    re-send of shotdump, or a lost ack). Still re-emit shot-saved so the
      //    device gets acknowledged again and frees the stored slot.
      if (shot.shotId != null && this.connectionShotIds.has(shot.shotId)) {
        this.bus.emit(
          "log",
          `Shot id ${shot.shotId} already handled this connection; re-acknowledging.`,
        );
        this.bus.emit("shot-saved", {
          shotId: shot.shotId,
          stored: !!shot.stored,
          duplicate: true,
        });
        return;
      }

      // 1b. Cross-connection dedup for stored re-uploads. If the live frame
      //     was saved but the ack never reached the device (or the link
      //     dropped first), the device re-uploads the shot on the next
      //     connection, where connectionShotIds is empty. Match on
      //     device_shot_id against recently saved shots only: shot_id restarts
      //     after a firmware shotreset/reflash, so old records with the same
      //     id must not swallow genuinely new shots.
      if (shot.stored && shot.shotId != null) {
        const recentMatch = await this.findRecentShotByDeviceId(shot.shotId);
        if (recentMatch) {
          this.bus.emit(
            "log",
            `Stored shot id ${shot.shotId} already saved at ${recentMatch.timestamp}; re-acknowledging.`,
          );
          if (captureContext.epoch !== this.connectionEpoch) return recentMatch.id;
          this.connectionShotIds.set(shot.shotId, recentMatch.id);
          this.bus.emit("shot-saved", {
            shotId: shot.shotId,
            stored: true,
            duplicate: true,
          });
          return;
        }
      }

      this.bus.emit(
        "log",
        `Shot #${shot.shotCount} (id ${shot.shotId}) peak ~${peakG.toFixed(1)} g`,
      );

      // 2. Save Shot Metadata
      const localShotId = generateUUID();
      const ax = (shot.axMg || 0) / 1000;
      const ay = (shot.ayMg || 0) / 1000;
      const az = (shot.azMg || 1000) / 1000;
      const computedRoll = Math.atan2(ay, az) * (180 / Math.PI);
      const computedPitch = Math.atan2(-ax, Math.hypot(ay, az)) * (180 / Math.PI);

      const computedYaw = activeState.yaw || 0;
      const shotRecord = {
        id: localShotId,
        session_id: null,
        device_id: "OpenFloat-Sensor",
        capture_kind: "arrow",
        device_shot_id: shot.shotId,
        stored_upload: !!shot.stored,
        timestamp: capturedAt,
        peak_g: peakG,
        cant_angle_deg: Number((shot.rollDeg !== undefined ? shot.rollDeg : computedRoll).toFixed(1)),
        pitch_angle_deg: Number((shot.pitchDeg !== undefined ? shot.pitchDeg : computedPitch).toFixed(1)),
        yaw_angle_deg: Number((shot.yawDeg !== undefined ? shot.yawDeg : computedYaw).toFixed(1)),
        roll_angle_deg: Number((shot.rollDeg !== undefined ? shot.rollDeg : computedRoll).toFixed(1)),
        stability_score: Number((100 - Math.min(100, Math.hypot(shot.gxDps || 0, shot.gyDps || 0, shot.gzDps || 0))).toFixed(1)),
        shot_score: activeState.formScore || 0,
        hold_stability: activeState.holdStability != null ? activeState.holdStability : null,
        release_quality: activeState.releaseQuality != null ? activeState.releaseQuality : null,
        follow_through: activeState.followThrough != null ? activeState.followThrough : null,
        level_consistency: activeState.levelConsistency != null ? activeState.levelConsistency : null,
        score_version: activeState.scoreVersion || FLOAT_SCORE_VERSION,
        packet_loss_count: 0
      };

      await saveCapture(shotRecord);
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

      this.bus.emit(
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
      this.bus.emit("shot-saved", {
        shotId: sameConnection ? shot.shotId : null,
        stored: !!shot.stored,
        localShotId,
      });

      // 4. Trigger cloud sync manager if wired
      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }
      return localShotId;
    } catch (error) {
      console.error("Local storage / sync queuing failed for shot:", error);
      this.bus.emit("log", `Offline save error: ${error.message}`);
    }
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
      this.bus.emit("log", `No browser trace samples available for shot ID ${deviceShotId}.`);
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

    try {
      const releaseIndex = frozenWithTime.findIndex((point) => point.tUs >= resolvedShotTimeUs);
      const traceScore = computeFloatScoreFromTrace(frozen, {
        sampleRateHz,
        releaseIndex: releaseIndex >= 0 ? releaseIndex : undefined,
      });
      const endLost = frozenWithTime.at(-1)?.lost ?? startLost;
      const updatedShot = await saveShotTrace(tracePayload, {
        shot_score: traceScore.formScore,
        hold_stability: traceScore.holdStability,
        release_quality: traceScore.releaseQuality,
        follow_through: traceScore.followThrough,
        level_consistency: traceScore.levelConsistency,
        score_version: traceScore.scoreVersion,
        packet_loss_count: Math.max(0, endLost - startLost),
      });
      if (!updatedShot) {
        this.bus.emit("log", `Capture ${localShotId.slice(0, 8)} was deleted; skipped its delayed trace.`);
        return null;
      }
      const active = this.store.get();
      if (captureContext.epoch === this.connectionEpoch &&
          (active.reviewMode ? active.reviewShotId === localShotId : active.lastShot?.shotId === deviceShotId)) {
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
      this.bus.emit(
        "log",
        `Browser trace saved for shot ID ${deviceShotId} (${frozen.length} motion samples, ${(BROWSER_SHOT_PRE_MS / 1000).toFixed(1)} s pre + ${(followThroughMs / 1000).toFixed(1)} s follow @ ${sampleRateHz} Hz` +
          `${micSeries.length ? `, ${micSeries.length} mic samples` : ""}).`,
      );
      this.bus.emit("shot-trace-saved", { localShotId, deviceShotId });
      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }
    } catch (error) {
      console.error("Delayed browser trace save failed:", error);
      this.bus.emit("log", `Browser trace save error: ${error.message}`);
    }
  }

  async saveManual30sCapture() {
    if (this.history30s.length === 0) {
      this.bus.emit("log", "No telemetry data recorded yet to save.");
      return;
    }

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
        device_id: isDemo ? "OpenFloat-Demo" : "OpenFloat-Sensor",
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
    this.bus.emit("log", `Manual recording started: "${label || 'Untitled'}"`);
    return true;
  }

  discardManualRecording() {
    if (this.isSavingManual) return false;
    this.isRecordingManual = false;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";
    
    this.store.set({
      manualRecordingActive: false,
      manualRecordingPaused: false,
      manualRecordMessage: "Recording discarded.",
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
    this.bus.emit("log", "Manual recording discarded.");
    return true;
  }

  async saveManualRecording() {
    if (this.isSavingManual) return null;
    if (this.manualRecordingBuffer.length === 0) {
      this.bus.emit("log", "No telemetry data recorded yet to save.");
      this.store.set({ manualRecordMessage: "No samples to save yet. Wait for telemetry or discard this recording." });
      return null;
    }

    this.isRecordingManual = false;
    this.isSavingManual = true;
    this.manualRecordingEndLost ??= this.lost;
    this.manualRecordingStoppedAt ??= new Date().toISOString();
    this.store.set({ manualRecordingPaused: true, manualRecordingSaving: true, manualRecordMessage: "Saving recording..." });
    const isDemo = this.manualRecordingBuffer.some((point) => point.sample);
    const durationSec = this.manualRecordingDurationUs / 1000000;
    const rawSampleRateHz = durationSec > 0 ? this.manualRecordingBuffer.length / durationSec : 52;
    const { payload: decimatedBuffer, sampleRateHz } = prepareTimedTrace(this.manualRecordingBuffer, 52, rawSampleRateHz);
    const label = this.manualRecordingLabel.trim() || "Manual Recording";

    this.bus.emit("log", `Saving manual recording: "${label}" (${durationSec.toFixed(1)}s, ${decimatedBuffer.length} replay points at about ${sampleRateHz} Hz)...`);

    let manualShotId;
    let shotRecord;
    try {
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
        device_id: isDemo ? "OpenFloat-Demo" : "OpenFloat-Sensor",
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
      this.bus.emit("log", `Manual recording save failed: ${error.message}`);
      this.store.set({ manualRecordMessage: "Could not save. Your recording is still in this tab; press Save to retry." });
      return null;
    } finally {
      this.isSavingManual = false;
      this.store.set({ manualRecordingSaving: false });
    }

    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";
    this.store.set({
      manualRecordingActive: false,
      manualRecordingPaused: false,
      manualRecordMessage: "Recording saved.",
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

    this.bus.emit("log", `Manual recording saved successfully: "${label}" (ID: ${manualShotId.slice(0, 8)}).`);
    this.bus.emit("shot-saved", {
      shotId: null,
      stored: false,
      localShotId: manualShotId,
    });

    if (this.syncAdapter) {
      this.syncAdapter.triggerSync();
    }
    return manualShotId;
  }

  getTrace() {
    return this.trace;
  }

  async onTraceChunk(chunk) {
    if (!Number.isInteger(chunk.totalChunks) || chunk.totalChunks <= 0 ||
        !Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunk.totalChunks) {
      this.bus.emit("log", `Ignoring invalid trace chunk ${chunk.chunkIndex}/${chunk.totalChunks} for shot ID ${chunk.shotId}.`);
      return;
    }
    const epoch = this.connectionEpoch;
    const pendingSaves = this.pendingShotSaves;
    if (!this.pendingTraces.has(chunk.shotId)) {
      this.pendingTraces.set(chunk.shotId, { chunks: new Map(), totalChunks: chunk.totalChunks, pointStride: 0 });
    }
    const pending = this.pendingTraces.get(chunk.shotId);
    pending.totalChunks = chunk.totalChunks;
    pending.chunks.set(chunk.chunkIndex, chunk.payload);
    if (chunk.pointStride > 0) {
      pending.pointStride = chunk.pointStride;
    }

    this.bus.emit("log", `Received trace chunk ${pending.chunks.size}/${pending.totalChunks} for shot ID ${chunk.shotId}.`);

    let complete = pending.totalChunks > 0;
    for (let i = 0; i < pending.totalChunks; i++) {
      if (!pending.chunks.has(i)) {
        complete = false;
        break;
      }
    }

    if (complete) {
      this.bus.emit("log", `All trace chunks received for shot ID ${chunk.shotId}. Reassembling...`);

      // 1. Flatten all chunks in order
      const bytesList = [];
      for (let i = 0; i < pending.totalChunks; i++) {
        const payload = pending.chunks.get(i);
        if (payload) {
          bytesList.push(...payload);
        }
      }

      const rawBytes = new Uint8Array(bytesList);
      const { trace } = decodeFirmwareTraceBytes(rawBytes, pending.pointStride);

      // 3. Save to database
      try {
        // Metadata and chunks may arrive together. Wait for that exact shot's
        // pending commit, then use its connection-scoped local id. Never fall
        // back to an older capture that happened to reuse the device counter.
        await pendingSaves.get(chunk.shotId);
        if (epoch !== this.connectionEpoch) return;
        const localShotId = this.connectionShotIds.get(chunk.shotId);
        if (localShotId) {
          const tracePayload = buildShotTraceRecord({
            localShotId,
            sampleRateHz: 52,
            payload: trace,
            source: "firmware",
          });

          const shotRecord = await saveShotTrace(tracePayload);
          if (!shotRecord) {
            this.bus.emit("log", `Capture ${localShotId.slice(0, 8)} was deleted; skipped its firmware trace.`);
            return;
          }

          const micCount = trace.filter((point) => (point.micAmp || 0) > 0).length;
          this.bus.emit(
            "log",
            `Trace for shot ID ${chunk.shotId} saved (${trace.length} samples` +
              `${micCount ? `, ${micCount} with mic` : ""}).`,
          );
          this.bus.emit("shot-trace-saved", { localShotId: shotRecord.id, deviceShotId: chunk.shotId });

          // Trigger a UI redraw if this is the currently selected shot in review mode
          const activeState = this.store.get();
          if (activeState.reviewMode && activeState.reviewShotId === shotRecord.id) {
            this.store.set({
              reviewTrace: trace,
              reviewMicSeries: tracePayload.mic_series || null,
            });
          }
        } else {
          this.bus.emit("log", `No saved capture for shot ID ${chunk.shotId} in this connection; skipped the firmware trace.`);
        }
      } catch (error) {
        console.error("Failed to save reassembled trace:", error);
      } finally {
        if (this.pendingTraces.get(chunk.shotId) === pending) this.pendingTraces.delete(chunk.shotId);
      }
    }
  }
}
