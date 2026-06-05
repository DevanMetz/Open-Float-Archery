// TelemetryStore ingests Samples from the bus, derives live metrics, tracks
// packet loss against the active transport's sequence step, and maintains a
// rolling trace buffer for the chart. It is the only thing that writes app
// state into the reactive store.

import { put, getAll, generateUUID } from "../core/db.js?v=shot-store-57";

export const MAX_TRACE_POINTS = 1000;

const ACCEL_TILT_MIN_G = 0.7;
const ACCEL_TILT_MAX_G = 1.35;
const ORIENTATION_CORRECTION_TIME_S = 0.45;
const MAX_ORIENTATION_DT_S = 0.05;
const LIVE_SCORE_WINDOW = 120;
const BROWSER_SHOT_TRACE_RATES = [0, 208, 416, 832];
const BROWSER_SHOT_TRACE_SECONDS = 20;
const DEFAULT_FOLLOW_THROUGH_MS = 1500;
const MAX_FOLLOW_THROUGH_MS = 3000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function scoreFromMotion({ roll = 0, pitch = 0, gyroMag = 0, accelG = 1, trace = [] }) {
  const window = trace.slice(-LIVE_SCORE_WINDOW);
  const rollStd = stdDev(window.map((pt) => pt.roll || 0));
  const pitchStd = stdDev(window.map((pt) => pt.pitch || 0));
  const accelStd = stdDev(window.map((pt) => Math.hypot(pt.ax || 0, pt.ay || 0, pt.az || 0)));

  const holdStability = clamp(100 - (rollStd + pitchStd) * 18 - gyroMag * 0.7, 0, 100);
  const releaseQuality = clamp(100 - gyroMag * 1.5 - Math.abs(accelG - 1) * 10, 0, 100);
  const followThrough = clamp(100 - accelStd * 140 - Math.abs(pitch) * 1.2, 0, 100);
  const cantScore = clamp(100 - Math.abs(roll) * 7, 0, 100);
  const pitchScore = clamp(100 - Math.abs(pitch) * 3, 0, 100);
  const formScore = clamp(
    holdStability * 0.42 +
      releaseQuality * 0.24 +
      followThrough * 0.18 +
      cantScore * 0.12 +
      pitchScore * 0.04,
    0,
    100,
  );

  return {
    formScore: Math.round(formScore),
    holdStability: Math.round(holdStability),
    releaseQuality: Math.round(releaseQuality),
    followThrough: Math.round(followThrough),
  };
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

export class TelemetryStore {
  constructor(bus, store) {
    this.bus = bus;
    this.store = store;
    this.trace = [];
    this.shotTraceBuffer = [];
    this.history30s = []; // Rolling 30s telemetry buffer for manual captures
    this.pendingTraces = new Map();
    this.reset();

    bus.on("sample", (sample) => this.ingest(sample));
    bus.on("shot", (shot) => this.onShot(shot));
    bus.on("trace-chunk", (chunk) => this.onTraceChunk(chunk));
    // Device-reported lifetime count (e.g. restored from NVS on connect).
    // Updates the displayed counter only; not logged as a new shot.
    bus.on("shotcount", (count) => this.store.set({ shotCount: count }));
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
    this.currentSessionId = localStorage.getItem("openfloat_active_session_id") || null;
    
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
      yaw
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
      this.shotTraceBuffer.push({ ...tracePoint, tUs: this.elapsedUs });
      this.lastShotTracePushUs = this.elapsedUs;
      if (this.shotTraceBuffer.length > this.shotTraceCapacity) {
        this.shotTraceBuffer.shift();
      }
    }

    // Push full samples to rolling history buffer (30 seconds * ~52 Hz = ~1560 samples)
    this.history30s.push(tracePoint);
    if (this.history30s.length > 1600) this.history30s.shift();

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
        yaw
      });
      this.manualRecordingDurationUs += (sample.dtUs || 19230);
      this.store.set({
        manualRecordSamples: this.manualRecordingBuffer.length,
        manualRecordElapsedSec: Number((this.manualRecordingDurationUs / 1000000).toFixed(1))
      });
    }

    const gyroMag = Math.hypot(sample.gxDps, sample.gyDps, sample.gzDps);
    const score = scoreFromMotion({ roll, pitch, gyroMag, accelG, trace: this.trace });
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
      // 1. Ensure an active session exists
      if (!this.currentSessionId) {
        this.currentSessionId = generateUUID();
        const sessionRecord = {
          id: this.currentSessionId,
          started_at: new Date(Date.now() - 10000).toISOString(), // Roughly started 10s ago
          location_label: "Quick Practice",
          bow_profile_id: localStorage.getItem("openfloat_active_bow_id") || null
        };
        await put("sessions", sessionRecord);
        await put("sync_queue", {
          table: "sessions",
          action: "CREATE",
          targetId: this.currentSessionId,
          payload: sessionRecord,
          status: "pending"
        });
        this.bus.emit("log", `Created new training session: ${this.currentSessionId.slice(0, 8)}...`);
      }

      // 2. Check for duplicate shot in this session
      if (shot.shotId != null) {
        const existingShots = await getAll("shots");
        const existingShot = existingShots.find(
          (record) =>
            record.device_id === "OpenFloat-Sensor" &&
            record.device_shot_id === shot.shotId &&
            record.session_id === this.currentSessionId,
        );

        if (existingShot) {
          this.bus.emit(
            "log",
            `Shot #${shot.shotCount} (id ${shot.shotId}) already saved in this session; acknowledging duplicate upload.`,
          );
          this.store.set({
            shotCount: shot.shotCount,
            lastShotSummary: {
              timestamp: existingShot.timestamp,
              score: existingShot.shot_score,
              peakG: existingShot.peak_g,
              cant: existingShot.cant_angle_deg,
              pitch: existingShot.pitch_angle_deg,
              yaw: existingShot.yaw_angle_deg || 0,
            },
          });
          this.bus.emit("shot-saved", {
            shotId: shot.shotId,
            stored: !!shot.stored,
            localShotId: existingShot.id,
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

      const activeState = this.store.get();
      const computedYaw = activeState.yaw || 0;
      const shotRecord = {
        id: localShotId,
        session_id: this.currentSessionId,
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
        packet_loss_count: this.lost
      };

      await put("shots", shotRecord);
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
          followThroughMs,
          browserTraceRateHz,
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

  scheduleBrowserShotTraceCapture(localShotId, deviceShotId, shotTimeUs, followThroughMs, sampleRateHz) {
    const freezeAtUs = shotTimeUs + followThroughMs * 1000;
    const delayMs = Math.max(0, followThroughMs + 100);

    setTimeout(() => {
      this.saveBrowserShotTrace(localShotId, deviceShotId, freezeAtUs, sampleRateHz);
    }, delayMs);
  }

  async saveBrowserShotTrace(localShotId, deviceShotId, freezeAtUs, sampleRateHz) {
    const frozen = this.shotTraceBuffer
      .filter((point) => point.tUs <= freezeAtUs)
      .slice(-Math.max(1, Math.round(sampleRateHz * BROWSER_SHOT_TRACE_SECONDS)))
      .map(({ tUs, ...point }) => ({ ...point }));

    if (frozen.length === 0) {
      this.bus.emit("log", `No browser trace samples available for shot ID ${deviceShotId}.`);
      return;
    }

    const tracePayload = {
      shot_id: localShotId,
      sample_rate_hz: sampleRateHz,
      payload: frozen,
    };

    try {
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
        `Browser trace saved for shot ID ${deviceShotId} (${frozen.length} samples, ${sampleRateHz} Hz).`,
      );
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

    const durationSec = Math.round(this.history30s.length / 52);
    this.bus.emit("log", `Saving last ${durationSec}s of live telemetry (${this.history30s.length} samples)...`);

    try {
      // 1. Ensure an active session exists
      if (!this.currentSessionId) {
        this.currentSessionId = generateUUID();
        const sessionRecord = {
          id: this.currentSessionId,
          started_at: new Date(Date.now() - durationSec * 1000).toISOString(),
          location_label: "Quick Practice (Manual)",
          bow_profile_id: localStorage.getItem("openfloat_active_bow_id") || null
        };
        await put("sessions", sessionRecord);
        await put("sync_queue", {
          table: "sessions",
          action: "CREATE",
          targetId: this.currentSessionId,
          payload: sessionRecord,
          status: "pending"
        });
        this.bus.emit("log", `Created new manual session: ${this.currentSessionId.slice(0, 8)}...`);
      }

      // 2. Compute metrics from the 30s buffer
      let maxG = 0;
      let sumStability = 0;
      
      const parsedTrace = this.history30s.map(pt => {
        const g = Math.hypot(pt.ax, pt.ay, pt.az);
        if (g > maxG) maxG = g;
        
        const gyroMag = Math.hypot(pt.gx || 0, pt.gy || 0, pt.gz || 0);
        const stability = 100 - Math.min(100, gyroMag);
        sumStability += stability;

        return {
          ax: pt.ax,
          ay: pt.ay,
          az: pt.az,
          roll: pt.roll,
          pitch: pt.pitch,
          yaw: pt.yaw || 0,
        };
      });

      const avgStability = Number((sumStability / this.history30s.length).toFixed(1));

      // 3. Save shot metadata (representing the manual capture)
      const manualShotId = generateUUID();
      const shotRecord = {
        id: manualShotId,
        session_id: this.currentSessionId,
        device_id: "OpenFloat-Sensor",
        timestamp: new Date().toISOString(),
        peak_g: Number(maxG.toFixed(2)),
        cant_angle_deg: 0,
        pitch_angle_deg: 0,
        yaw_angle_deg: 0,
        roll_angle_deg: 0,
        stability_score: avgStability,
        shot_score: this.store.get().formScore || avgStability,
        hold_stability: avgStability,
        release_quality: 100,
        follow_through: 100,
        packet_loss_count: this.lost
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
      const tracePayload = {
        shot_id: manualShotId,
        sample_rate_hz: 52,
        payload: parsedTrace
      };

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
    const sampleRateHz = durationSec > 0 ? Math.round(this.manualRecordingBuffer.length / durationSec) : 52;
    const label = this.manualRecordingLabel.trim() || "Manual Recording";

    this.bus.emit("log", `Saving manual recording: "${label}" (${durationSec.toFixed(1)}s, ${this.manualRecordingBuffer.length} samples at ~${sampleRateHz}Hz)...`);

    try {
      // 1. Ensure an active session exists
      if (!this.currentSessionId) {
        this.currentSessionId = generateUUID();
        const sessionRecord = {
          id: this.currentSessionId,
          started_at: new Date(Date.now() - durationSec * 1000).toISOString(),
          location_label: "Quick Practice (Manual)",
          bow_profile_id: localStorage.getItem("openfloat_active_bow_id") || null
        };
        await put("sessions", sessionRecord);
        await put("sync_queue", {
          table: "sessions",
          action: "CREATE",
          targetId: this.currentSessionId,
          payload: sessionRecord,
          status: "pending"
        });
        this.bus.emit("log", `Created new session: ${this.currentSessionId.slice(0, 8)}...`);
      }

      // 2. Compute metrics
      let maxG = 0;
      let sumStability = 0;
      const parsedTrace = this.manualRecordingBuffer.map(pt => {
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
          yaw: pt.yaw || 0
        };
      });

      const avgStability = this.manualRecordingBuffer.length > 0
        ? Number((sumStability / this.manualRecordingBuffer.length).toFixed(1))
        : 100;

      // 3. Save shot record
      const manualShotId = generateUUID();
      const shotRecord = {
        id: manualShotId,
        session_id: this.currentSessionId,
        device_id: "OpenFloat-Sensor",
        timestamp: new Date().toISOString(),
        peak_g: Number(maxG.toFixed(2)),
        cant_angle_deg: 0,
        pitch_angle_deg: 0,
        yaw_angle_deg: 0,
        roll_angle_deg: 0,
        stability_score: avgStability,
        shot_score: avgStability,
        hold_stability: avgStability,
        release_quality: 100,
        follow_through: 100,
        packet_loss_count: this.lost,
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
      const tracePayload = {
        shot_id: manualShotId,
        sample_rate_hz: sampleRateHz,
        payload: parsedTrace
      };

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
        totalChunks: chunk.totalChunks
      });
    }

    const pending = this.pendingTraces.get(chunk.shotId);
    pending.chunks.set(chunk.chunkIndex, chunk.payload);

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

      // 2. Decode trace points. New firmware sends roll/pitch/yaw as 6-byte
      // records; old firmware sent roll/pitch as 4-byte records.
      const trace = [];
      const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
      const bytesPerPoint = rawBytes.byteLength % 6 === 0 ? 6 : 4;
      const numPoints = Math.floor(rawBytes.byteLength / bytesPerPoint);

      for (let i = 0; i < numPoints; i++) {
        const offset = i * bytesPerPoint;
        const roll = view.getInt16(offset, true) / 100;
        const pitch = view.getInt16(offset + 2, true) / 100;
        const yaw = bytesPerPoint >= 6 ? view.getInt16(offset + 4, true) / 100 : 0;
        
        // Mock ax, ay, az for target centering logic (recoil spike at the end)
        const isLast = (i === numPoints - 1);
        const ax = 0;
        const ay = 0;
        const az = isLast ? 5.0 : 1.0;
        
        trace.push({ ax, ay, az, roll, pitch, yaw });
      }

      // 3. Save to database
      try {
        const existingShots = await getAll("shots");
        const shotRecord = existingShots.find(
          (record) =>
            record.device_id === "OpenFloat-Sensor" &&
            record.device_shot_id === chunk.shotId
        );

        if (shotRecord) {
          const tracePayload = {
            shot_id: shotRecord.id,
            sample_rate_hz: 52, // Decimated offline rate
            payload: trace
          };

          await put("shot_traces", tracePayload);
          await put("sync_queue", {
            table: "shot_traces",
            action: "CREATE",
            targetId: shotRecord.id,
            payload: tracePayload,
            status: "pending"
          });

          this.bus.emit("log", `Trace for shot ID ${chunk.shotId} successfully reassembled and saved.`);

          // Trigger a UI redraw if this is the currently selected shot in review mode
          const activeState = this.store.get();
          if (activeState.reviewMode && activeState.reviewTrace && activeState.lastShotSummary && activeState.lastShotSummary.shotId === chunk.shotId) {
            this.store.set({ reviewTrace: trace });
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
