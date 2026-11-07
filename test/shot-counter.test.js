import test from "node:test";
import assert from "node:assert/strict";
import { adjustShotCountOffset, displayShotCount } from "../app/ui/shot-counter.js";

test("shot count adjustments are clamped at zero and persist as an offset", () => {
  assert.equal(displayShotCount(8, 0), 8);
  assert.equal(displayShotCount(8, -8), 0);
  assert.equal(displayShotCount(8, -10), 0);
  assert.equal(adjustShotCountOffset(8, 0, 1), 1);
  assert.equal(adjustShotCountOffset(8, 0, -1), -1);
  assert.equal(adjustShotCountOffset(0, 0, -1), 0);
  assert.equal(displayShotCount(8, adjustShotCountOffset(8, 0, 1)), 9);
  assert.equal(displayShotCount(8, adjustShotCountOffset(8, 0, -1)), 7);
});
