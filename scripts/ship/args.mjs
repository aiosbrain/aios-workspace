/**
 * ship/args.mjs — the CLI-argument contract for `aios ship`: what every flag means, how the
 * parsed options are validated, and the dry-run report that echoes the resolved plan back to the
 * operator without side effects.
 *
 * This module owns the invariant that a bad/contradictory flag combination is caught here, before
 * any network or git side effect — `validateShipArgs` is the single gate between `parseShipArgs`
 * and everything downstream (e.g. the spec gate can never be silently turned off under `--loop
 * light`, an emptied `--reviewers` list is rejected rather than defaulting away).
 *
 * Extracted verbatim from scripts/ship.mjs (AIO-560, wave 5 of the safety-unit-extraction pattern
 * — docs/v1-operator-loop/domains/safety-unit-extraction.md). No flag default, validation branch,
 * or reviewer/loop policy is edited in this move.
 */
import { c } from "../relay-core.mjs";
import { SPEC_GATE_POLICIES } from "../spec-eval.mjs";
import { SHIP_EXIT } from "./gates.mjs";

const DEFAULT_REVIEWERS = ["gpt-5.5"];
// Local Bugbot is mandatory and outside reviewer selection. `bugbot` remains accepted only as
// a deprecated no-op alias so existing commands keep working while `coderabbit` and `gpt-5.5`
// select the optional remote/model reviewers.
const KNOWN_REVIEWERS = new Set(["bugbot", "coderabbit", "gpt-5.5"]);
const DEFAULT_MAX_FIX_ROUNDS = 3;
const ISSUE_RE = /^AIO-\d+$/;
export function parseShipArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const valueFlags = [
    "--reviewers",
    "--max-fix-rounds",
    "--plan-runner",
    "--loop",
    "--spec-gate",
    "--builder-skill",
  ];
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1])
  );
  const issue = positional[0] ?? null;

  const reviewersRaw = flag("--reviewers");
  const reviewers = reviewersRaw
    ? reviewersRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_REVIEWERS];

  const maxFixRaw = parseInt(flag("--max-fix-rounds") ?? String(DEFAULT_MAX_FIX_ROUNDS), 10);
  const maxFixRounds =
    Number.isFinite(maxFixRaw) && maxFixRaw > 0 ? maxFixRaw : DEFAULT_MAX_FIX_ROUNDS;

  const planRunner = flag("--plan-runner") ?? "cli";
  const loop = flag("--loop") ?? "full";
  // spec_gate enforcement policy: null here means "not overridden on the CLI" → spec frontmatter or
  // the config default decides. --skip-spec-gate remains a back-compat alias for `off`.
  const specGate = flag("--spec-gate");
  const builderSkills = args
    .flatMap((arg, index) => (arg === "--builder-skill" ? [args[index + 1]] : []))
    .filter(Boolean);

  return {
    help: hasFlag("--help") || hasFlag("-h"),
    issue,
    auto: hasFlag("--auto"),
    autoMerge: hasFlag("--auto-merge"),
    reviewers,
    deprecatedBugbotReviewer: reviewers.includes("bugbot"),
    maxFixRounds,
    planRunner,
    loop,
    specGate,
    builderSkills,
    dryRun: hasFlag("--dry-run"),
    noSimplify: hasFlag("--no-simplify"),
    resume: hasFlag("--resume"),
    approvePlan: hasFlag("--approve-plan"),
    approveMerge: hasFlag("--approve-merge"),
    skipSpecGate: hasFlag("--skip-spec-gate"),
  };
}
export function builderSkillCheckpoint(context) {
  return {
    source: context.source,
    bytes: context.bytes,
    skills: context.audit,
  };
}
export function builderSkillCheckpointMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
// Validate parsed args, returning an error string (→ USAGE) or null.
export function validateShipArgs(opts) {
  if (!opts.issue) return "an issue id is required: aios ship AIO-<n>";
  if (!ISSUE_RE.test(opts.issue))
    return `invalid issue id '${opts.issue}' — expected AIO-<number>.`;
  // Two plan-stage runners (§3.4): `cli` (default) drives the planner via callClaudeAgent, which
  // strips ANTHROPIC_API_KEY and uses Claude Code login auth. `sdk` drives Opus through the
  // Anthropic SDK (relay.mjs's callOpus) and REQUIRES a funded ANTHROPIC_API_KEY — documented
  // caveat, and why cli is the default (the operator/Hermes dotenvx key has no API credits).
  if (opts.planRunner !== "cli" && opts.planRunner !== "sdk")
    return `unsupported --plan-runner '${opts.planRunner}' — expected 'cli' or 'sdk'.`;
  // Loop shapes (AIO-398): `full` (default — plan loop + reviews) or `light` (plan/plan_review
  // skipped for SPEC_READY specs; deterministic spec gate at entry; profile-pinned models).
  if (opts.loop !== "full" && opts.loop !== "light")
    return `unsupported --loop '${opts.loop}' — expected 'full' or 'light'.`;
  // spec_gate is the enforcement policy: block (stop on NOT_READY) | advisory (warn + proceed) |
  // off (don't run the gate). --skip-spec-gate is a back-compat alias for `off`.
  if (opts.specGate != null && !SPEC_GATE_POLICIES.has(opts.specGate))
    return `unsupported --spec-gate '${opts.specGate}' — expected ${[...SPEC_GATE_POLICIES].join(", ")}.`;
  // The spec gate IS the light loop's entry contract ("you did spec right, now build faster").
  // `off`/`--skip-spec-gate` would leave it with no evidence at all → rejected. `advisory` still
  // RUNS and records the eval (it just doesn't block), so it satisfies the contract → allowed.
  const gateIsOff = opts.skipSpecGate || opts.specGate === "off";
  if (opts.loop === "light" && gateIsOff)
    return "the spec gate cannot be turned off under --loop light — it is the light loop's entry contract. Use --spec-gate advisory to run-and-warn without blocking.";
  // An explicitly-emptied reviewer list (e.g. `--reviewers ","` or `--reviewers " "`) would
  // silently disable every optional reviewer — reject it. Local Bugbot still remains mandatory. (A bare
  // `--reviewers ""` still falls back to the defaults in parseShipArgs; this catches the case
  // where a non-empty raw value normalizes to zero names.)
  if (!opts.reviewers.length)
    return `no reviewers resolved — --reviewers must name at least one of ${[...KNOWN_REVIEWERS].join(", ")}.`;
  const unknown = opts.reviewers.filter((r) => !KNOWN_REVIEWERS.has(r));
  if (unknown.length)
    return `unknown reviewer(s) ${unknown.join(", ")} — expected one of ${[...KNOWN_REVIEWERS].join(", ")}.`;
  return null;
}
// ── dry-run report ───────────────────────────────────────────────────────────────────────────
export function buildShipDryRunReport({
  issue,
  issueTitle,
  resolvedModels,
  gates,
  reviewers,
  planRunner,
  loop = "full",
  maxFixRounds,
}) {
  const stepLine = (name) => {
    const cfg = resolvedModels?.[name];
    if (!cfg) return `  ${name.padEnd(14)} (no model config)`;
    const bits = [cfg.model];
    if (cfg.effort) bits.push(`effort=${cfg.effort}`);
    if (cfg.timeoutMs) bits.push(`timeout=${cfg.timeoutMs / 1000}s`);
    return `  ${name.padEnd(14)} ${bits.join(" · ")}`;
  };
  const isLightLoop = loop === "light";
  const lines = [
    "",
    c.blue(`aios ship — dry-run for ${issue}${issueTitle ? `: ${issueTitle}` : ""}`),
    "",
    isLightLoop
      ? "Stages (spec eval → spec-derived build → PR → review → fix → merge → cleanup):"
      : "Stages (spec eval → plan → build → PR → review → fix → merge → cleanup):",
    ...(isLightLoop
      ? [
          "  1. spec eval     mandatory spec-readiness gate on the Linear issue body (EE5)",
          "  2. plan          derive build contract from Interfaces / Implementation / Acceptance",
          "  3. build         runBuild on an isolated worktree",
          "  4. PR            cmdPr push + open PR",
          "  5. review        mandatory Local Bugbot + optional CodeRabbit + GPT + consolidate",
          "  6. fix loop      re-build until CLEAR or --max-fix-rounds",
          "  6b. simplify     post-review cleanup pass (cheap model, verify-gated, advisory)",
          "  7. merge gate    CI + consolidator + safety review only when `safety: true`",
          "  8. cleanup       ff-only main → worktree remove → branch delete",
        ]
      : [
          "  1. recon         Linear + git-tracked files → context pack",
          "  2. spec eval     spec-readiness gate on the Linear issue body (EE5)",
          "  3. plan          plan loop → operator plan gate",
          "  4. follow-up     file `## Deferred` items as Linear children",
          "  5. build         runBuild on an isolated worktree",
          "  6. PR            cmdPr push + open PR",
          "  7. review        mandatory Local Bugbot + optional CodeRabbit + GPT + consolidate",
          "  8. fix loop      re-build until CLEAR or --max-fix-rounds",
          "  8b. simplify     post-review cleanup pass (cheap model, verify-gated, advisory)",
          "  9. merge gate    CI + consolidator + path-gated safety review + operator",
          " 10. cleanup       ff-only main → worktree remove → branch delete",
        ]),
    "",
    "Per-step models:",
    ...(isLightLoop ? [] : [stepLine("recon")]),
    stepLine("spec_eval"),
    ...(isLightLoop ? [] : [stepLine("plan"), stepLine("plan_review")]),
    stepLine("build"),
    stepLine("code_review"),
    stepLine("simplify"),
    stepLine("consolidate"),
    stepLine("orchestrate"),
    stepLine("safety_review"),
    stepLine("digest"),
    "",
    `Loop:         ${loop}`,
    `Plan runner:  ${planRunner}`,
    `Reviewers:    ${(reviewers ?? []).join(", ")} (Local Bugbot is always mandatory)`,
    `Max fix rounds: ${maxFixRounds}`,
    `Gates:        plan=${isLightLoop ? "skipped (spec-derived)" : gates.plan}  merge=${gates.merge}`,
    "",
    "SHIP_EXIT codes:",
    ...Object.entries(SHIP_EXIT).map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`),
    "",
  ];
  return lines.join("\n");
}
