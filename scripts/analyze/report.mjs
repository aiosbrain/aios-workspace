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

import { AXIS_LABELS } from "./aem.mjs";
import { AXIS_GUIDE } from "./guidance.mjs";

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
export function renderText(result, color) {
  const c = color || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const { window: win, tools, totals, placement } = result;
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
  L.push("");
  const w = placement.weakest;
  L.push(c.yellow(`  Biggest opportunity: ${AXIS_LABELS[w]} — ${AXIS_GUIDE[w].gloss}`));
  L.push(`    ${AXIS_GUIDE[w].steps[0]}`);
  L.push(c.dim("  Run `aios analyze --report` for a step-by-step plan on this."));
  L.push(
    c.dim("  Raw sessions stay on your machine — `aios analyze --push` shares only these scores.")
  );
  return L.join("\n");
}

/** Deep-dive coaching on the weakest axis (printed by --report). */
export function renderReport(result, color) {
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
  return L.join("\n");
}

/** Machine-readable shape (no raw events, no message text). */
export function toJson(result) {
  return {
    window: result.window,
    tools: result.tools,
    totals: result.totals,
    signals: result.signals,
    placement: result.placement,
    days: result.days.map((d) => ({ date: d.date, signals: d.signals, placement: d.placement })),
  };
}

/**
 * Build one team-tier daily-aggregate payload for POST /api/v1/metrics
 * (standalone endpoint). Carries ONLY ratios + counts + the provisional
 * placement: no tool names, no branch, no cwd, no message text. This is the
 * entire privacy surface.
 */
export function buildPushPayload(day, member) {
  return {
    member,
    metric: "aem-individual",
    date: day.date,
    window_days: 1,
    signals: {
      delegation_ratio: day.signals.delegation_ratio,
      correction_loop_avg: day.signals.correction_loop_avg,
      error_rate: day.signals.error_rate,
      cost_per_task: day.signals.cost_per_task,
      tokens_per_task: day.signals.tokens_per_task,
      cache_hit_rate: day.signals.cache_hit_rate,
      tool_diversity: day.signals.tool_diversity,
      verify_tool_rate: day.signals.verify_tool_rate,
      subagent_usage: day.signals.subagent_usage,
    },
    provisional: { spine: day.placement.spine, axes: day.placement.axes },
    sessions: day.signals.sessions,
    tasks: day.signals.tasks,
  };
}
