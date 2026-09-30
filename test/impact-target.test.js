import test from "node:test";
import assert from "node:assert/strict";
import { mountImpactTarget } from "../app/ui/impact-target.js";

function targetFixture(t, size, dpr = 1) {
  const previousWindow = globalThis.window;
  let target;
  globalThis.window = { devicePixelRatio: dpr, addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    target?.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const arcs = [];
  const context = Object.fromEntries([
    "setTransform", "clearRect", "beginPath", "fill", "stroke", "moveTo", "lineTo",
  ].map((name) => [name, () => {}]));
  context.arc = (...args) => arcs.push(args);
  const listeners = new Map();
  const canvas = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: size, height: size }),
    getContext: () => context,
    addEventListener: (type, handler) => listeners.set(type, handler),
    setAttribute() {},
  };
  let selected;
  target = mountImpactTarget({ canvas, onSelect(point) { selected = point; } });
  return {
    canvas,
    tap(x, y) {
      arcs.length = 0;
      listeners.get("pointerdown")({ clientX: 10 + x, clientY: 20 + y });
      return { selected, marker: arcs.at(-1) };
    },
  };
}

test("a tap outside the blue ring scores four and draws the marker at the tap", (t) => {
  const target = targetFixture(t, 170);
  const { selected, marker } = target.tap(135, 85);
  assert.equal(selected.score, 4);
  assert.ok(Math.abs(marker[0] - 135) < 1e-9);
  assert.ok(Math.abs(marker[1] - 85) < 1e-9);
});

test("target geometry follows small CSS sizes and high-density canvas pixels", (t) => {
  const target = targetFixture(t, 120, 2);
  assert.equal(target.canvas.width, 240);
  const { selected, marker } = target.tap(60, 4);
  assert.equal(selected.y, 1);
  assert.equal(selected.score, 1);
  assert.deepEqual(marker.slice(0, 2), [60, 4]);
  assert.equal(target.tap(60, 2).selected.score, 0);
});
