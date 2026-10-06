import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../app/core/store.js";

test("awaited notifications deliver to every listener and retain sync/async failures", async () => {
  const bus = new EventBus();
  const payload = { localShotId: "committed-hold" };
  const syncFailure = new Error("View unavailable"), asyncFailure = new Error("Read failed");
  const received = [];
  bus.on("saved", (value) => { received.push(value); throw syncFailure; });
  bus.on("saved", async (value) => { received.push(value); throw asyncFailure; });
  bus.on("saved", (value) => { received.push(value); return false; });
  bus.on("saved", async (value) => { received.push(value); return "updated"; });
  const results = await bus.emitAsync("saved", payload);
  assert.deepEqual(received, [payload, payload, payload, payload]);
  assert.deepEqual(results, [
    { status: "rejected", reason: syncFailure }, { status: "rejected", reason: asyncFailure },
    { status: "fulfilled", value: false }, { status: "fulfilled", value: "updated" },
  ]);
});

test("awaited notifications stay pending until all view reads finish", async () => {
  const bus = new EventBus();
  let finish, settled = false;
  const pending = new Promise((resolve) => { finish = resolve; });
  bus.on("saved", () => pending);
  const updating = bus.emitAsync("saved").then((results) => { settled = true; return results; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish(true);
  assert.deepEqual(await updating, [{ status: "fulfilled", value: true }]);
});

test("an awaited notification uses its original listener snapshot", async () => {
  const bus = new EventBus();
  const called = [];
  let stopSecond;
  bus.on("saved", () => {
    called.push("first");
    stopSecond();
    bus.on("saved", () => { called.push("new"); });
  });
  stopSecond = bus.on("saved", () => { called.push("second"); });
  await bus.emitAsync("saved");
  assert.deepEqual(called, ["first", "second"]);
  await bus.emitAsync("saved");
  assert.deepEqual(called, ["first", "second", "first", "new"]);
  assert.deepEqual(await bus.emitAsync("unknown"), []);
});

test("ordinary telemetry emits still run synchronously and propagate listener errors", () => {
  const bus = new EventBus();
  let received;
  bus.on("sample", (value) => { received = value; });
  assert.equal(bus.emit("sample", 12), undefined);
  assert.equal(received, 12);
  const failure = new Error("Parser failure");
  bus.on("sample", () => { throw failure; });
  assert.throws(() => bus.emit("sample", 13), (error) => error === failure);
  assert.equal(received, 13);
});
