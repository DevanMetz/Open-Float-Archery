// TelemetryStore ingests Samples from the bus, derives live metrics, tracks
// packet loss against the active transport's sequence step, and maintains a
// rolling trace buffer for the chart. It is the only thing that writes app
// state into the reactive store.

export const MAX_TRACE_POINTS = 480;

export class TelemetryStore {
  constructor(bus, store) {
    this.bus = bus;
    this.store = store;
    this.trace = [];
    this.history30s = []; // Rolling 30s telemetry buffer for manual captures
    this.reset();

    bus.on("sample", (sample) => this.ingest(sample));
    bus.on("shot", (shot) => this.onShot(shot));
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
    this.trace.length = 0;
    this.history30s.length = 0; // Reset history buffer
    this.currentSessionId = null; // Reset session on reconnect
    this.store.set({ frameCount: 0, lost: 0, hz: 0, shotCount: 0, sample: null });
  }

  ingest(sample) {
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

    this.trace.push({
      ax: sample.axMg / 1000,
      ay: sample.ayMg / 1000,
      az: sample.azMg / 1000,
    });
    if (this.trace.length > MAX_TRACE_POINTS) this.trace.shift();

    // Push full samples to rolling history buffer (30 seconds * ~52 Hz = ~1560 samples)
    this.history30s.push({
      ax: sample.axMg / 1000,
      ay: sample.ayMg / 1000,
      az: sample.azMg / 1000,
      gx: sample.gxDps,
      gy: sample.gyDps,
      gz: sample.gzDps
    });
    if (this.history30s.length > 1600) this.history30s.shift();

    const accelG = Math.hypot(sample.axMg, sample.ayMg, sample.azMg) / 1000;
    const gyroMag = Math.hypot(sample.gxDps, sample.gyDps, sample.gzDps);

    this.store.set({
      sample,
      frameCount: this.frameCount,
      lost: this.lost,
      accelG,
      gyroMag,
      shotCount:
        sample.shotCount != null ? sample.shotCount : this.store.get().shotCount,
    });
  }

  async onShot(shot) {
    const peakG = Math.hypot(shot.axMg, shot.ayMg, shot.azMg) / 1000;
    this.bus.emit(
      "log",
      `Shot #${shot.shotCount} (id ${shot.shotId}) peak ~${peakG.toFixed(1)} g`,
    );
    this.store.set({ shotCount: shot.shotCount, lastShot: shot });

    try {
      const { put, generateUUID } = await import("../core/db.js");

      // 1. Ensure an active session exists
      if (!this.currentSessionId) {
        this.currentSessionId = generateUUID();
        const sessionRecord = {
          id: this.currentSessionId,
          started_at: new Date(Date.now() - 10000).toISOString(), // Roughly started 10s ago
          location_label: "Local Range Session"
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

      // 2. Save Shot Metadata
      const localShotId = generateUUID();
      const shotRecord = {
        id: localShotId,
        session_id: this.currentSessionId,
        device_id: "OpenFloat-Sensor",
        timestamp: new Date().toISOString(),
        peak_g: peakG,
        cant_angle_deg: shot.rollDeg || 0,
        pitch_angle_deg: shot.pitchDeg || 0,
        roll_angle_deg: shot.rollDeg || 0,
        stability_score: Number((100 - Math.min(100, Math.hypot(shot.gxDps || 0, shot.gyDps || 0, shot.gzDps || 0))).toFixed(1)),
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

      // 3. Save Shot Trace
      // Capture up to 200 decimated samples from the rolling motion trace preceding the release
      const tracePayload = {
        shot_id: localShotId,
        sample_rate_hz: 52,
        payload: JSON.parse(JSON.stringify(this.trace.slice(-200)))
      };

      await put("shot_traces", tracePayload);
      await put("sync_queue", {
        table: "shot_traces",
        action: "CREATE",
        targetId: localShotId,
        payload: tracePayload,
        status: "pending"
      });

      this.bus.emit("log", `Shot saved to local IndexedDB & queued for sync.`);

      // 4. Trigger cloud sync manager if wired
      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }
    } catch (error) {
      console.error("Local storage / sync queuing failed for shot:", error);
      this.bus.emit("log", `Offline save error: ${error.message}`);
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
      const { put, generateUUID } = await import("../core/db.js");

      // 1. Ensure an active session exists
      if (!this.currentSessionId) {
        this.currentSessionId = generateUUID();
        const sessionRecord = {
          id: this.currentSessionId,
          started_at: new Date(Date.now() - durationSec * 1000).toISOString(),
          location_label: "Manual Capture Session"
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
          az: pt.az
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
        roll_angle_deg: 0,
        stability_score: avgStability,
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

      if (this.syncAdapter) {
        this.syncAdapter.triggerSync();
      }
    } catch (error) {
      console.error("Failed to save manual capture:", error);
      this.bus.emit("log", `Manual capture failed: ${error.message}`);
    }
  }

  getTrace() {
    return this.trace;
  }
}
