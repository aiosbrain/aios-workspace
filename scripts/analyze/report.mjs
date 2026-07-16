/**
 * report.mjs — render the AEM analysis (text + JSON + --report deep dive) and
 * build the push payload.
 *
 * The push payload is the ONLY thing that crosses the tier boundary: ratios +
 * scores + counts for a single UTC day. No tool names, no branch, no cwd, no
 * per-session detail, no message text. See docs/brain-api.md POST /metrics.
 *
 * Zero dependencies.
 */

import { AXIS_LABELS, attentionCard, contextHealthCard } from "./aem.mjs";
import {
  scoreCognitiveErgonomics,
  ergonomicsBaseline,
  AXIS_LABEL_ERGONOMICS,
} from "./ergonomics.mjs";
import { AXIS_GUIDE, ergonomicsTip, contextHealthTip } from "./guidance.mjs";

// Plain-English meaning of each Spine level (so "Spine L4" actually says something).
const SPINE_GLOSS = {
  L1: "Prompting — you ask, and take what comes back",
  L2: "Prompt Engineering — reusable prompts, and you review the diffs",
  L3: "Context Engineering — you manage the agent's context and tools deliberately",
  L4: "Agentic Engineering — agents run against checks, and you review the work",
  L5: "Agentic Orchestration — multiple agents, your own evals, feedback loops",
};

function bar(score) {
  const filled = Math.round(score); // 0..4
  return "█".repeat(filled) + "░".repeat(4 - filled);
}

function fmtNum(n, dp = 2) {
  return Number.isFinite(n) ? n.toFixed(dp) : "0";
}

function pct(x) {
  return `${Math.round((Number(x) || 0) * 100)}%`;
}

