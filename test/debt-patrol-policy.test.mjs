import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { observeTarget } from "../scripts/debt-patrol/plan.mjs";
import { buildPatrolPlan, validatePatrolConfig } from "../scripts/debt-patrol/policy.mjs";
import { revalidatePatrol } from "../scripts/debt-patrol/revalidate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_SCRIPT = path.join(ROOT, "scripts/debt-patrol/plan.mjs");
const REVALIDATE_SCRIPT = path.join(ROOT, "scripts/debt-patrol/revalidate.mjs");
const config = JSON.parse(readFileSync(path.join(ROOT, "config/debt-patrol.v1.json"), "utf8"));
const WORKSPACE_SHA = "a".repeat(40);
const BRAIN_SHA = "b".repeat(40);
const observations = {
  "aiosbrain/aios-workspace": {
    default_branch: "main",
    head_sha: WORKSPACE_SHA,
    open_pr_count: 6,
  },
  "aiosbrain/aios-team-brain": {
    default_branch: "main",
    head_sha: BRAIN_SHA,
    open_pr_count: 6,
  },
};
const context = {
  event_name: "schedule",
  event_schedule: config.schedule_crons.daily,
  producer_enabled: true,
  producer_unpaused: true,
  workflow_ref: "refs/heads/main",
  now: "2026-08-04T12:00:00.000Z",
};

test("daily and weekly schedules select only explicitly opted-in targets", () => {
  const daily = buildPatrolPlan(config, context, observations);
  assert.deepEqual(
    daily.matrix.include.map((entry) => entry.repository),
    ["aiosbrain/aios-workspace"]
  );
  assert.equal(daily.matrix.include[0].resolved_sha, WORKSPACE_SHA);
  assert.equal(daily.matrix.include[0].planned_at, context.now);
  assert.equal(daily.decisions[1].decision, "stop");
  assert.deepEqual(daily.decisions[1].reason_codes, ["schedule_not_enabled_for_target"]);

  const weekly = buildPatrolPlan(
    config,
    { ...context, event_schedule: config.schedule_crons.weekly },
    observations
  );
  assert.deepEqual(
    weekly.matrix.include.map((entry) => entry.repository),
    ["aiosbrain/aios-team-brain"]
  );
});

test("producer opt-in and pause variables default fail closed with auditable reasons", () => {
  const disabled = buildPatrolPlan(config, { ...context, producer_enabled: false }, observations);
  assert.equal(disabled.matrix.include.length, 0);
  assert.ok(
    disabled.decisions.every((entry) => entry.reason_codes.includes("producer_opt_in_missing"))
  );

  const paused = buildPatrolPlan(config, { ...context, producer_unpaused: false }, observations);
  assert.equal(paused.matrix.include.length, 0);
  assert.ok(
    paused.decisions.every((entry) =>
      entry.reason_codes.includes("producer_pause_not_explicitly_disabled")
    )
  );
});

test("producer code from a non-default ref cannot reach a target job", () => {
  const featureRef = buildPatrolPlan(
    config,
    { ...context, workflow_ref: "refs/heads/feature/untrusted" },
    observations
  );
  assert.equal(featureRef.matrix.include.length, 0);
  assert.ok(
    featureRef.decisions.every((entry) =>
      entry.reason_codes.includes("producer_ref_not_default_branch")
    )
  );
});

test("target opt-in, unknown schedule, branch observation, and open-PR cap stop scheduling", () => {
  const targetOff = structuredClone(config);
  targetOff.targets[0].enabled = false;
  assert.ok(
    buildPatrolPlan(targetOff, context, observations).decisions[0].reason_codes.includes(
      "target_not_opted_in"
    )
  );

  const unknown = buildPatrolPlan(
    config,
    { ...context, event_schedule: "0 0 31 2 *" },
    observations
  );
  assert.ok(unknown.decisions.every((entry) => entry.reason_codes.includes("unknown_schedule")));

  const wrongBranch = structuredClone(observations);
  wrongBranch["aiosbrain/aios-workspace"].default_branch = "master";
  assert.ok(
    buildPatrolPlan(config, context, wrongBranch).decisions[0].reason_codes.includes(
      "default_branch_mismatch"
    )
  );

  const saturated = structuredClone(observations);
  saturated["aiosbrain/aios-workspace"].open_pr_count = 13;
  assert.ok(
    buildPatrolPlan(config, context, saturated).decisions[0].reason_codes.includes(
      "open_pr_cap_exceeded"
    )
  );
});

test("invalid or missing budget configuration is rejected before any target can run", () => {
  for (const budget of [undefined, 0, 61, 5.5]) {
    const invalid = structuredClone(config);
    if (budget === undefined) delete invalid.targets[0].budget_minutes;
    else invalid.targets[0].budget_minutes = budget;
    assert.throws(() => validatePatrolConfig(invalid), /budget_minutes/);
  }
});

