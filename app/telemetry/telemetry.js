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

  onShot(shot) {
    const peakG = Math.hypot(shot.axMg, shot.ayMg, shot.azMg) / 1000;
    this.bus.emit(
      "log",
      `Shot #${shot.shotCount} (id ${shot.shotId}) peak ~${peakG.toFixed(1)} g`,
    );
    this.store.set({ shotCount: shot.shotCount, lastShot: shot });
  }

  getTrace() {
    return this.trace;
  }
}