function fmtTokens(n) {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

// ── Cognitive Ergonomics SHADOW helpers (AIO-190 Phase A) ───────────────────
// One formula, shared by the JSON shape, the text render, and (W5) the
// calibration corpus. SHADOW-only: never an axis, never in placement, never
// pushed. Each per-day band scores that day against the trailing baseline of
// the days strictly BEFORE it; the rollup scores the window's own signals
// against the baseline of all its days. Exported for W5 calibration reuse.

/** Per-day CE shadow bands for a window: `[{ date, band }]`, band an int 0–4 or null. */
export function shadowBands(days) {
  const list = days || [];
  return list.map((d, i) => ({
    date: d.date,
    band: scoreCognitiveErgonomics(d.signals, ergonomicsBaseline(list.slice(0, i))),
  }));
}

/** Window rollup CE shadow band: window signals vs the baseline of all its days. */
export function shadowRollup(signals, days) {
  return scoreCognitiveErgonomics(signals, ergonomicsBaseline(days || []));
}

// Sparkline levels for a 0–4 band; null/non-finite → the no-data dot.
const SPARK_GLYPHS = ["▁", "▂", "▄", "▆", "█"];
function sparkGlyph(v) {
  if (v == null || !Number.isFinite(v)) return "·";
  return SPARK_GLYPHS[Math.max(0, Math.min(4, Math.round(v)))];
}

/** ↗ / ↘ / → from the last two non-null per-day bands (→ when < 2 exist). */
function ceTrendArrow(bands) {
  const vals = bands.map((b) => b.band).filter((v) => v != null);
  if (vals.length < 2) return "→";
  const last = vals[vals.length - 1];
  const prev = vals[vals.length - 2];
  return last > prev ? "↗" : last < prev ? "↘" : "→";
}

/** A plain-language stat line for an axis, drawn from its signals. */
function plainStat(key, s) {
  switch (key) {
    case "verification":
      return `the agent ran a verifiable check (tests / build / shell) in ${pct(s.verify_tool_rate)} of its tool calls`;
    case "context_hygiene":
      return `${pct(s.cache_hit_rate)} of context was reused from cache (higher = more focused, stable context)`;
    case "autonomy":
      return `${pct(s.delegation_ratio)} of work was delegated to sub-agents; ${pct(s.subagent_usage)} of sessions used one`;
    case "learning":
      return `${fmtNum(s.tool_diversity, 1)} distinct tools per session (a proxy for your toolbelt; capped at 3 — logs can't see CLAUDE.md/skill growth)`;
    case "cost_governance":
      return `$${fmtNum(s.cost_per_task)} and ${fmtTokens(s.tokens_per_task)} fresh tokens per task`;
    default:
      return "";
  }
}

/** Default terminal report — human-readable, every axis self-explaining. */
export function renderText(result, color, contextHealth) {
  const c = color || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const { window: win, tools, totals, placement, signals } = result;
  const L = [];
  L.push(`AIOS analyze — ${win.since} → ${win.until} (${tools.join(", ")})`);
  L.push(
    c.dim(
      `  ${totals.sessions} sessions · ${totals.tasks} tasks · ${fmtTokens(totals.total_tokens)} tokens`
    )
  );
  L.push("");
  L.push(`You're at Spine ${placement.spine} — ${SPINE_GLOSS[placement.spine] || ""}`);
  L.push(c.dim(`  overall ${fmtNum(placement.overall)}/4 · each axis scored 0–4`));
  L.push("");
  for (const [key, label] of Object.entries(AXIS_LABELS)) {
    const score = placement.axes[key];
    L.push(`  ${label.padEnd(22)} ${bar(score)} ${fmtNum(score, 1)}  ${AXIS_GUIDE[key].gloss}`);
  }
  // Cognitive ergonomics — SHADOW band (AIO-190 Phase A). Rendered beside the
  // axes but deliberately NOT a maturity axis: uncalibrated, local-only, never
  // pushed, and scored vs the operator's OWN baseline (not an absolute bar).
  const ceDays = result.days || [];
  const ceBands = shadowBands(ceDays);
  const ceRollup = shadowRollup(signals, ceDays);
  if (ceRollup == null) {
    L.push(
      `  ${AXIS_LABEL_ERGONOMICS.padEnd(22)} ${"·".repeat(4)} –  ` +
        c.dim("(shadow — needs 5 active days of baseline first)")
    );
  } else {
    L.push(
      `  ${AXIS_LABEL_ERGONOMICS.padEnd(22)} ${bar(ceRollup)} ${ceRollup}/4 ${ceTrendArrow(
        ceBands
      )}  ` + c.dim("(shadow — vs your own baseline, uncalibrated, local-only)")
    );
  }
  // 14-day AM-vs-CE dual sparkline (skipped with < 2 days; same window so the
  // two rows' columns line up day-for-day).
  if (ceDays.length >= 2) {
    const win = ceDays.slice(-14);
    const winBands = ceBands.slice(-14);
    const amRow = win.map((d) => sparkGlyph(d.placement && d.placement.overall)).join("");
    const ceRow = win.map((_, i) => sparkGlyph(winBands[i].band)).join("");
    L.push(`  ${String(win.length)}-day trend  (AM = maturity · CE = ergonomics shadow)`);
    L.push(`    AM  ${amRow}`);
    L.push(`    CE  ${ceRow}`);
    L.push(c.dim("    · = no data"));
  }
  L.push("");
  // Attention card — a compact read on operating rhythm (local-only sanity signals; NOT an axis).
  const att = attentionCard(signals || {});
  const m = att.metrics;
  L.push(`  Attention — ${att.reading}`);
  L.push(
    c.dim(
      `    context switches/hr ${fmtNum(m.context_switch_rate)}  ·  focus block avg ${fmtNum(
        m.focus_block_avg_min,
        1
      )}m  ·  interrupts/hr ${fmtNum(m.interrupts_per_hour)}  ·  peak concurrent sessions ${
        m.concurrent_sessions_peak
      }`
    )
  );
  L.push("");
  // Context health card — SHADOW, repo/workspace hygiene, NEVER an axis. Renders
  // only when the check ran (contextHealth non-null); silently omitted otherwise
  // so a missing/failed check never breaks the report.
  const chCard = contextHealthCard(contextHealth);
  if (chCard) {
    L.push(`  Context health — ${chCard.metrics.score}/4 — ${chCard.reading}`);
    const failing = (contextHealth.checks || []).filter((chk) => !chk.ok).slice(0, 3);
    if (failing.length) {
      L.push(c.dim(`    ${failing.map((f) => f.label).join(" · ")}`));
    }
  }
  L.push("");
  const w = placement.weakest;
  L.push(c.yellow(`  Biggest opportunity: ${AXIS_LABELS[w]} — ${AXIS_GUIDE[w].gloss}`));
  L.push(`    ${AXIS_GUIDE[w].steps[0]}`);
  const ceTip = ergonomicsTip(att.reading);
  if (ceTip) L.push(c.dim(`  Cognitive ergonomics (shadow): ${ceTip}`));
  L.push(c.dim("  Run `aios analyze --report` for a step-by-step plan on this."));
  L.push(
    c.dim("  Raw sessions stay on your machine — `aios analyze --push` shares only these scores.")
  );
  return L.join("\n");
}

/** Deep-dive coaching on the weakest axis (printed by --report). */
export function renderReport(result, color, contextHealth) {
  const c = color || { dim: (s) => s, green: (s) => s, yellow: (s) => s, bold: (s) => s };
  const { placement, signals } = result;
  const w = placement.weakest;
  const g = AXIS_GUIDE[w];
  const L = [];
  L.push("");
  L.push("──────────────────────────────────────────────────────────");
  L.push(`  DEEP DIVE — ${AXIS_LABELS[w]}  (your weakest axis, ${fmtNum(placement.axes[w], 1)}/4)`);
  L.push("──────────────────────────────────────────────────────────");
  L.push("");
  L.push(c.yellow("  What it means"));
  L.push(`    ${g.meaning}`);
  L.push("");
  L.push(c.yellow("  Why it matters"));
  L.push(`    ${g.why}`);
  L.push("");
  L.push(c.yellow("  Where you are"));
  L.push(`    Score ${fmtNum(placement.axes[w], 1)}/4 — ${plainStat(w, signals)}.`);
  L.push("");
  L.push(c.yellow("  What to do next"));
  g.steps.forEach((step, i) => L.push(`    ${i + 1}. ${step}`));
  L.push("");
  L.push(c.dim("  Your other axes:"));
  for (const [key, label] of Object.entries(AXIS_LABELS)) {
    if (key === w) continue;
    L.push(
      c.dim(
        `    ${label.padEnd(22)} ${fmtNum(placement.axes[key], 1)}/4 — ${plainStat(key, signals)}`
      )
    );
  }
  // Context health SHADOW coaching — only when the check ran AND is in a bad
  // enough band (score <= 2) to warrant a nudge. Never touches the axis coaching
  // above; purely additive.
  const chCard = contextHealthCard(contextHealth);
  if (chCard && chCard.metrics.score <= 2) {
    L.push("");
    L.push(c.yellow("  Context health (shadow)"));
    L.push(`    ${chCard.reading}`);
    const tip = contextHealthTip(chCard.metrics.score);
    if (tip) L.push(`    ${tip}`);
  }
  return L.join("\n");
}

/** Machine-readable shape (no raw events, no message text). */
export function toJson(result, costData, contextHealth) {
  const days = result.days || [];
  const bands = shadowBands(days);
  const out = {
    window: result.window,
    tools: result.tools,
    totals: result.totals,
    signals: result.signals,
    placement: result.placement,
    // Phase A SHADOW band for the candidate 6th axis (AIO-190): recorded for the
    // calibration corpus only — NEVER inside placement.axes, never pushed. Each
    // day scores against the trailing baseline of the days BEFORE it; the rollup
    // scores the window signals against the window's trailing baseline.
    axes_shadow: {
      cognitive_ergonomics: shadowRollup(result.signals, days),
    },
    // Local-only attention card (never pushed) — the 4 sanity signals + a human reading.
    attention: attentionCard(result.signals || {}),
    days: days.map((d, i) => ({
      date: d.date,
      signals: d.signals,
      placement: d.placement,
      axes_shadow: {
        cognitive_ergonomics: bands[i].band,
      },
    })),
  };
  // Context health SHADOW card (repo/workspace hygiene) — omitted entirely when
  // the check didn't run / threw (contextHealth is null), same pattern as `costs`.
  const chCard = contextHealthCard(contextHealth);
  if (chCard) {
    out.context_health = chCard;
  }
  if (costData) {
    out.costs = {
      cursor: costData.cursor
        ? {
            totals: costData.cursor.totals,
            days: costData.cursor.days,
            truncated: !!costData.cursor.truncated,
          }
        : null,
      claude: costData.claude,
      codex: costData.codex || null,
      opencode: costData.opencode || null,
      // Real billed API-key $ (admin cost API) + flat subscription plan.
      anthropic: costData.anthropic || null,
      plan: costData.plan || null,
      cursor_error: costData.cursor_error || null,
      anthropic_error: costData.anthropic_error || null,
    };
  }
  return out;
}

/**
 * Precompute the Session Pulse Stop hook's entire read — same privacy class as
 * the gitignored analyze-state file (derived scores + tips only, no raw events
 * or tool names). Resolved at analyze time so the hook is a dumb instant reader
 * with no scoring logic of its own (W3, AIO-214).
 */
export function buildLastSummary(result, contextHealth) {
  const { placement, signals, window: win, days } = result;
  const w = placement.weakest;
  const att = attentionCard(signals || {});
  const summary = {
    generated_at: new Date().toISOString(),
    window: win,
    spine: placement.spine,
    overall: placement.overall,
    weakest: w,
    weakest_tip: AXIS_GUIDE[w].steps[0],
    ce_band: shadowRollup(signals, days || []),
    attention_reading: att.reading,
    ce_tip: ergonomicsTip(att.reading),
  };
  const chCard = contextHealthCard(contextHealth);
  if (chCard) summary.context_health_score = chCard.metrics.score;
  return summary;
}

/** Find a context-health check by id and return its raw `value`, or null. */
function checkValue(checks, id) {
  const hit = (checks || []).find((c) => c.id === id);
  return hit ? hit.value : null;
}

/**
 * Derive the scalars-only `context_health` push object from a
 * computeContextHealth() result, or null if the check didn't run.
 * Never includes paths/filenames/detail strings — see docs/brain-api.md.
 */
function contextHealthPushFields(ch) {
  if (!ch) return null;
  const checks = ch.checks || [];
  const versionsBehind = ch.mode === "workspace" ? checkValue(checks, "toolkit-staleness") : null;
  const coveragePct =
    ch.mode === "workspace"
      ? checkValue(checks, "tier-coverage")
      : checkValue(checks, "claude-coverage");
  const brokenLinkCount = checkValue(checks, "broken-links") ?? 0;
  return {
    score: ch.score,
    mode: ch.mode,
    drift_count: ch.hardFailures,
    versions_behind: versionsBehind,
    coverage_pct: coveragePct,
    broken_link_count: brokenLinkCount,
    checked_at: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Build one team-tier daily-aggregate payload for POST /api/v1/metrics
 * (standalone endpoint). Carries ratios + counts + the provisional placement,
 * plus the optional v1.3 ce_band shadow integer (0–4|null). No tool names, no
 * branch, no cwd, no message text, and none of the four raw attention signals.
 * `contextHealth` (optional) is the raw computeContextHealth() result — the
 * caller (pushDays, index.mjs) attaches it only to the most recent day's
 * payload; omitting it (or passing null/undefined) leaves the key absent.
 * This is the entire privacy surface.
 */
export function buildPushPayload(day, member, ceBand, contextHealth) {
  const payload = {
    member,
    metric: "aem-individual",
    date: day.date,
    window_days: 1,
    ce_band: ceBand ?? null,
    signals: {
      delegation_ratio: day.signals.delegation_ratio,
      correction_loop_avg: day.signals.correction_loop_avg,
      error_rate: day.signals.error_rate,
      cost_per_task: day.signals.cost_per_task,
      tokens_per_task: day.signals.tokens_per_task,
      total_cost_usd: day.signals.total_cost_usd,
      input_tokens: day.signals.input_tokens,
      output_tokens: day.signals.output_tokens,
      cache_read_tokens: day.signals.cache_read_tokens,
      cache_hit_rate: day.signals.cache_hit_rate,
      tool_diversity: day.signals.tool_diversity,
      verify_tool_rate: day.signals.verify_tool_rate,
      subagent_usage: day.signals.subagent_usage,
    },
    provisional: { spine: day.placement.spine, axes: day.placement.axes },
    sessions: day.signals.sessions,
    tasks: day.signals.tasks,
  };
  const chFields = contextHealthPushFields(contextHealth);
  if (chFields) payload.context_health = chFields;
  return payload;
}
