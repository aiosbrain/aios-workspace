import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_DAYS, REQUIRED_STREAK, soakStreak } from "../scripts/mutation-soak-streak.mjs";

/** Newest-first scheduled run at N days before an arbitrary fixed anchor. */
function run(daysAgo, conclusion, event = "schedule") {
  const anchor = Date.parse("2026-08-20T02:23:00Z");
  return {
    event,
    conclusion,
    created_at: new Date(anchor - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  };
}

test("the documented precondition is ten nightlies over seven days", () => {
  // docs/testing.md states the numbers in prose; this pins the script to them.
  assert.equal(REQUIRED_STREAK, 10);
  assert.equal(REQUIRED_DAYS, 7);
});

test("a clean ten-night streak spanning nine days satisfies the precondition", () => {
  const runs = Array.from({ length: 10 }, (_, i) => run(i, "success"));
  const result = soakStreak(runs);
  assert.equal(result.count, 10);
  assert.equal(result.daysSpanned, 9);
  assert.equal(result.satisfied, true);
});

test("a failure breaks the streak at the most recent break, not the oldest", () => {
  const runs = [
    run(0, "success"),
    run(1, "success"),
    run(2, "failure"),
    ...Array.from({ length: 10 }, (_, i) => run(3 + i, "success")),
  ];
  const result = soakStreak(runs);
  assert.equal(result.count, 2);
  assert.equal(result.satisfied, false);
});

test("ten consecutive successes squeezed into under seven days do not satisfy", () => {
  // Ten dispatch-cadence runs in three days must not fake a week of soak.
  const runs = Array.from({ length: 10 }, (_, i) => run(i * 0.3, "success"));
  const result = soakStreak(runs);
  assert.equal(result.count, 10);
  assert.ok(result.daysSpanned < REQUIRED_DAYS);
  assert.equal(result.satisfied, false);
});

test("workflow_dispatch reruns never count toward the streak", () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => run(i, "success", "workflow_dispatch")),
    ...Array.from({ length: 4 }, (_, i) => run(6 + i, "success")),
  ];
  const result = soakStreak(runs);
  assert.equal(result.count, 4, "only scheduled nightlies count");
  assert.equal(result.satisfied, false);
});

test("an in-progress nightly (null conclusion) is skipped, not treated as a break", () => {
  const runs = [run(0, null), ...Array.from({ length: 10 }, (_, i) => run(1 + i, "success"))];
  const result = soakStreak(runs);
  assert.equal(result.count, 10);
  assert.equal(result.satisfied, true);
});

test("a cancelled nightly breaks the streak — silence is not soak evidence", () => {
  const runs = [
    run(0, "cancelled"),
    ...Array.from({ length: 10 }, (_, i) => run(1 + i, "success")),
  ];
  assert.equal(soakStreak(runs).count, 0);
});

test("no runs at all reports a zero streak, unsatisfied", () => {
  assert.deepEqual(soakStreak([]), { count: 0, daysSpanned: 0, satisfied: false });
});
