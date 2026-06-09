// TelemetryStore ingests Samples from the bus, derives live metrics, tracks
// packet loss against the active transport's sequence step, and maintains a
// rolling trace buffer for the chart. It is the only thing that writes app
// state into the reactive store.

import { put, get, getAll, generateUUID } from "../core/db.js?v=shot-store-98";
import {
  buildShotTraceRecord,
  decodeFirmwareTraceBytes,
  extractMicWindow,
} from "../protocol/trace.js?v=shot-store-118";
import {
  computeFloatScoreFromTrace,
  computeLiveFloatScore,
  FLOAT_SCORE_VERSION,
} from "./score.js?v=shot-store-99";

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
  if (formScore == null) {
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
  if (holdStability < 65) {
    return {
      coachTitle: "Settle the hold",
      coachText: "Movement is building before the shot. Let the float shrink before you commit.",
    };
  }
  if (releaseQuality === null || followThrough === null) {
    return {
      coachTitle: "Steady hold practice",
      coachText: "Focus on maintaining bubble level consistency and reducing hand drift during the hold.",
    };
  }
  if (releaseQuality < 65) {
    return {
      coachTitle: "Soften the break",
      coachText: "Release motion is sharp. Keep pulling through instead of punching the shot.",
    };
  }
  if (followThrough < 65) {
    return {
      coachTitle: "Stay in the shot",
      coachText: "The bow is moving quickly after release. Hold posture through impact.",
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
    bus.on("status", ({ mode, text }) =>
      store.set({
        statusMode: mode,
        statusText: text,
        connected: mode === "live" || mode === "demo",
      }),
    );

    // Per-second frame rate.
    setInterval(() => {
      this.store.set({ hz: this.framesThisSecond });
      this.framesThisSecond = 0;
    }, 1000);
  }

  reset() {
    this.lastSeq = null;
    this.frameCount = 0;
    this.lost = 0;
    this.framesThisSecond = 0;
    this.orientationReady = false;
    this.filteredRoll = 0;
    this.filteredPitch = 0;
    this.filteredYaw = 0;
    this.trace.length = 0;
    this.shotTraceBuffer.length = 0;
    this.micRingBuffer.length = 0;
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
    this.connectionShotIds = new Set();

    this.isRecordingManual = false;
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
      sample: null,
      formScore: null,
      holdStability: null,
      releaseQuality: null,
      followThrough: null,
      levelConsistency: null,
      scoreVersion: FLOAT_SCORE_VERSION,
      lastShotSummary: null,
      manualRecordingActive: false,
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
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

    const tracePoint = {
      ax,
      ay,
      az,
      gx: sample.gxDps,
      gy: sample.gyDps,
      gz: sample.gzDps,
      roll,
      pitch,
      yaw,
      micAmp: sample.micAmp || 0
    };

    this.trace.push(tracePoint);
    if (this.trace.length > MAX_TRACE_POINTS) this.trace.shift();

    const configuredShotTraceRate = configuredBrowserShotTraceRateHz();
    if (configuredShotTraceRate !== this.shotTraceRateHz) {
      this.shotTraceRateHz = configuredShotTraceRate;
      this.shotTraceDtUs =
        this.shotTraceRateHz > 0 ? Math.round(1000000 / this.shotTraceRateHz) : 0;
      this.shotTraceCapacity = Math.max(
        1,
        Math.round(this.shotTraceRateHz * BROWSER_SHOT_TRACE_SECONDS),
      );
      this.shotTraceBuffer.length = 0;
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
      });
      this.lastShotTracePushUs = this.elapsedUs;
      if (this.shotTraceBuffer.length > this.shotTraceCapacity) {
        this.shotTraceBuffer.shift();
      }

      this.history30s.push({
        ...tracePoint,
        lost: this.lost
      });
      const historyCapacity = Math.max(1500, this.shotTraceRateHz * 30);
      if (this.history30s.length > historyCapacity) {
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
        ax,
        ay,
        az,
        gx: sample.gxDps,
        gy: sample.gyDps,
        gz: sample.gzDps,
        roll,
        pitch,
        yaw,
        micAmp: sample.micAmp || 0,
      });
      this.manualRecordingDurationUs += (sample.dtUs || 19230);
      this.store.set({
        manualRecordSamples: this.manualRecordingBuffer.length,
        manualRecordElapsedSec: Number((this.manualRecordingDurationUs / 1000000).toFixed(1))
      });
    }

    const gyroMag = Math.hypot(sample.gxDps, sample.gyDps, sample.gzDps);
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
      ...score,
      ...coaching,
    });
  }

  async onShot(shot) {
    const peakG = Math.hypot(shot.axMg, shot.ayMg, shot.azMg) / 1000;
    const shotTimeUs = this.elapsedUs;
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

      const activeState = this.store.get();
      const computedYaw = activeState.yaw || 0;
      const startLost = this.lost;
      const shotRecord = {
        id: localShotId,
        session_id: null,
        device_id: "OpenFloat-Sensor",
        device_shot_id: shot.shotId,
        stored_upload: !!shot.stored,
        timestamp: new Date().toISOString(),
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

      await put("shots", shotRecord);
      // Mark handled only after a successful save, so a failed write can still
      // be retried when the device re-sends the shot.
      if (shot.shotId != null) {
        this.connectionShotIds.add(shot.shotId);
      }
      await put("sync_queue", {
        table: "shots",
        action: "CREATE",
        targetId: localShotId,
        payload: shotRecord,
        status: "pending"
      });

      if (!shot.stored && browserTraceRateHz > 0) {
        this.scheduleBrowserShotTraceCapture(
          localShotId,
          shot.shotId,
          shotTimeUs,
          shot,
          followThroughMs,
          browserTraceRateHz,
          startLost,
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
        shotId: shot.shotId,
        stored: !!shot.stored,
        localShotId,
      });

      // 4. Trigger cloud sync manager if wired
      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }
    } catch (error) {
      console.error("Local storage / sync queuing failed for shot:", error);
      this.bus.emit("log", `Offline save error: ${error.message}`);
    }
  }

  resolveShotTimeUs(shot, fallbackUs = this.elapsedUs) {
    if (!shot || !this.shotTraceBuffer.length) return fallbackUs;

    const uptimeUs = Number(shot.uptimeUs);
    if (Number.isFinite(uptimeUs)) {
      let best = null;
      let bestDiff = Infinity;
      for (const point of this.shotTraceBuffer) {
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
      for (const point of this.shotTraceBuffer) {
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
      for (const point of this.shotTraceBuffer) {
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

  scheduleBrowserShotTraceCapture(localShotId, deviceShotId, shotTimeUs, shot, followThroughMs, sampleRateHz, startLost) {
    const delayMs = Math.max(0, followThroughMs + 100);

    setTimeout(() => {
      this.saveBrowserShotTrace(
        localShotId,
        deviceShotId,
        shotTimeUs,
        shot,
        sampleRateHz,
        followThroughMs,
        startLost,
      );
    }, delayMs);
  }

  buildMicSeriesForShot(shotTimeUs, followThroughMs = configuredFollowThroughMs()) {
    return extractMicWindow(
      this.micRingBuffer,
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
  ) {
    const resolvedShotTimeUs = this.resolveShotTimeUs(shot, shotTimeUs);
    const resolvedFreezeAtUs = resolvedShotTimeUs + followThroughMs * 1000;
    const startAtUs = resolvedShotTimeUs - BROWSER_SHOT_PRE_MS * 1000;
    const frozenWithTime = this.shotTraceBuffer
      .filter((point) => point.tUs >= startAtUs && point.tUs <= resolvedFreezeAtUs);
    const frozen = frozenWithTime.map(({ tUs, sequence, deviceUptimeUs, ...point }) => ({
      ...point,
      tUs: tUs - resolvedShotTimeUs,
    }));

    if (frozen.length === 0) {
      this.bus.emit("log", `No browser trace samples available for shot ID ${deviceShotId}.`);
      return;
    }

    let micSeries = this.buildMicSeriesForShot(resolvedShotTimeUs, followThroughMs);
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
      const shotRecord = await get("shots", localShotId);
      if (shotRecord) {
        const shotLoss = Math.max(0, this.lost - startLost);
        const updatedShot = {
          ...shotRecord,
          shot_score: traceScore.formScore,
          hold_stability: traceScore.holdStability,
          release_quality: traceScore.releaseQuality,
          follow_through: traceScore.followThrough,
          level_consistency: traceScore.levelConsistency,
          score_version: traceScore.scoreVersion,
          packet_loss_count: shotLoss,
        };
        await put("shots", updatedShot);
        await put("sync_queue", {
          table: "shots",
          action: "UPDATE",
          targetId: localShotId,
          payload: updatedShot,
          status: "pending",
        });
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
      await put("shot_traces", tracePayload);
      await put("sync_queue", {
        table: "shot_traces",
        action: "CREATE",
        targetId: localShotId,
        payload: tracePayload,
        status: "pending",
      });
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

    const hz = this.shotTraceRateHz > 0 ? this.shotTraceRateHz : 52;
    const durationSec = Math.round(this.history30s.length / hz);
    this.bus.emit("log", `Saving last ${durationSec}s of live telemetry (${this.history30s.length} samples at ${hz} Hz)...`);

    try {
      // 1. Compute metrics from the 30s buffer
      let maxG = 0;
      let sumStability = 0;
      
      const parsedTrace = this.history30s.map((pt, index) => {
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
          roll: pt.roll,
          pitch: pt.pitch,
          yaw: pt.yaw || 0,
          micAmp: pt.micAmp || 0,
          tUs: Math.round((index * 1000000) / hz),
        };
      });

      const avgStability = Number((sumStability / this.history30s.length).toFixed(1));
      const floatScore = computeFloatScoreFromTrace(parsedTrace, { sampleRateHz: hz, isManual: true });

      // 3. Save shot metadata (representing the manual capture)
      const startLost = this.history30s[0]?.lost ?? this.lost;
      const shotLoss = Math.max(0, this.lost - startLost);
      const manualShotId = generateUUID();
      const shotRecord = {
        id: manualShotId,
        session_id: null,
        device_id: "OpenFloat-Sensor",
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

      await put("shots", shotRecord);
      await put("sync_queue", {
        table: "shots",
        action: "CREATE",
        targetId: manualShotId,
        payload: shotRecord,
        status: "pending"
      });

      // 4. Save trace payload (the full history buffer)
      const tracePayload = buildShotTraceRecord({
        localShotId: manualShotId,
        sampleRateHz: hz,
        payload: parsedTrace,
        micSeries: parsedTrace.map((point) => ({
          tUs: point.tUs,
          micAmp: point.micAmp || 0,
        })),
        source: "browser-manual-30s",
      });

      await put("shot_traces", tracePayload);
      await put("sync_queue", {
        table: "shot_traces",
        action: "CREATE",
        targetId: manualShotId,
        payload: tracePayload,
        status: "pending"
      });

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
    this.isRecordingManual = true;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = label;
    this.manualRecordingStartLost = this.lost;
    
    this.store.set({
      manualRecordingActive: true,
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
    this.bus.emit("log", `Manual recording started: "${label || 'Untitled'}"`);
  }

  discardManualRecording() {
    this.isRecordingManual = false;
    this.manualRecordingBuffer = [];
    this.manualRecordingDurationUs = 0;
    this.manualRecordingLabel = "";
    
    this.store.set({
      manualRecordingActive: false,
      manualRecordSamples: 0,
      manualRecordElapsedSec: 0
    });
    this.bus.emit("log", "Manual recording discarded.");
  }

  async saveManualRecording() {
    if (this.manualRecordingBuffer.length === 0) {
      this.bus.emit("log", "No telemetry data recorded yet to save.");
      return null;
    }

    this.isRecordingManual = false;
    const durationSec = this.manualRecordingDurationUs / 1000000;
    const rawSampleRateHz = durationSec > 0 ? this.manualRecordingBuffer.length / durationSec : 52;
    const step = Math.max(1, Math.round(rawSampleRateHz / 52));
    const decimatedBuffer = this.manualRecordingBuffer.filter((_, idx) => idx % step === 0);
    const label = this.manualRecordingLabel.trim() || "Manual Recording";

    this.bus.emit("log", `Saving manual recording: "${label}" (${durationSec.toFixed(1)}s, raw ${this.manualRecordingBuffer.length} samples at ~${Math.round(rawSampleRateHz)}Hz, decimated to ${decimatedBuffer.length} samples at 52Hz)...`);

    try {
      // 1. Compute metrics
      let maxG = 0;
      let sumStability = 0;
      const parsedTrace = decimatedBuffer.map((pt, index) => {
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
          roll: pt.roll,
          pitch: pt.pitch,
          yaw: pt.yaw || 0,
          micAmp: pt.micAmp || 0,
          tUs: Math.round((index * 1000000) / 52),
        };
      });

      const avgStability = decimatedBuffer.length > 0
        ? Number((sumStability / decimatedBuffer.length).toFixed(1))
        : 100;
      const floatScore = computeFloatScoreFromTrace(parsedTrace, { sampleRateHz: 52, isManual: true });

      // 2. Save shot record
      const startLost = this.manualRecordingStartLost ?? this.lost;
      const shotLoss = Math.max(0, this.lost - startLost);
      const manualShotId = generateUUID();
      const shotRecord = {
        id: manualShotId,
        session_id: null,
        device_id: "OpenFloat-Sensor",
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
        packet_loss_count: shotLoss,
        label: label
      };

      await put("shots", shotRecord);
      await put("sync_queue", {
        table: "shots",
        action: "CREATE",
        targetId: manualShotId,
        payload: shotRecord,
        status: "pending"
      });

      // 4. Save trace record
      const tracePayload = buildShotTraceRecord({
        localShotId: manualShotId,
        sampleRateHz: 52,
        payload: parsedTrace,
        micSeries: parsedTrace.map((point) => ({
          tUs: point.tUs,
          micAmp: point.micAmp || 0,
        })),
        source: "browser-manual-recording",
      });

      await put("shot_traces", tracePayload);
      await put("sync_queue", {
        table: "shot_traces",
        action: "CREATE",
        targetId: manualShotId,
        payload: tracePayload,
        status: "pending"
      });

      this.bus.emit("log", `Manual recording saved successfully: "${label}" (ID: ${manualShotId.slice(0, 8)}).`);
      
      this.store.set({
        manualRecordingActive: false,
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

      this.bus.emit("shot-saved", {
        shotId: null,
        stored: false,
        localShotId: manualShotId,
      });

      this.manualRecordingBuffer = [];
      this.manualRecordingDurationUs = 0;
      this.manualRecordingLabel = "";

      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }

      return manualShotId;
    } catch (error) {
      console.error("Failed to save manual recording:", error);
      this.bus.emit("log", `Manual recording save failed: ${error.message}`);
      return null;
    }
  }

  getTrace() {
    return this.trace;
  }

  async onTraceChunk(chunk) {
    if (!this.pendingTraces.has(chunk.shotId)) {
      this.pendingTraces.set(chunk.shotId, {
        chunks: new Map(),
        totalChunks: chunk.totalChunks,
        pointStride: 0,
      });
    }

    const pending = this.pendingTraces.get(chunk.shotId);
    pending.chunks.set(chunk.chunkIndex, chunk.payload);
    if (chunk.pointStride > 0) {
      pending.pointStride = chunk.pointStride;
    }

    this.bus.emit("log", `Received trace chunk ${pending.chunks.size}/${pending.totalChunks} for shot ID ${chunk.shotId}.`);

    if (pending.chunks.size === pending.totalChunks) {
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
        const existingShots = await getAll("shots");
        // Attach to the most recently saved shot with this device_shot_id.
        // device_shot_id can repeat across a firmware shotreset/reflash, so
        // prefer the newest match rather than the first in key order.
        const shotRecord = existingShots
          .filter(
            (record) =>
              record.device_id === "OpenFloat-Sensor" &&
              record.device_shot_id === chunk.shotId,
          )
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

        if (shotRecord) {
          const tracePayload = buildShotTraceRecord({
            localShotId: shotRecord.id,
            sampleRateHz: 52,
            payload: trace,
            source: "firmware",
          });

          await put("shot_traces", tracePayload);
          await put("sync_queue", {
            table: "shot_traces",
            action: "CREATE",
            targetId: shotRecord.id,
            payload: tracePayload,
            status: "pending"
          });

          const micCount = trace.filter((point) => (point.micAmp || 0) > 0).length;
          this.bus.emit(
            "log",
            `Trace for shot ID ${chunk.shotId} saved (${trace.length} samples` +
              `${micCount ? `, ${micCount} with mic` : ""}).`,
          );
          this.bus.emit("shot-trace-saved", { localShotId: shotRecord.id, deviceShotId: chunk.shotId });

          // Trigger a UI redraw if this is the currently selected shot in review mode
          const activeState = this.store.get();
          if (activeState.reviewMode && activeState.reviewTrace && activeState.lastShotSummary && activeState.lastShotSummary.shotId === chunk.shotId) {
            this.store.set({
              reviewTrace: trace,
              reviewMicSeries: tracePayload.mic_series || null,
            });
          }
        } else {
          this.bus.emit("log", `Failed to associate trace: shot ID ${chunk.shotId} not found in DB.`);
        }
      } catch (error) {
        console.error("Failed to save reassembled trace:", error);
      } finally {
        this.pendingTraces.delete(chunk.shotId);
      }
    }
  }
}
