import test from "node:test";
import assert from "node:assert/strict";
import { sensorConnectionProblem } from "../app/ui/browser-support.js";

const capable = { bluetooth: { requestDevice() { throw new Error("Preflight must never open a picker"); } } };
const environment = (navigator = capable, extra = {}) => ({ navigator, secureContext: true, policy: null, ...extra });

test("sensor preflight requires a callable picker without requesting device access", () => {
  assert.equal(sensorConnectionProblem(environment()), "");
  for (const navigator of [null, {}, { bluetooth: {} }, { bluetooth: { requestDevice: true } }]) {
    assert.match(sensorConnectionProblem(environment(navigator)), /does not provide Web Bluetooth/);
  }
});

test("insecure pages explain HTTPS and localhost before checking browser support", () => {
  const message = sensorConnectionProblem(environment({}, { secureContext: false }));
  assert.match(message, /https:\/\/openfloatarchery.com/);
  assert.match(message, /localhost/);
  assert.match(message, /Demo, Saved Shots, and local backup\/restore still work/);
});

test("iPhone and desktop-mode iPad get accurate guidance without rejecting a capable wrapper", () => {
  for (const navigator of [{ userAgent: "iPhone" }, { userAgent: "iPad" }, { platform: "MacIntel", maxTouchPoints: 5 }]) {
    assert.match(sensorConnectionProblem(environment(navigator)), /iPhone or iPad/);
    assert.equal(sensorConnectionProblem(environment({ ...navigator, ...capable })), "");
  }
  assert.doesNotMatch(sensorConnectionProblem(environment({ platform: "MacIntel", maxTouchPoints: 0 })), /iPhone/);
});

test("policy-denied pages explain opening the app directly without changing permissions", () => {
  const policy = { allowsFeature(feature) { assert.equal(feature, "bluetooth"); return false; } };
  assert.match(sensorConnectionProblem(environment(capable, { policy })), /permissions policy blocks/);
  assert.equal(sensorConnectionProblem(environment(capable, { policy: { allowsFeature: () => true } })), "");
});

test("unrecognized policy APIs leave the actual supported picker available", () => {
  assert.equal(sensorConnectionProblem(environment(capable, { policy: { allowsFeature() { throw new Error("Unknown feature"); } } })), "");
  assert.equal(sensorConnectionProblem(environment(capable, { policy: {} })), "");
});
