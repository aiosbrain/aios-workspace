import { createHash } from "node:crypto";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const COVERAGE_SCRIPTS = new Set(["coverage", "test:coverage"]);

function invariant(condition, message) {
  if (!condition) throw new Error(`invalid debt patrol configuration: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b, "en"))
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

export function stableDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function validatePatrolConfig(config) {
  invariant(config && typeof config === "object" && !Array.isArray(config), "root must be object");
  invariant(config.schema_version === "1", "schema_version must be 1");
  invariant(/^\d+\.\d+\.\d+$/.test(config.policy_version), "policy_version must be semver");
  invariant(
    /^[A-Za-z0-9._/-]{1,120}$/.test(config.producer_default_branch),
    "producer_default_branch is invalid"
  );
  invariant(
    config.schedule_crons && typeof config.schedule_crons === "object",
    "schedule_crons must be object"
  );
  const scheduleNames = Object.keys(config.schedule_crons);
  invariant(scheduleNames.length > 0, "at least one schedule is required");
  for (const [name, cron] of Object.entries(config.schedule_crons)) {
    invariant(/^[a-z][a-z0-9_-]{0,31}$/.test(name), `invalid schedule name ${name}`);
    invariant(typeof cron === "string" && cron.trim().split(/\s+/).length === 5, `${name} cron`);
  }
  invariant(Array.isArray(config.targets) && config.targets.length > 0, "targets must be nonempty");
  invariant(config.targets.length <= 20, "target count exceeds 20");
  const repositories = new Set();
  const slugs = new Set();
  for (const target of config.targets) {
    invariant(REPOSITORY_RE.test(target.repository), `invalid repository ${target.repository}`);
    invariant(!repositories.has(target.repository), `duplicate repository ${target.repository}`);
    repositories.add(target.repository);
    invariant(SLUG_RE.test(target.slug), `invalid slug ${target.slug}`);
    invariant(!slugs.has(target.slug), `duplicate slug ${target.slug}`);
    slugs.add(target.slug);
    invariant(/^[A-Za-z0-9._/-]{1,120}$/.test(target.default_branch), `${target.slug} branch`);
    invariant(typeof target.enabled === "boolean", `${target.slug} enabled must be boolean`);
    invariant(
      Array.isArray(target.schedules) && target.schedules.length > 0,
      `${target.slug} schedules`
    );
    invariant(
      target.schedules.every((name) => scheduleNames.includes(name)),
      `${target.slug} references unknown schedule`
    );
    invariant(
      Number.isInteger(target.budget_minutes) &&
        target.budget_minutes >= 5 &&
        target.budget_minutes <= 60,
      `${target.slug} budget_minutes must be 5..60`
    );
    invariant(
      Number.isInteger(target.open_pr_cap) && target.open_pr_cap >= 0 && target.open_pr_cap <= 100,
      `${target.slug} open_pr_cap must be 0..100`
    );
    invariant(COVERAGE_SCRIPTS.has(target.coverage_script), `${target.slug} coverage_script`);
    invariant(
      Object.keys(target).every((key) =>
        [
          "repository",
          "slug",
          "default_branch",
          "enabled",
          "schedules",
          "budget_minutes",
          "open_pr_cap",
          "coverage_script",
        ].includes(key)
      ),
      `${target.slug} contains an unknown field`
    );
  }
  invariant(
    Object.keys(config).every((key) =>
      [
        "schema_version",
        "policy_version",
        "producer_default_branch",
        "schedule_crons",
        "targets",
      ].includes(key)
    ),
    "root contains an unknown field"
  );
  return config;
}

function scheduleNameFor(config, context) {
  if (context.event_name !== "schedule") return "manual";
  return (
    Object.entries(config.schedule_crons).find(
      ([, cron]) => cron === context.event_schedule
    )?.[0] ?? null
  );
}

function scheduleReasons(target, context, scheduleName) {
  if (context.event_name !== "schedule") return [];
  if (scheduleName === null) return ["unknown_schedule"];
  return target.schedules.includes(scheduleName) ? [] : ["schedule_not_enabled_for_target"];
}

function selectionReasons(target, context) {
  if (
    context.event_name !== "workflow_dispatch" ||
    !context.requested_repository ||
    context.requested_repository === "all" ||
    context.requested_repository === target.repository
  ) {
    return [];
  }
  return ["manual_target_not_selected"];
}

function observationReasons(target, observation) {
  if (observation?.error_code) return [observation.error_code];
  const reasons = [
    ...(observation?.default_branch !== target.default_branch ? ["default_branch_mismatch"] : []),
    ...(!SHA_RE.test(observation?.head_sha ?? "") ? ["head_resolution_failed"] : []),
  ];
  if (!Number.isInteger(observation?.open_pr_count) || observation.open_pr_count < 0) {
    reasons.push("open_pr_count_unavailable");
  } else if (observation.open_pr_count > target.open_pr_cap) {
    reasons.push("open_pr_cap_exceeded");
  }
  return reasons;
}

function decisionFor(config, target, context, observation) {
  const schedule_name = scheduleNameFor(config, context);
  const reason_codes = [
    ...(context.producer_enabled !== true ? ["producer_opt_in_missing"] : []),
    ...(context.producer_unpaused !== true ? ["producer_pause_not_explicitly_disabled"] : []),
    ...(context.workflow_ref !== `refs/heads/${config.producer_default_branch}`
      ? ["producer_ref_not_default_branch"]
      : []),
    ...(!target.enabled ? ["target_not_opted_in"] : []),
    ...scheduleReasons(target, context, schedule_name),
    ...selectionReasons(target, context),
    ...observationReasons(target, observation),
  ];

  const provisional = context.event_name !== "schedule";
  const core = {
    repository: target.repository,
    slug: target.slug,
    default_branch: target.default_branch,
    resolved_sha: SHA_RE.test(observation?.head_sha ?? "") ? observation.head_sha : null,
    observed_default_branch: observation?.default_branch ?? null,
    observed_open_pr_count: Number.isInteger(observation?.open_pr_count)
      ? observation.open_pr_count
      : null,
    schedule_name,
    provisional,
    calibration_eligible: !provisional && reason_codes.length === 0,
    automatic_filing_eligible: false,
    budget_minutes: target.budget_minutes,
    open_pr_cap: target.open_pr_cap,
    coverage_script: target.coverage_script,
    decision: reason_codes.length === 0 ? "run" : "stop",
    reason_codes,
  };
  return { ...core, decision_fingerprint: stableDigest(core) };
}

export function buildPatrolPlan(configInput, context, observations = {}) {
  const config = validatePatrolConfig(structuredClone(configInput));
  invariant(
    ["schedule", "workflow_dispatch"].includes(context.event_name),
    "event_name must be schedule or workflow_dispatch"
  );
  const generatedAt = context.now ?? new Date().toISOString();
  const decisions = config.targets.map((target) =>
    decisionFor(config, target, context, observations[target.repository])
  );
  const matrix = {
    include: decisions
      .filter((decision) => decision.decision === "run")
      .map((decision) => ({
        repository: decision.repository,
        slug: decision.slug,
        default_branch: decision.default_branch,
        resolved_sha: decision.resolved_sha,
        schedule_name: decision.schedule_name,
        provisional: decision.provisional,
        calibration_eligible: decision.calibration_eligible,
        automatic_filing_eligible: false,
        budget_minutes: decision.budget_minutes,
        open_pr_cap: decision.open_pr_cap,
        observed_open_pr_count: decision.observed_open_pr_count,
        coverage_script: decision.coverage_script,
        decision: decision.decision,
        reason_codes: decision.reason_codes,
        decision_fingerprint: decision.decision_fingerprint,
        planned_at: generatedAt,
      })),
  };
  return {
    schema_version: "1",
    policy_version: config.policy_version,
    event_name: context.event_name,
    event_schedule: context.event_schedule ?? null,
    requested_repository: context.requested_repository ?? null,
    workflow_ref: context.workflow_ref ?? null,
    producer_enabled: context.producer_enabled === true,
    producer_unpaused: context.producer_unpaused === true,
    generated_at: generatedAt,
    decisions,
    matrix,
  };
}

export function isExactSha(value) {
  return SHA_RE.test(value);
}
