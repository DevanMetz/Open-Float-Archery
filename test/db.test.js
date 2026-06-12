import test from "node:test";
import assert from "node:assert/strict";

import { SESSION_GAP_MS, groupShotsByTime } from "../app/core/db.js";

const BASE = Date.parse("2026-01-01T12:00:00.000Z");

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
