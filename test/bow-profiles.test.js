import test from "node:test";
import assert from "node:assert/strict";
import { mountBowProfiles } from "../app/ui/bow-profiles.js";
import { saveBowProfile } from "../app/core/db.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ syncAdapter } = {}) {
  const document = { createElement: () => ({ remove() {
    const nodes = el.bowProfileSelect.children;
    nodes.splice(nodes.indexOf(this), 1);
  } }) };
  const names = ["bowProfileSelect", "bowModelInput", "drawWeightInput", "bowSpeedInput",
    "stabilizerSetupInput", "bowNotesInput", "saveBowProfileBtn", "deleteBowProfileBtn", "newBowProfileBtn", "bowProfileStatus"];
  const el = Object.fromEntries(names.map((name) => [name, {
    value: "", disabled: false, innerHTML: "", textContent: "", events: {}, children: [], valid: true,
    ownerDocument: document,
    get options() { return this.children; },
    get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); },
    addEventListener(type, action) { this.events[type] = action; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    reportValidity() { return this.valid; }, focus() {}, setAttribute() {},
  }]));
  const preferences = new Map();
  const storage = { getItem: (key) => preferences.get(key) || null, setItem: (key, value) => preferences.set(key, value) };
  const profiles = new Map(), reads = new Map(), saves = [], writes = [];
  let ids = 0;
  const database = {
    getAll: async () => [...profiles.values()],
    get: async (_table, id) => reads.has(id) ? reads.get(id).promise : profiles.get(id),
    saveBowProfile: async (record, { create }) => {
      writes.push({ record, create });
      const saving = deferred();
      saves.push({ record, ...saving });
      await saving.promise;
      profiles.set(record.id, record);
      return record;
    },
    removeBowProfile: async (id) => { const record = profiles.get(id); profiles.delete(id); return record; },
    generateUUID: () => `new-${++ids}`,
  };
  const logs = [];
  const ui = mountBowProfiles({ el, database, preferences: storage, syncAdapter,
    bus: { emit(_type, message) { logs.push(message); } }, confirmDelete: () => true });
  return { el, profiles, reads, saves, writes, preferences, ui, database, storage, logs,
    select(id) { el.bowProfileSelect.value = id; return el.bowProfileSelect.events.change(); },
    click(id) { return el[id].events.click(); },
  };
}

test("a delayed bow profile cannot replace the latest selected profile", async () => {
  const f = fixture();
  f.reads.set("first", deferred());
  f.profiles.set("second", { id: "second", model: "Second Bow", arrow_speed: 300 });
  f.select("first");
  f.select("second");
  await flush();
  f.reads.get("first").resolve({ id: "first", model: "Old Bow", arrow_speed: 240 });
  await flush();
  assert.equal(f.el.bowProfileSelect.value, "second");
  assert.equal(f.el.bowModelInput.value, "Second Bow");
  assert.equal(f.el.bowSpeedInput.value, 300);
});

test("creating a new bow draft invalidates an older profile load", async () => {
  const f = fixture();
  f.reads.set("first", deferred());
  f.select("first");
  f.click("newBowProfileBtn");
  f.el.bowModelInput.value = "New Draft";
  f.reads.get("first").resolve({ id: "first", model: "Old Bow" });
  await flush();
  assert.equal(f.el.bowModelInput.value, "New Draft");
  assert.equal(f.el.bowProfileSelect.value, "");
  assert.equal(f.el.deleteBowProfileBtn.disabled, true);
});

test("a superseded profile list reports no failure after a newer refresh completes", async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    const older = deferred(), newer = deferred();
    let read = 0;
    f.database.getAll = () => (++read === 1 ? older : newer).promise;
    const first = f.ui.load();
    const second = f.ui.load();
    newer.resolve([{ id: "newer", model: "Newer Bow" }]);
    assert.equal(await second, true);
    if (fails) older.reject(new Error("Outdated read failed"));
    else older.resolve([{ id: "older", model: "Older Bow" }]);
    assert.equal(await first, undefined);
    assert.equal(f.el.bowProfileSelect.options[1].textContent, "Newer Bow");
    assert.equal(f.el.bowProfileStatus.textContent, "");
  }
});

