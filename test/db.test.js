import test from "node:test";
import assert from "node:assert/strict";

import { SESSION_GAP_MS, groupShotsByTime, sessionOverrideForGroup, saveSessionOverride, readSavedReview, exportShotData } from "../app/core/db.js";

const BASE = Date.parse("2026-01-01T12:00:00.000Z");

test("review snapshots reject missing capture identities before opening storage", async () => {
  for (const id of [null, undefined, "", " ", 3, {}, []]) {
    await assert.rejects(readSavedReview(id), /Choose a saved capture/);
  }
});

test("single-shot exports reject missing capture identities before opening storage", async () => {
  for (const id of [null, undefined, "", " ", 3, {}, []]) {
    await assert.rejects(exportShotData(id), /Choose a saved capture/);
  }
});

test("session edits reject invalid identities and fields before opening storage", async () => {
  for (const [id, changes, options] of [
    ["", { name: "Practice" }], ["anchor", { name: "Practice" }, { shotIds: [] }],
    ["anchor", { name: "Practice" }, { shotIds: ["anchor", null] }],
    ["anchor", null], ["anchor", {}], ["anchor", { id: "other" }],
    ["anchor", { name: 3 }], ["anchor", { bow_profile_id: false }],
    ["anchor", { arrows_per_end: 4 }], ["anchor", { arrows_per_end: "6" }],
  ]) await assert.rejects(saveSessionOverride(id, changes, options));
});

function shot(id, offsetMs) {
  return {
    id,
    timestamp: new Date(BASE + offsetMs).toISOString(),
  };
}

test("groupShotsByTime returns no sessions for an empty list", () => {
  assert.deepEqual(groupShotsByTime([]), []);
});

test("groupShotsByTime returns one newest-first session for one shot", () => {
  assert.deepEqual(groupShotsByTime([shot("a", 0)]), [{
    anchorId: "a",
    startTime: BASE,
    lastTime: BASE,
    shots: [shot("a", 0)],
  }]);
});

test("groupShotsByTime keeps shots at and under the 30-minute boundary together", () => {
  const shots = [
    shot("a", 0),
    shot("b", SESSION_GAP_MS - 1),
    shot("c", SESSION_GAP_MS),
  ];

  assert.deepEqual(groupShotsByTime(shots), [{
    anchorId: "a",
    startTime: BASE,
    lastTime: BASE + SESSION_GAP_MS,
    shots: [shot("c", SESSION_GAP_MS), shot("b", SESSION_GAP_MS - 1), shot("a", 0)],
  }]);
});

test("groupShotsByTime starts a new session only when the gap is over 30 minutes", () => {
  const shots = [
    shot("a", 0),
    shot("b", SESSION_GAP_MS),
    shot("c", SESSION_GAP_MS * 2 + 1),
  ];

  assert.deepEqual(groupShotsByTime(shots), [
    {
      anchorId: "c",
      startTime: BASE + SESSION_GAP_MS * 2 + 1,
      lastTime: BASE + SESSION_GAP_MS * 2 + 1,
      shots: [shot("c", SESSION_GAP_MS * 2 + 1)],
    },
    {
      anchorId: "a",
      startTime: BASE,
      lastTime: BASE + SESSION_GAP_MS,
      shots: [shot("b", SESSION_GAP_MS), shot("a", 0)],
    },
  ]);
});

test("groupShotsByTime sorts unsorted input and splits multiple sessions", () => {
  const shots = [
    shot("late-2", SESSION_GAP_MS * 5 + 1000),
    shot("early-1", 0),
    shot("middle-1", SESSION_GAP_MS * 2 + 10),
    shot("late-1", SESSION_GAP_MS * 5),
    shot("early-2", 1000),
  ];

  const groups = groupShotsByTime(shots);
  assert.deepEqual(groups.map((group) => group.anchorId), ["late-1", "middle-1", "early-1"]);
  assert.deepEqual(groups.map((group) => group.shots.map((s) => s.id)), [
    ["late-2", "late-1"],
    ["middle-1"],
    ["early-2", "early-1"],
  ]);
});

test("missing or invalid capture times cannot join unrelated sessions", () => {
  const groups = groupShotsByTime([
    shot("a", 0), { id: "missing" }, shot("b", SESSION_GAP_MS + 1), { id: "invalid", timestamp: "unknown" },
  ]);
  assert.equal(groups.length, 4);
  assert.ok(groups.every((group) => group.shots.length === 1));
});

test("captures with equal timestamps keep a stable session anchor regardless of read order", () => {
  const shots = [shot("a", 0), shot("Z", 0)];
  assert.equal(groupShotsByTime(shots)[0].anchorId, "Z", "Ties follow IndexedDB string key order");
  assert.deepEqual(groupShotsByTime(shots), groupShotsByTime([...shots].reverse()));
});

test("a late earlier capture inherits context from the original saved anchor", () => {
  const group = groupShotsByTime([shot("original", 0), shot("earlier", -1000), shot("later", 1000)])[0];
  const context = Object.freeze({ id: "original", name: "Practice", bow_profile_id: "bow", arrows_per_end: 6 });
  const overrides = new Map([[context.id, context]]);
  const before = structuredClone(group);
  assert.equal(sessionOverrideForGroup(group, overrides), context);
  assert.deepEqual(group, before, "Resolving settings must not reorder member captures");
  assert.deepEqual([...overrides], [[context.id, context]], "Resolving settings must not create a replacement override");
});

test("explicit current-anchor settings override older context, including cleared values", () => {
  const group = groupShotsByTime([shot("original", 0), shot("earlier", -1000)])[0];
  const current = { id: "earlier", name: null, bow_profile_id: null, arrows_per_end: 3 };
  assert.equal(sessionOverrideForGroup(group, new Map([
    ["original", { id: "original", name: "Old practice", bow_profile_id: "old-bow", arrows_per_end: 6 }],
    ["earlier", current],
  ])), current);
});

test("merged groups inherit one earliest context without mixing former session settings", () => {
  const group = groupShotsByTime([shot("new", -1000), shot("a", 0), shot("b", 1000)])[0];
  const earliest = { id: "a", name: "First practice" };
  assert.equal(sessionOverrideForGroup(group, new Map([
    ["b", { id: "b", name: "Other practice", bow_profile_id: "other-bow", arrows_per_end: 6 }],
    ["a", earliest],
  ])), earliest);
});

test("context selection follows stable timestamp ties regardless of record order", () => {
  const context = { id: "Z", name: "First tied capture" };
  const overrides = new Map([["a", { id: "a", name: "Second tied capture" }], ["Z", context]]);
  for (const shots of [[shot("a", 0), shot("Z", 0)], [shot("Z", 0), shot("a", 0)]]) {
    const group = groupShotsByTime([shot("new", -1000), ...shots])[0];
    assert.equal(sessionOverrideForGroup(group, overrides), context);
  }
});

test("unrelated overrides cannot supply settings to a group without saved context", () => {
  const overrides = new Map([["other", { id: "other", name: "Unrelated practice" }]]);
  assert.equal(sessionOverrideForGroup(groupShotsByTime([shot("a", 0)])[0], overrides), null);
  assert.equal(sessionOverrideForGroup({ anchorId: "missing", shots: [] }, overrides), null);
});
