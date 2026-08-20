import assert from "node:assert/strict";
import test from "node:test";

import {
  DELIBERATE_RED_LEGS,
  MAX_NIGHT_GAP_MS,
  REQUIRED_DAYS,
  REQUIRED_STREAK,
  nightIsComplete,
  soakStreak,
} from "../scripts/mutation-soak-streak.mjs";

const ANCHOR = Date.parse("2026-08-20T02:23:00Z");

/** A night at N days before the anchor. */
function night(daysAgo, complete) {
  return {
    complete,
    created_at: new Date(ANCHOR - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function leg(group, conclusion) {
  return { name: `Mutation campaign (${group})`, conclusion };
}

test("the documented precondition is ten nightlies over seven days", () => {
  // docs/testing.md states the numbers in prose; this pins the script to them.
  assert.equal(REQUIRED_STREAK, 10);
  assert.equal(REQUIRED_DAYS, 7);
});

test("a night is complete when every governed leg succeeds", () => {
  assert.equal(
    nightIsComplete([
      leg("access-governance", "success"),
      leg("update-safety", "success"),
      leg("inbox-authorization", "success"),
    ]),
    true
  );
});

test("the documented deliberate-red leg cannot invalidate a night (AIO-554 carve-out)", () => {
  // mutation.yml documents bugbot-security as expected-red until AIO-554, and
  // with fail-fast:false its leg makes the RUN conclusion failure every night.
  // Counting run-level conclusions would pin the streak at 0 forever; the
  // check must be per governed leg.
  assert.ok(DELIBERATE_RED_LEGS.has("bugbot-security"));
  assert.equal(
    nightIsComplete([
      leg("access-governance", "success"),
      leg("bugbot-security", "failure"),
      leg("update-safety", "success"),
      leg("inbox-authorization", "success"),
    ]),
    true
  );
});

test("a failed governed leg invalidates the night", () => {
  assert.equal(
    nightIsComplete([
      leg("access-governance", "success"),
      leg("bugbot-security", "failure"),
      leg("inbox-authorization", "failure"),
    ]),
    false
  );
});

test("a cancelled governed leg invalidates the night — silence is not soak evidence", () => {
  assert.equal(
    nightIsComplete([leg("access-governance", "cancelled"), leg("update-safety", "success")]),
    false
  );
});

test("a night with no governed matrix legs is never complete", () => {
  assert.equal(nightIsComplete([]), false);
  assert.equal(nightIsComplete([leg("bugbot-security", "failure")]), false);
  assert.equal(nightIsComplete([{ name: "Some other job", conclusion: "success" }]), false);
});

test("a clean ten-night streak spanning nine days satisfies the precondition", () => {
  const nights = Array.from({ length: 10 }, (_, i) => night(i, true));
  const result = soakStreak(nights);
  assert.equal(result.count, 10);
  assert.equal(result.daysSpanned, 9);
  assert.equal(result.satisfied, true);
});

test("soakStreak sorts internally and never trusts API ordering", () => {
  const nights = Array.from({ length: 10 }, (_, i) => night(i, true));
  // Oldest-first plus an interior shuffle must give the same answer.
  const shuffled = [...nights].reverse();
  [shuffled[2], shuffled[7]] = [shuffled[7], shuffled[2]];
  assert.deepEqual(soakStreak(shuffled), soakStreak(nights));
  assert.equal(soakStreak(shuffled).satisfied, true);
});

test("an incomplete night breaks the streak at the most recent break, not the oldest", () => {
  const nights = [
    night(0, true),
    night(1, true),
    night(2, false),
    ...Array.from({ length: 10 }, (_, i) => night(3 + i, true)),
  ];
  const result = soakStreak(nights);
  assert.equal(result.count, 2);
  assert.equal(result.satisfied, false);
});

test("a scheduling gap over the max night gap breaks the streak", () => {
  // Five recent nights, then a 3-day silence (workflow disabled / GitHub's
  // 60-day cron auto-disable), then more successes: the silence is not soak.
  assert.equal(MAX_NIGHT_GAP_MS, 48 * 60 * 60 * 1000);
  const nights = [
    ...Array.from({ length: 5 }, (_, i) => night(i, true)),
    ...Array.from({ length: 10 }, (_, i) => night(7 + i, true)),
  ];
  const result = soakStreak(nights);
  assert.equal(result.count, 5);
  assert.equal(result.satisfied, false);
});

test("ten consecutive completes squeezed into under seven days do not satisfy", () => {
  // Ten dispatch-cadence nights in under three days must not fake a week of soak.
  const nights = Array.from({ length: 10 }, (_, i) => night(i * 0.3, true));
  const result = soakStreak(nights);
  assert.equal(result.count, 10);
  assert.ok(result.daysSpanned < REQUIRED_DAYS);
  assert.equal(result.satisfied, false);
});

test("no nights at all reports a zero streak, unsatisfied", () => {
  assert.deepEqual(soakStreak([]), { count: 0, daysSpanned: 0, satisfied: false });
});
