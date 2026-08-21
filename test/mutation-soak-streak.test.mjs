import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANCHOR,
  DELIBERATE_RED_LEGS,
  MAX_NIGHT_GAP_MS,
  REQUIRED_DAYS,
  REQUIRED_STREAK,
  expectedGovernedLegs,
  fetchNights,
  main,
  nightIsComplete,
  soakStreak,
} from "../scripts/mutation-soak-streak.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;

// Nights are laid out relative to a base 30 days AFTER the soak anchor so the
// streak logic is exercised on its own; anchor filtering has explicit tests.
const BASE = Date.parse(ANCHOR) + 30 * DAY_MS;

/** A night at N days before the post-anchor base. */
function night(daysAgo, complete) {
  return { complete, created_at: new Date(BASE - daysAgo * DAY_MS).toISOString() };
}

function leg(group, conclusion) {
  return { name: `Mutation campaign (${group})`, conclusion };
}

/** The governed legs of the real workflow, used by most completeness tests. */
const GOVERNED = expectedGovernedLegs(
  readFileSync(path.join(ROOT, ".github", "workflows", "mutation.yml"), "utf8")
);

test("the documented precondition is ten nightlies over seven days", () => {
  // docs/testing.md states the numbers in prose; this pins the script to them.
  assert.equal(REQUIRED_STREAK, 10);
  assert.equal(REQUIRED_DAYS, 7);
});

test("expectedGovernedLegs derives the governed set from mutation.yml minus deliberate-red", () => {
  // Same matrix parse as the parity test above: the expected set tracks the
  // workflow, so adding a matrix leg automatically makes it required for soak.
  assert.deepEqual(GOVERNED, ["access-governance", "update-safety", "inbox-authorization"]);
  assert.ok(GOVERNED.every((legName) => !DELIBERATE_RED_LEGS.has(legName)));
  assert.throws(() => expectedGovernedLegs("jobs:\n  nothing:\n"), /cannot parse the matrix/);
});

test("a night is complete when every expected governed leg is present and succeeded", () => {
  assert.equal(
    nightIsComplete(
      [
        leg("access-governance", "success"),
        leg("update-safety", "success"),
        leg("inbox-authorization", "success"),
      ],
      GOVERNED
    ),
    true
  );
});

test("a night that DROPPED an expected leg is incomplete even if survivors succeeded", () => {
  // Cancelled matrix expansion, a workflow regression, or an older revision
  // must not count as soak just because the legs that did run were green.
  assert.equal(
    nightIsComplete(
      [leg("access-governance", "success"), leg("update-safety", "success")],
      GOVERNED
    ),
    false
  );
});

test("extra unknown jobs are ignored; they cannot complete or break a night", () => {
  const complete = [
    leg("access-governance", "success"),
    leg("update-safety", "success"),
    leg("inbox-authorization", "success"),
  ];
  assert.equal(
    nightIsComplete(
      [...complete, { name: "Some future setup job", conclusion: "failure" }],
      GOVERNED
    ),
    true
  );
  assert.equal(
    nightIsComplete([{ name: "Some other job", conclusion: "success" }], GOVERNED),
    false
  );
});

test("the documented deliberate-red leg cannot invalidate a night (AIO-554 carve-out)", () => {
  // mutation.yml documents bugbot-security as expected-red until AIO-554, and
  // with fail-fast:false its leg makes the RUN conclusion failure every night.
  // Counting run-level conclusions would pin the streak at 0 forever; the
  // check must be per governed leg.
  assert.ok(DELIBERATE_RED_LEGS.has("bugbot-security"));
  assert.equal(
    nightIsComplete(
      [
        leg("access-governance", "success"),
        leg("bugbot-security", "failure"),
        leg("update-safety", "success"),
        leg("inbox-authorization", "success"),
      ],
      GOVERNED
    ),
    true
  );
});

test("a failed governed leg invalidates the night", () => {
  assert.equal(
    nightIsComplete(
      [
        leg("access-governance", "success"),
        leg("update-safety", "success"),
        leg("inbox-authorization", "failure"),
      ],
      GOVERNED
    ),
    false
  );
});

test("a cancelled governed leg invalidates the night — silence is not soak evidence", () => {
  assert.equal(
    nightIsComplete(
      [
        leg("access-governance", "cancelled"),
        leg("update-safety", "success"),
        leg("inbox-authorization", "success"),
      ],
      GOVERNED
    ),
    false
  );
});

test("an empty expected set can never report a complete night", () => {
  assert.equal(nightIsComplete([leg("access-governance", "success")], []), false);
});

