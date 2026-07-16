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

// ── band thresholds (named constants) ───────────────────────────────────────
// The exact rubric thresholds, lifted out of the scorers so the SAME numbers the
// scorer uses are the ones surfaced to the operator (next-belt gaps in AM6) — a
// static duplicate table would silently drift. Values are byte-identical to the
// prior inline arrays. MIRRORED in the brain scorer (aios-team-brain
// lib/metrics/maturity.ts): any change here must be reflected there too — the two
// must not diverge. Each is `[[min, score], …]` for `band()` (>= semantics),
// except cost which is inverted (<=), see COST_GOVERNANCE_THRESHOLDS.
export const VERIFICATION_BANDS = [
  [0.25, 4],
  [0.12, 3],
  [0.04, 2],
  [0.005, 1],
]; // verify_tool_rate
export const CONTEXT_HYGIENE_BANDS = [
  [0.7, 4],
  [0.5, 3],
  [0.3, 2],
  [0.05, 1],
]; // cache_hit_rate
export const AUTONOMY_BANDS = [
  [0.25, 4],
  [0.1, 3],
  [0.02, 2],
]; // delegation_ratio
export const LEARNING_BANDS = [
  [6, 3],
  [3, 2],
  [1, 1],
]; // tool_diversity (score capped at 3)
export const COST_GOVERNANCE_THRESHOLDS = [
  [40_000, 4],
  [90_000, 3],
  [180_000, 2],
]; // tokens_per_task (<=; inverted — lower is better; below the last bound → 1)

// ── per-axis scorers (each cites its rubric row) ────────────────────────────

// Verification: "Eyeballs output (0) · runs tests/build manually (2) · agent runs
// its own check (4)". Proxy: rate of verification-tool (Bash/shell) invocations —
// the agent running checks it can act on. (Command bodies are intentionally
// invisible, so this is coarse; documented as a proxy.)
export function scoreVerification(s) {
  return band(s.verify_tool_rate, VERIFICATION_BANDS);
}

// Context hygiene: "One long session (0) · /clears between tasks (2) · curated
// CLAUDE.md + subagents + compaction (4)". Proxy: prompt-cache hit rate — high
// reuse of a deliberately-maintained context.
export function scoreContextHygiene(s) {
  return band(s.cache_hit_rate, CONTEXT_HYGIENE_BANDS);
}

// Autonomy / leash: "Approves every action (0) · auto-accepts low-risk behind a
// check (2) · dials leash per risk, earns longer leash (4)". Proxy: delegation
// ratio (tokens spent in subagents) + active permission management.
export function scoreAutonomy(s) {
  const byDelegation = band(s.delegation_ratio, AUTONOMY_BANDS);
  const floor = s.subagent_usage > 0 || s.permission_events > 0 ? 1 : 0;
  return Math.max(byDelegation, floor);
}

// Learning / compounding: "Repeats corrections (0) · adds fixes to CLAUDE.md
// sometimes (2) · corrections feed back, builds skills (4)". Session logs can't
// observe rule write-back, so we use tool-diversity (building a toolbelt) as a
// weak proxy and CAP at 3 — true compounding needs cross-session evidence.
export function scoreLearning(s) {
  return Math.min(3, band(s.tool_diversity, LEARNING_BANDS));
}

// Cost & governance: "No cost sense (0) · aware of token cost (2) · token-
// efficient tooling, respects tier/permission (4)". Proxy: tokens per task
// (lower = more efficient) — inverted bands.
export function scoreCostGovernance(s) {
  // Bands over FRESH tokens/task (cache reads excluded). Tunable — calibrated for
  // agentic coding where tight fresh-context-per-task is the efficiency marker.
  if (s.tokens_per_task <= 0) return 0;
  for (const [max, score] of COST_GOVERNANCE_THRESHOLDS) {
    if (s.tokens_per_task <= max) return score;
  }
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

export const VERIFICATION_GATE = 1; // cap Spine at L3 when verification ≤ this
export const L5_SUBAGENT_MIN = 0.3; // subagent_usage floor in the L5 predicate

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
    s.subagent_usage >= L5_SUBAGENT_MIN
  ) {
    level = 5;
  }
  // HARD GATE: no climbing past L3 without verification.
  if (axes.verification <= VERIFICATION_GATE) level = Math.min(level, 3);
  return `L${level}`;
}