test("manual and onboarding-style runs are permanently provisional", () => {
  const manual = buildPatrolPlan(
    config,
    {
      ...context,
      event_name: "workflow_dispatch",
      event_schedule: null,
      requested_repository: "all",
    },
    observations
  );
  assert.equal(manual.matrix.include.length, 2);
  assert.ok(manual.matrix.include.every((entry) => entry.provisional === true));
  assert.ok(manual.matrix.include.every((entry) => entry.calibration_eligible === false));
  assert.ok(manual.matrix.include.every((entry) => entry.automatic_filing_eligible === false));
});

test("policy fingerprints are stable for repeat reports at the same evidence", () => {
  const first = buildPatrolPlan(config, context, observations);
  const second = buildPatrolPlan(
    config,
    { ...context, now: "2026-08-04T12:01:00.000Z" },
    observations
  );
  assert.equal(first.decisions[0].decision_fingerprint, second.decisions[0].decision_fingerprint);
});

test("exact-head revalidation fails closed on moving heads and exhausted budgets", () => {
  const exact = revalidatePatrol({
    repository: "aiosbrain/aios-workspace",
    default_branch: "main",
    expected_sha: WORKSPACE_SHA,
    observed_sha: WORKSPACE_SHA,
    started_at: "2026-08-04T12:00:00.000Z",
    checked_at: "2026-08-04T12:04:00.000Z",
    budget_minutes: 5,
  });
  assert.equal(exact.decision, "run");
  assert.equal(exact.exact_head, true);

  const moved = revalidatePatrol({
    ...exact,
    expected_sha: WORKSPACE_SHA,
    observed_sha: BRAIN_SHA,
    started_at: "2026-08-04T12:00:00.000Z",
    checked_at: "2026-08-04T12:04:00.000Z",
    budget_minutes: 5,
  });
  assert.equal(moved.decision, "stop");
  assert.ok(moved.reason_codes.includes("moving_head_detected"));

  const exhausted = revalidatePatrol({
    ...exact,
    expected_sha: WORKSPACE_SHA,
    observed_sha: WORKSPACE_SHA,
    started_at: "2026-08-04T12:00:00.000Z",
    checked_at: "2026-08-04T12:05:00.000Z",
    budget_minutes: 5,
  });
  assert.equal(exhausted.decision, "stop");
  assert.ok(exhausted.reason_codes.includes("scan_budget_exhausted"));
});

test("live observation normalizes GitHub success, HTTP failure, and transport failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.endsWith("/aiosbrain/aios-workspace")) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: WORKSPACE_SHA } }), { status: 200 });
      }
      return new Response(JSON.stringify([{}, {}, {}]), { status: 200 });
    };
    assert.deepEqual(await observeTarget(config.targets[0], "fixture-token"), {
      default_branch: "main",
      head_sha: WORKSPACE_SHA,
      open_pr_count: 3,
    });

    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    assert.deepEqual(await observeTarget(config.targets[0], "fixture-token"), {
      error_code: "github_http_403",
    });

    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.deepEqual(await observeTarget(config.targets[0], "fixture-token"), {
      error_code: "github_observation_failed",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plan and revalidation CLIs persist immutable exact-head artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "debt-patrol-policy-cli-"));
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const observationsPath = path.join(dir, "observations.json");
  const planPath = path.join(dir, "plan.json");
  const githubOutputPath = path.join(dir, "github-output.txt");
  const revalidationPath = path.join(dir, "revalidation.json");
  writeFileSync(observationsPath, `${JSON.stringify(observations)}\n`);
  try {
    const planArgs = [
      PLAN_SCRIPT,
      "--config",
      path.join(ROOT, "config/debt-patrol.v1.json"),
      "--output",
      planPath,
      "--github-output",
      githubOutputPath,
      "--event",
      "workflow_dispatch",
      "--repository",
      "all",
      "--workflow-ref",
      "refs/heads/main",
      "--enabled",
      "1",
      "--paused",
      "0",
      "--observations",
      observationsPath,
    ];
    const planRun = spawnSync(process.execPath, planArgs, { encoding: "utf8" });
    assert.equal(planRun.status, 0, planRun.stderr);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(plan.matrix.include.length, 2);
    assert.ok(plan.matrix.include.every((entry) => entry.provisional));
    assert.match(readFileSync(githubOutputPath, "utf8"), /has_runs=true/);
    const immutablePlanRun = spawnSync(process.execPath, planArgs, { encoding: "utf8" });
    assert.notEqual(immutablePlanRun.status, 0, "existing plan artifact must not be overwritten");

    const revalidateRun = spawnSync(
      process.execPath,
      [
        REVALIDATE_SCRIPT,
        "--repository",
        "aiosbrain/aios-workspace",
        "--branch",
        "main",
        "--expected-sha",
        WORKSPACE_SHA,
        "--observed-sha",
        WORKSPACE_SHA,
        "--started-at",
        startedAt,
        "--budget-minutes",
        "30",
        "--output",
        revalidationPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(revalidateRun.status, 0, revalidateRun.stderr);
    assert.equal(JSON.parse(readFileSync(revalidationPath, "utf8")).decision, "run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