test("nights before the soak anchor contribute nothing, however complete", () => {
  // The docs/testing.md anchor (2026-08-20, the AIO-994 oracle restoration) is
  // enforced in code: ten perfect nights BEFORE the anchor measured a broken
  // oracle and must leave the streak at zero.
  const anchorMs = Date.parse(ANCHOR);
  const preAnchor = Array.from({ length: 10 }, (_, i) => ({
    complete: true,
    created_at: new Date(anchorMs - (i + 1) * DAY_MS).toISOString(),
  }));
  assert.deepEqual(soakStreak(preAnchor), { count: 0, daysSpanned: 0, satisfied: false });
  // Mixed: pre-anchor completes neither extend nor break a post-anchor streak.
  const postAnchor = Array.from({ length: 3 }, (_, i) => ({
    complete: true,
    created_at: new Date(anchorMs + (i + 1) * DAY_MS).toISOString(),
  }));
  assert.equal(soakStreak([...preAnchor, ...postAnchor]).count, 3);
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

// ── Process-boundary paths (fetchNights / main / ghJson / entry guard) ──────────────────────────

function completeJobs() {
  return GOVERNED.map((group) => leg(group, "success"));
}

test("fetchNights keeps only completed scheduled runs and asks for each one's jobs", () => {
  const calls = [];
  const runsPayload = [
    { id: 1, event: "schedule", status: "completed", created_at: night(0, true).created_at },
    {
      id: 2,
      event: "workflow_dispatch",
      status: "completed",
      created_at: night(1, true).created_at,
    },
    { id: 3, event: "schedule", status: "in_progress", created_at: night(2, true).created_at },
    { id: 4, event: "schedule", status: "completed", created_at: night(3, true).created_at },
  ];
  const gh = (endpoint, jq) => {
    calls.push(endpoint);
    assert.ok(jq.length > 0, "every gh call must pass a jq projection");
    if (calls.length === 1) return runsPayload;
    // Run 4 dropped a governed leg; run 1 is complete.
    return endpoint.includes("/runs/4/") ? completeJobs().slice(1) : completeJobs();
  };
  const nights = fetchNights(gh);
  assert.deepEqual(nights, [
    { created_at: runsPayload[0].created_at, complete: true },
    { created_at: runsPayload[3].created_at, complete: false },
  ]);
  // One runs listing + one jobs fetch per completed scheduled run — never for
  // the dispatch rerun or the in-progress night.
  assert.equal(calls.length, 3);
  assert.match(calls[0], /workflows\/mutation\.yml\/runs\?event=schedule/);
  assert.match(calls[1], /\/runs\/1\/jobs/);
  assert.match(calls[2], /\/runs\/4\/jobs/);
});

test("main returns 0 and reports MET when the streak satisfies", () => {
  const lines = [];
  const nights = Array.from({ length: 10 }, (_, i) => night(i, true));
  const code = main([], { fetch: () => nights, log: (line) => lines.push(line) });
  assert.equal(code, 0);
  assert.match(lines[0], /10 consecutive complete scheduled nightlies/);
  assert.match(lines[1], /precondition MET/);
});

test("main --json returns 1 with the machine shape when unsatisfied", () => {
  const lines = [];
  const code = main(["--json"], { fetch: () => [], log: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    streak: 0,
    daysSpanned: 0,
    requiredStreak: REQUIRED_STREAK,
    requiredDays: REQUIRED_DAYS,
    deliberateRedLegs: ["bugbot-security"],
    satisfied: false,
  });
});

test("main returns 2 and explains when the gh lookup fails", () => {
  const errors = [];
  const code = main([], {
    fetch: () => {
      throw new Error("gh: HTTP 502");
    },
    logError: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors[0], /cannot read mutation\.yml runs via gh api: gh: HTTP 502/);
});

test("the CLI entry runs end-to-end against a canned gh on PATH", () => {
  // Covers ghJson + the entry guard with a real subprocess: a fake `gh`
  // first on PATH returns one canned completed scheduled night whose
  // governed legs all succeeded — streak 1, precondition unmet, exit 1.
  const shimDir = mkdtempSync(path.join(tmpdir(), "soak-gh-shim-"));
  const runsJson = JSON.stringify([
    { id: 7, event: "schedule", status: "completed", created_at: night(0, true).created_at },
  ]);
  const jobsJson = JSON.stringify(completeJobs());
  writeFileSync(
    path.join(shimDir, "gh"),
    `#!/usr/bin/env node\n` +
      `const endpoint = process.argv[3] ?? "";\n` +
      `console.log(endpoint.includes("/jobs") ? ${JSON.stringify(jobsJson)} : ${JSON.stringify(runsJson)});\n`,
    { mode: 0o755 }
  );
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "mutation-soak-streak.mjs"), "--json"],
    { encoding: "utf8", env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } }
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.streak, 1);
  assert.equal(report.satisfied, false);
  rmSync(shimDir, { recursive: true, force: true });
});
