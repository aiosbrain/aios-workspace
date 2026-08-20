#!/usr/bin/env node
/**
 * Machine check of the mutation-lane soak-streak precondition (AIO-534).
 *
 * docs/testing.md gates the mandatory flip of the PR mutation lane on ten
 * consecutive complete scheduled nightlies of mutation.yml, spanning at
 * least seven days. That precondition was prose-only — no counter, no
 * artifact, no anchor for the fourteen-day reassess clock. This script turns
 * it into a number.
 *
 * Granularity is PER-JOB, not per-run: mutation.yml runs one matrix job per
 * group with `fail-fast: false`, and it documents `bugbot-security` as a
 * deliberately red leg until AIO-554 lands an in-process-fast oracle — so
 * the RUN-level conclusion is failure by construction every night and could
 * never accumulate a streak. A night counts as complete when every governed
 * leg (all matrix legs except the documented deliberate-red set) concluded
 * `success`.
 *
 * Only `schedule`-event runs count — a workflow_dispatch rerun is not a
 * nightly and must not pad the streak. In-progress runs are skipped rather
 * than treated as breaks. A gap of more than MAX_NIGHT_GAP_MS between
 * adjacent streak nights breaks the streak: a disabled or auto-suspended
 * schedule (GitHub disables cron after 60 days without pushes) is silence,
 * and silence is not soak evidence.
 *
 * NOTE: mutation.yml declares `concurrency: cancel-in-progress: true` per
 * ref, so a workflow_dispatch fired while the scheduled nightly is running
 * CANCELS it — the cancelled night has non-success governed legs and breaks
 * the streak. Do not dispatch over a running nightly you care about.
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
 * Adjacent streak nights further apart than this break the streak. Nightly
 * cadence is 24h; 48h tolerates one runner hiccup window without letting a
 * silent scheduling gap masquerade as soak.
 */
export const MAX_NIGHT_GAP_MS = 48 * 60 * 60 * 1000;

/**
 * Matrix legs whose failure does NOT invalidate a night, because the red is
 * documented and expected. Tied to AIO-554: when that issue closes (the
 * bugbot oracle becomes in-process fast and its leg turns green), remove the
 * entry so the leg becomes governed again.
 */
export const DELIBERATE_RED_LEGS = new Set(["bugbot-security"]);

const JOB_NAME = /^Mutation campaign \((.+)\)$/;

/**
 * Whether a night's jobs make it "complete": every governed matrix leg
 * (name-matched, minus DELIBERATE_RED_LEGS) exists and concluded success.
 * Jobs that are not matrix legs are ignored.
 */
export function nightIsComplete(jobs) {
  const governed = jobs.filter((job) => {
    const match = JOB_NAME.exec(job.name ?? "");
    return match && !DELIBERATE_RED_LEGS.has(match[1]);
  });
  return governed.length > 0 && governed.every((job) => job.conclusion === "success");
}

/**
 * Pure streak computation over nights `{ created_at, complete }`. Input
 * order does not matter — sorted newest-first here, never trusted from the
 * API. The streak counts backwards from the most recent night until the
 * first incomplete night or the first >MAX_NIGHT_GAP_MS gap.
 */
export function soakStreak(nights) {
  const sorted = [...nights].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const streak = [];
  for (const night of sorted) {
    if (!night.complete) break;
    if (
      streak.length &&
      Date.parse(streak[streak.length - 1].created_at) - Date.parse(night.created_at) >
        MAX_NIGHT_GAP_MS
    ) {
      break;
    }
    streak.push(night);
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

function ghJson(endpoint, jq) {
  const output = execFileSync("gh", ["api", endpoint, "--jq", jq], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

/** 20 scheduled nights is ample evidence for a 10-night streak check. */
function fetchNights() {
  const runs = ghJson(
    "repos/{owner}/{repo}/actions/workflows/mutation.yml/runs?event=schedule&per_page=20",
    ".workflow_runs | map({id, event, status, created_at})"
  );
  const nights = [];
  for (const run of runs) {
    if (run.event !== "schedule" || run.status !== "completed") continue;
    const jobs = ghJson(
      `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`,
      ".jobs | map({name, conclusion})"
    );
    nights.push({ created_at: run.created_at, complete: nightIsComplete(jobs) });
  }
  return nights;
}

function main(argv) {
  const json = argv.includes("--json");
  let nights;
  try {
    nights = fetchNights();
  } catch (error) {
    console.error(
      `mutation-soak-streak: cannot read mutation.yml runs via gh api: ${error.message}`
    );
    process.exitCode = 2;
    return;
  }
  const { count, daysSpanned, satisfied } = soakStreak(nights);
  if (json) {
    console.log(
      JSON.stringify({
        streak: count,
        daysSpanned: Number(daysSpanned.toFixed(2)),
        requiredStreak: REQUIRED_STREAK,
        requiredDays: REQUIRED_DAYS,
        deliberateRedLegs: [...DELIBERATE_RED_LEGS],
        satisfied,
      })
    );
  } else {
    console.log(
      `mutation soak streak: ${count} consecutive complete scheduled nightlies ` +
        `(need ${REQUIRED_STREAK}) spanning ${daysSpanned.toFixed(1)} days (need ${REQUIRED_DAYS}); ` +
        `a night is complete when every governed leg succeeds ` +
        `(excluded deliberate-red legs: ${[...DELIBERATE_RED_LEGS].join(", ") || "none"})`
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