test("superseded profile details report no failure or warning after another selection", async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    f.preferences.set("openfloat_active_bow_id", "first");
    f.profiles.set("first", { id: "first", model: "First Bow" });
    f.profiles.set("second", { id: "second", model: "Second Bow" });
    const pending = deferred();
    f.reads.set("first", pending);
    const loading = f.ui.load();
    await flush();
    assert.equal(await f.select("second"), true);
    if (fails) pending.reject(new Error("Outdated details failed"));
    else pending.resolve({ id: "first", model: "Outdated Bow" });
    assert.equal(await loading, undefined);
    assert.equal(f.el.bowModelInput.value, "Second Bow");
    assert.equal(f.el.bowProfileStatus.textContent, "");
    assert.ok(!f.logs.some((message) => message.includes("Outdated")));
  }
});

test("a pending bow save prevents duplicate creation and locks its controls", async () => {
  const f = fixture();
  f.el.bowModelInput.value = "Practice Bow";
  const first = f.click("saveBowProfileBtn");
  const duplicate = f.click("saveBowProfileBtn");
  await flush();
  const pendingCount = f.saves.length;
  const controlsLocked = f.el.saveBowProfileBtn.disabled && f.el.newBowProfileBtn.disabled && f.el.bowProfileSelect.disabled;
  for (const save of f.saves) save.resolve();
  await Promise.all([first, duplicate]);
  assert.equal(pendingCount, 1);
  assert.ok(controlsLocked);
  assert.equal(f.profiles.size, 1);
});

test("a failed bow save keeps the draft and allows a single retry", async () => {
  const f = fixture();
  f.el.bowModelInput.value = "Retry Bow";
  f.el.drawWeightInput.value = "42.5";
  const first = f.click("saveBowProfileBtn");
  f.saves[0].reject(new Error("Storage full"));
  await first;
  assert.equal(f.profiles.size, 0);
  assert.equal(f.el.bowModelInput.value, "Retry Bow");
  assert.equal(f.el.drawWeightInput.value, "42.5");
  assert.equal(f.el.bowProfileSelect.value, "");
  assert.equal(f.el.saveBowProfileBtn.disabled, false);
  assert.match(f.el.bowProfileStatus.textContent, /Could not save.*Storage full/);
  const retry = f.click("saveBowProfileBtn");
  f.saves[1].resolve();
  await retry;
  assert.equal(f.profiles.size, 1);
  assert.equal([...f.profiles.values()][0].draw_weight, 42.5);
});

test("preference or sync failures cannot turn a committed bow save into a failed save", async () => {
  const f = fixture({ syncAdapter: { triggerSync() { throw new Error("Sync unavailable"); } } });
  f.storage.setItem = () => { throw new Error("Preferences blocked"); };
  f.el.bowModelInput.value = "Local Bow";
  const saving = f.click("saveBowProfileBtn");
  f.saves[0].resolve();
  await saving;
  await flush();
  assert.equal(f.profiles.size, 1);
  assert.equal(f.el.bowProfileSelect.value, "new-1");
  assert.match(f.el.bowProfileStatus.textContent, /^Saved bow profile: Local Bow/);
  assert.ok(f.logs.some((message) => message.includes("cloud sync failed")));
  assert.equal(f.el.deleteBowProfileBtn.disabled, false);
});

