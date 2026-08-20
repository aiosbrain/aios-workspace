#!/usr/bin/env node
/**
 * Machine check of the mutation-lane soak-streak precondition (AIO-534).
 *
 * docs/testing.md gates the mandatory flip of the PR mutation lane on ten
 * consecutive COMPLETE (successful) scheduled nightlies of mutation.yml,
 * spanning at least seven days. That precondition was prose-only — no
 * counter, no artifact, no anchor for the fourteen-day reassess clock. This
 * script turns it into a number: it reads scheduled-run conclusions via
 * `gh api` and reports the current consecutive-success streak counted
 * backwards from the most recent completed scheduled run, plus the days it
 * spans.
 *
 * Only `schedule`-event runs count — a workflow_dispatch rerun is not a
 * nightly and must not pad the streak. In-progress runs (conclusion null)
 * are skipped rather than treated as breaks: tonight's still-running
 * campaign says nothing about the soak either way.
 *
 * Usage: node scripts/mutation-soak-streak.mjs [--json]
 * Exit codes: 0 = precondition met, 1 = not yet met, 2 = lookup failure.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_STREAK = 10;
export const REQUIRED_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure streak computation over workflow runs (newest first, as the GitHub API
 * returns them). Each run needs { event, conclusion, created_at }.
 */
export function soakStreak(runs) {
  const completed = runs.filter((run) => run.event === "schedule" && run.conclusion !== null);
  const streak = [];
  for (const run of completed) {
    if (run.conclusion !== "success") break;
    streak.push(run);
  }
  const count = streak.length;
  const daysSpanned = count
    ? (Date.parse(streak[0].created_at) - Date.parse(streak[count - 1].created_at)) / DAY_MS
    : 0;
  return {
    count,
    daysSpanned,
    satisfied: count >= REQUIRED_STREAK && daysSpanned >= REQUIRED_DAYS,
  };
}

function fetchScheduledRuns() {
  const output = execFileSync(
    "gh",
    [
      "api",
      "repos/{owner}/{repo}/actions/workflows/mutation.yml/runs?event=schedule&per_page=50",
      "--jq",
      ".workflow_runs | map({event, conclusion, created_at})",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(output);
}

function main(argv) {
  const json = argv.includes("--json");
  let runs;
  try {
    runs = fetchScheduledRuns();
  } catch (error) {
    console.error(
      `mutation-soak-streak: cannot read mutation.yml runs via gh api: ${error.message}`
    );
    process.exitCode = 2;
    return;
  }
  const { count, daysSpanned, satisfied } = soakStreak(runs);
  if (json) {
    console.log(
      JSON.stringify({
        streak: count,
        daysSpanned: Number(daysSpanned.toFixed(2)),
        requiredStreak: REQUIRED_STREAK,
        requiredDays: REQUIRED_DAYS,
        satisfied,
      })
    );
  } else {
    console.log(
      `mutation soak streak: ${count} consecutive complete scheduled nightlies ` +
        `(need ${REQUIRED_STREAK}) spanning ${daysSpanned.toFixed(1)} days (need ${REQUIRED_DAYS})`
    );
    console.log(
      satisfied
        ? "precondition MET — the mandatory flip may be reassessed (see docs/testing.md)"
        : "precondition NOT met — the PR mutation lane stays non-blocking (docs/testing.md)"
    );
  }
  process.exitCode = satisfied ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