// ── next-belt gaps (AM6) ────────────────────────────────────────────────────
// Derived programmatically from spineLevel()'s OWN predicates + the band
// constants above — never a parallel level table. `nextSpineBlockers` reports the
// signal moves that unlock the NEXT Spine level, so what the operator is told to
// do is exactly what the scorer rewards.

/** Minimum raw value that reaches `score` in a `[[min,score],…]` (>=) band, or null. */
export function minForScore(bands, score) {
  const hit = bands.find(([, sc]) => sc === score);
  return hit ? hit[0] : null;
}

/** Max fresh tokens/task that still scores `score` on the inverted (<=) cost axis, or null. */
export function maxTokensForScore(score) {
  const hit = COST_GOVERNANCE_THRESHOLDS.find(([, sc]) => sc === score);
  return hit ? hit[0] : null;
}

// axis → the signal it reads + its band constant, for threshold lookups. cost is
// inverted (maxTokensForScore), so it carries no `bands` here.
const AXIS_SIGNAL = {
  verification: { signal: "verify_tool_rate", bands: VERIFICATION_BANDS },
  context_hygiene: { signal: "cache_hit_rate", bands: CONTEXT_HYGIENE_BANDS },
  autonomy: { signal: "delegation_ratio", bands: AUTONOMY_BANDS },
  learning: { signal: "tool_diversity", bands: LEARNING_BANDS },
  cost_governance: { signal: "tokens_per_task", bands: null },
};

// Requirements to reach each target level — a LITERAL MIRROR of spineLevel()'s
// predicates above. `any` = OR (reach either); `all` = every requirement.
//   L2: cost_governance>=2 OR learning>=1       (spineLevel line: the `||`)
//   L3: context_hygiene>=2                        (the compound `>=2` for L3)
//   L4: verification>=2 AND autonomy>=2           (the `&&` for L4)
//   L5: verification>=3 AND autonomy>=3 AND learning>=3 AND subagent_usage>=L5_SUBAGENT_MIN
// If spineLevel()'s predicates change, THIS table must change with it (the
// anti-drift test in test/maturity-week.test.mjs bumps each reported blocker to
// its neededValue and asserts spineLevel actually advances — it will fail here first).
const TARGET_REQS = {
  2: {
    mode: "any",
    reqs: [
      { axis: "cost_governance", score: 2 },
      { axis: "learning", score: 1 },
    ],
  },
  3: { mode: "all", reqs: [{ axis: "context_hygiene", score: 2 }] },
  4: {
    mode: "all",
    reqs: [
      { axis: "verification", score: 2 },
      { axis: "autonomy", score: 2 },
    ],
  },
  5: {
    mode: "all",
    reqs: [
      { axis: "verification", score: 3 },
      { axis: "autonomy", score: 3 },
      { axis: "learning", score: 3 },
      // Not an axis — a raw-signal floor. neededValue comes straight from the constant.
      { signal: "subagent_usage", value: L5_SUBAGENT_MIN },
    ],
  },
};

/**
 * The signal moves that unlock the operator's NEXT Spine level.
 * @param {Record<string,number>} axes  scoreAxes(signals) output
 * @param {Record<string,number>} signals  the folded signals
 * @returns {{target:("L2"|"L3"|"L4"|"L5"|null), mode:("any"|"all"|"done"), blockers:Array}}
 *   blocker: { axis, signal, current, currentScore, neededScore, neededValue }
 */