test("a list response cannot replace a new draft typed during initial loading", async () => {
  const f = fixture();
  const list = deferred();
  f.preferences.set("openfloat_active_bow_id", "stored-bow");
  f.database.getAll = () => list.promise;
  const loading = f.ui.load();
  f.el.bowModelInput.value = "Draft Bow";
  f.el.bowModelInput.events.input();
  list.resolve([{ id: "stored-bow", model: "Stored Bow" }]);
  await loading;
  assert.equal(f.el.bowModelInput.value, "Draft Bow");
  assert.equal(f.el.bowProfileSelect.value, "");
  assert.equal(f.el.saveBowProfileBtn.disabled, false);
});

test("a list refresh preserves unsaved profile edits and the selected id", async () => {
  const f = fixture();
  f.profiles.set("edited-bow", { id: "edited-bow", model: "Original" });
  await f.select("edited-bow");
  f.el.bowModelInput.value = "Unsaved name";
  f.el.bowModelInput.events.input();
  await f.ui.load();
  assert.equal(f.el.bowModelInput.value, "Unsaved name");
  assert.equal(f.el.bowProfileSelect.value, "edited-bow");
  const saving = f.click("saveBowProfileBtn");
  assert.equal(f.writes[0].create, false);
  f.saves[0].resolve();
  await saving;
});

test("missing or failed profile reads clear the old form and prevent saving to the wrong id", async () => {
  const f = fixture();
  f.profiles.set("first", { id: "first", model: "First Bow" });
  await f.select("first");
  await f.select("missing");
  assert.equal(f.el.bowModelInput.value, "");
  assert.equal(f.el.saveBowProfileBtn.disabled, true);
  assert.equal(f.el.deleteBowProfileBtn.disabled, true);
  const loading = deferred();
  f.reads.set("failed", loading);
  const selected = f.select("failed");
  loading.reject(new Error("Read unavailable"));
  await selected;
  assert.match(f.el.bowProfileStatus.textContent, /Read unavailable/);
  assert.equal(f.el.saveBowProfileBtn.disabled, true);
  f.click("newBowProfileBtn");
  assert.equal(f.el.saveBowProfileBtn.disabled, false);
});

test("a pending bow deletion prevents duplicate requests and preserves the form after failure", async () => {
  const f = fixture();
  f.profiles.set("keep", { id: "keep", model: "Keep Bow" });
  await f.select("keep");
  const removing = deferred();
  let requests = 0;
  f.database.removeBowProfile = () => { requests += 1; return removing.promise; };
  const first = f.click("deleteBowProfileBtn");
  const duplicate = f.click("deleteBowProfileBtn");
  assert.equal(requests, 1);
  assert.equal(f.el.bowModelInput.disabled, true);
  removing.reject(new Error("Delete aborted"));
  await Promise.all([first, duplicate]);
  assert.equal(f.el.bowModelInput.value, "Keep Bow");
  assert.equal(f.el.bowProfileSelect.value, "keep");
  assert.equal(f.el.deleteBowProfileBtn.disabled, false);
  assert.match(f.el.bowProfileStatus.textContent, /Could not delete.*Delete aborted/);
});

test("bow names and HTML numeric constraints are checked before any save", async () => {
  const f = fixture();
  f.el.bowModelInput.value = "   ";
  await f.click("saveBowProfileBtn");
  assert.match(f.el.bowProfileStatus.textContent, /Enter a bow name/);
  f.el.bowModelInput.value = "Valid Bow";
  f.el.bowSpeedInput.valid = false;
  await f.click("saveBowProfileBtn");
  assert.equal(f.saves.length, 0);
});

test("the bow storage API rejects invalid measurements before opening a database", async () => {
  for (const profile of [null, { id: "" }, { id: "bow", model: " " },
    { id: "bow", model: "Bow", arrow_speed: NaN },
    { id: "bow", model: "Bow", arrow_speed: -1 },
    { id: "bow", model: "Bow", draw_weight: Infinity },
    { id: "bow", model: "Bow", draw_weight: "42" },
  ]) await assert.rejects(saveBowProfile(profile), /needs an id and a name|positive numbers/);
});
