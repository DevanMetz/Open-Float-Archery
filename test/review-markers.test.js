import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../app/core/store.js";
import { mountReviewMarkers } from "../app/ui/dashboard.js";

function fixture() {
  const store = createStore({
    reviewMode: true, reviewShotId: "first", chartView: "trace", reviewSampleRateHz: 2,
    reviewTrace: [0, 500000, 1000000].map((tUs) => ({ tUs })),
    reviewReleaseIdx: 0, reviewReleaseTimeMs: 0, reviewHitIdx: 2, reviewHitTimeMs: 1000,
    reviewRangeEst: "Previous estimate",
    reviewRangeSpeed: { fps: 280, source: "assigned" },
  });
  const handlers = new Map();
  const rect = { width: 100, height: 100, left: 10, top: 20 };
  const canvas = {
    style: {}, getBoundingClientRect: () => rect,
    addEventListener: (type, action) => handlers.set(type, action),
  };
  mountReviewMarkers({ store, canvas });
  return {
    store, rect,
    mouse: (type, x = 0, y = 90) => handlers.get(type)({ offsetX: x, offsetY: y }),
    touch: (type, x = 0, y = 90) => handlers.get(type)?.({
      touches: [{ clientX: x + rect.left, clientY: y + rect.top }], preventDefault() {},
    }),
  };
}

test("review markers and their range follow mouse movement immediately using the review bow speed", () => {
  const f = fixture();
  f.mouse("mousedown");
  f.mouse("mousemove", 30);
  assert.equal(f.store.get().reviewReleaseTimeMs, 300);
  assert.equal(f.store.get().reviewReleaseIdx, 0, "Marker remains between recorded samples");
  assert.match(f.store.get().reviewRangeEst, /@ 280 fps/);
});

test("each drag calculates the latest estimate without reading an unrelated bow profile", () => {
  const f = fixture();
  f.store.set({ reviewRangeSpeed: { fps: 300, source: "assigned" } });
  f.mouse("mousedown");
  f.mouse("mousemove", 20);
  f.mouse("mousemove", 40);
  f.mouse("mouseup");
  const expectedRange = f.store.get().reviewRangeEst;
  assert.equal(f.store.get().reviewReleaseTimeMs, 400);
  assert.match(expectedRange, /@ 300 fps/);
  f.mouse("mousemove", 80);
  assert.equal(f.store.get().reviewReleaseTimeMs, 400);
  assert.equal(f.store.get().reviewRangeEst, expectedRange);
});

test("an old gesture cannot move a newly selected capture", () => {
  const f = fixture();
  f.mouse("mousedown");
  f.mouse("mousemove", 30);
  f.store.set({ reviewShotId: "second", reviewTrace: [{ tUs: 0 }, { tUs: 2000000 }],
    reviewReleaseTimeMs: 500, reviewReleaseIdx: 0, reviewRangeEst: "Second capture" });
  f.mouse("mousemove", 60);
  assert.equal(f.store.get().reviewReleaseTimeMs, 500);
  assert.equal(f.store.get().reviewRangeEst, "Second capture");
});

test("leaving review or replacing a capture's trace ends its previous drag", () => {
  for (const change of [{ reviewMode: false }, { reviewTrace: [{ tUs: 0 }, { tUs: 9000000 }] }]) {
    const f = fixture();
    f.mouse("mousedown");
    f.mouse("mousemove", 30);
    f.store.set({ ...change, reviewRangeEst: "New view" });
    f.mouse("mousemove", 50);
    assert.equal(f.store.get().reviewRangeEst, "New view");
  }
});

test("touch cancellation ends the gesture and hold-only captures cannot acquire markers", () => {
  const f = fixture();
  f.touch("touchstart");
  f.touch("touchmove", 25);
  f.touch("touchcancel");
  f.touch("touchmove", 50);
  assert.equal(f.store.get().reviewReleaseTimeMs, 250);
  f.store.set({ reviewReleaseIdx: null, reviewReleaseTimeMs: null, reviewHitIdx: null, reviewHitTimeMs: null });
  f.mouse("mousedown");
  f.mouse("mousemove", 40);
  assert.equal(f.store.get().reviewReleaseTimeMs, null);
});

test("missing or invalid speed keeps editable markers without displaying an invalid range", () => {
  for (const speed of [null, { fps: NaN }, { fps: 0 }, { fps: Infinity }]) {
    const f = fixture();
    f.store.set({ reviewRangeSpeed: speed });
    f.mouse("mousedown");
    f.mouse("mousemove", 30);
    assert.equal(f.store.get().reviewReleaseTimeMs, 300);
    assert.equal(f.store.get().reviewRangeEst, "");
  }
});