export function nextSpineBlockers(axes, signals) {
  const current = Number(spineLevel(axes, signals).slice(1)); // "L3" → 3
  if (current >= 5) return { target: null, mode: "done", blockers: [] };
  const target = current + 1;
  const { mode, reqs } = TARGET_REQS[target];

  const blockers = [];
  for (const req of reqs) {
    if (req.signal) {
      // Raw-signal floor (L5 subagent_usage): unmet when below the floor.
      const cur = Number(signals[req.signal]) || 0;
      if (cur >= req.value) continue;
      blockers.push({
        axis: "autonomy", // closest axis for grouping / ordering
        signal: req.signal,
        current: cur,
        currentScore: null,
        neededScore: null,
        neededValue: req.value,
      });
      continue;
    }
    const score = axes[req.axis];
    if (score >= req.score) continue; // already met — not a blocker
    const meta = AXIS_SIGNAL[req.axis];
    const neededValue =
      req.axis === "cost_governance"
        ? maxTokensForScore(req.score)
        : minForScore(meta.bands, req.score);
    blockers.push({
      axis: req.axis,
      signal: meta.signal,
      current: Number(signals[meta.signal]) || 0,
      currentScore: score,
      neededScore: req.score,
      neededValue,
    });
  }
  return { target: `L${target}`, mode, blockers };
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

// ── Attention card (NOT a 6th axis) ─────────────────────────────────────────
// A compact read on operating RHYTHM from the four sanity signals (metrics.mjs).
// Deliberately NOT an AEM axis: the 6th-lens research is EE8 (AIO-174). It never touches
// AXIS_LABELS / scoreAxes / spineLevel / placement, so the pinned baseline placement is
// unchanged. Bands are intentionally simple + commented; EE8 will calibrate them.

/**
 * @returns {{label:"Attention", metrics:{context_switch_rate:number, focus_block_avg_min:number,
 *   interrupts_per_hour:number, concurrent_sessions_peak:number}, reading:string}}
 */
export function attentionCard(signals) {
  const csr = signals.context_switch_rate ?? 0;
  const focus = signals.focus_block_avg_min ?? 0;
  const interrupts = signals.interrupts_per_hour ?? 0;
  const concurrency = signals.concurrent_sessions_peak ?? 0;
  return {
    label: "Attention",
    metrics: {
      context_switch_rate: csr,
      focus_block_avg_min: focus,
      interrupts_per_hour: interrupts,
      concurrent_sessions_peak: concurrency,
    },
    reading: attentionReading({ csr, focus, interrupts, concurrency }),
  };
}

// Simple bands (tunable in EE8):
//  - nothing timestamped → "no timestamped activity in window"
//  - high switching OR many concurrent sessions OR frequent interrupts → orchestration-heavy
//  - long focus blocks + low switching + few concurrent sessions → deep-work leaning
//  - otherwise → mixed
function attentionReading({ csr, focus, interrupts, concurrency }) {
  if (focus === 0 && csr === 0 && interrupts === 0 && concurrency === 0) {
    return "no timestamped activity in window";
  }
  const orchestrationHeavy = concurrency >= 3 || csr >= 4 || interrupts >= 4;
  const deepWork = focus >= 20 && csr < 2 && concurrency <= 2;
  if (orchestrationHeavy) return "orchestration-heavy — protect focus blocks";
  if (deepWork) return "deep-work leaning — long focus blocks, low switching";
  return "mixed — some focus, some context-switching";
}

// ── Context health card (NOT an AEM axis) ───────────────────────────────────
// A compact read on the repo/workspace's Context Engineering hygiene (toolkit
// staleness, tier/frontmatter coverage, broken links, etc — see
// scripts/context-health.mjs). Deliberately NOT an AEM axis and NEVER folded
// into scoreAxes/spineLevel/placement — it never touches AXIS_LABELS, session
// signals, or the pinned baseline placement. Input is the raw
// computeContextHealth() result (or null if the module was unavailable / threw);
// null in, null out.

/**
 * @param {?{mode:string, checks:Array, hardFailures:number, softMisses:number,
 *   score:number, summary:string}} ch
 * @returns {?{label:"Context health", metrics:{score:number, mode:string,
 *   hard_failures:number, soft_misses:number}, reading:string}}
 */
export function contextHealthCard(ch) {
  if (!ch) return null;
  return {
    label: "Context health",
    metrics: {
      score: ch.score,
      mode: ch.mode,
      hard_failures: ch.hardFailures,
      soft_misses: ch.softMisses,
    },
    reading: ch.summary,
  };
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
