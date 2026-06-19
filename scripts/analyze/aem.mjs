/**
 * aem.mjs — signals → AEM Individual axis scores + Spine level.
 *
 * Maps the metrics signals onto the rubric in
 *   agentic-engineering-maturity/04-assessment-rubrics.md §1 (Individual).
 * Five axes, each 0–4 (0 absent · 2 partial · 4 strong). Spine level L1–L5.
 *
 * CORE RULE (rubric §5 + §1): a scope's Spine level is CAPPED AT L3 if its
 * Verification axis scores ≤ 1 — "no real agentic maturity without verification".
 *
 * This is the LOCAL PROVISIONAL scorer. The brain recomputes the canonical score
 * from the same pushed signals (lib/metrics/maturity.ts), so this and the brain
 * must agree on thresholds — keep them in sync if either side changes.
 *
 * Thresholds are named constants with the rubric row they encode, so the spec
 * stays the source of truth and every score is auditable + unit-testable.
 *
 * Zero dependencies.
 */

/** Pick the score for the first threshold whose `min` the value clears. */
function band(value, bands) {
  for (const [min, score] of bands) {
    if (value >= min) return score;
  }
  return 0;
}

// ── per-axis scorers (each cites its rubric row) ────────────────────────────

// Verification: "Eyeballs output (0) · runs tests/build manually (2) · agent runs
// its own check (4)". Proxy: rate of verification-tool (Bash/shell) invocations —
// the agent running checks it can act on. (Command bodies are intentionally
// invisible, so this is coarse; documented as a proxy.)
export function scoreVerification(s) {
  return band(s.verify_tool_rate, [
    [0.25, 4],
    [0.12, 3],
    [0.04, 2],
    [0.005, 1],
  ]);
}

// Context hygiene: "One long session (0) · /clears between tasks (2) · curated
// CLAUDE.md + subagents + compaction (4)". Proxy: prompt-cache hit rate — high
// reuse of a deliberately-maintained context.
export function scoreContextHygiene(s) {
  return band(s.cache_hit_rate, [
    [0.7, 4],
    [0.5, 3],
    [0.3, 2],
    [0.05, 1],
  ]);
}

// Autonomy / leash: "Approves every action (0) · auto-accepts low-risk behind a
// check (2) · dials leash per risk, earns longer leash (4)". Proxy: delegation
// ratio (tokens spent in subagents) + active permission management.
export function scoreAutonomy(s) {
  const byDelegation = band(s.delegation_ratio, [
    [0.25, 4],
    [0.1, 3],
    [0.02, 2],
  ]);
  const floor = s.subagent_usage > 0 || s.permission_events > 0 ? 1 : 0;
  return Math.max(byDelegation, floor);
}

// Learning / compounding: "Repeats corrections (0) · adds fixes to CLAUDE.md
// sometimes (2) · corrections feed back, builds skills (4)". Session logs can't
// observe rule write-back, so we use tool-diversity (building a toolbelt) as a
// weak proxy and CAP at 3 — true compounding needs cross-session evidence.
export function scoreLearning(s) {
  return Math.min(
    3,
    band(s.tool_diversity, [
      [6, 3],
      [3, 2],
      [1, 1],
    ])
  );
}

// Cost & governance: "No cost sense (0) · aware of token cost (2) · token-
// efficient tooling, respects tier/permission (4)". Proxy: tokens per task
// (lower = more efficient) — inverted bands.
export function scoreCostGovernance(s) {
  // Bands over FRESH tokens/task (cache reads excluded). Tunable — calibrated for
  // agentic coding where tight fresh-context-per-task is the efficiency marker.
  if (s.tokens_per_task <= 0) return 0;
  if (s.tokens_per_task <= 40_000) return 4;
  if (s.tokens_per_task <= 90_000) return 3;
  if (s.tokens_per_task <= 180_000) return 2;
  return 1;
}

/** @returns {{verification:number,context_hygiene:number,autonomy:number,learning:number,cost_governance:number}} */
export function scoreAxes(s) {
  return {
    verification: scoreVerification(s),
    context_hygiene: scoreContextHygiene(s),
    autonomy: scoreAutonomy(s),
    learning: scoreLearning(s),
    cost_governance: scoreCostGovernance(s),
  };
}

export const AXIS_LABELS = {
  verification: "Verification",
  context_hygiene: "Context hygiene",
  autonomy: "Autonomy / leash",
  learning: "Learning / compounding",
  cost_governance: "Cost & governance",
};

const VERIFICATION_GATE = 1; // cap Spine at L3 when verification ≤ this

/**
 * Derive the Spine level (L1–L5) from axis scores + signals, then apply the
 * verification gate. See rubric §1 "Spine placement".
 * @returns {"L1"|"L2"|"L3"|"L4"|"L5"}
 */
export function spineLevel(axes, s) {
  let level = 1; // L1 Prompting — just type and take what comes back
  // L2 Prompt Engineering — deliberate, repeatable tool use / cost sense
  if (axes.cost_governance >= 2 || axes.learning >= 1) level = 2;
  // L3 Context Engineering — manages context deliberately (cache reuse proxy)
  if (axes.context_hygiene >= 2) level = 3;
  // L4 Agentic Engineering — runs agents against a check + reviews (verify+autonomy)
  if (axes.verification >= 2 && axes.autonomy >= 2) level = 4;
  // L5 Agentic Orchestration — multi-agent + own evals + feedback
  if (
    axes.autonomy >= 3 &&
    axes.verification >= 3 &&
    axes.learning >= 3 &&
    s.subagent_usage >= 0.3
  ) {
    level = 5;
  }
  // HARD GATE: no climbing past L3 without verification.
  if (axes.verification <= VERIFICATION_GATE) level = Math.min(level, 3);
  return `L${level}`;
}

/** Mean of the five axes (0–4), rounded to 2 dp. */
export function overallScore(axes) {
  const vals = Object.values(axes);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(mean * 100) / 100;
}

/** Weakest axis key — drives the "next pattern to work on" prescription. */
export function weakestAxis(axes) {
  return Object.entries(axes).sort((a, b) => a[1] - b[1])[0][0];
}

/** Full AEM placement for a signals object. */
export function placement(signals) {
  const axes = scoreAxes(signals);
  return {
    axes,
    spine: spineLevel(axes, signals),
    overall: overallScore(axes),
    weakest: weakestAxis(axes),
  };
}
