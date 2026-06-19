/**
 * metrics.mjs — NormalizedEvent[] → AEM signals (per session, rolled up).
 *
 * A "task" = one human-initiated turn (a user text prompt). Token usage is
 * summed across the assistant turns that follow. All signals are derivable from
 * the normalized schema alone — no message text needed.
 *
 * These signals are the ONLY thing that crosses the tier boundary (as daily
 * aggregates). They are ratios and counts, never raw content.
 *
 * Zero dependencies.
 */

import { totalTokens } from "./normalize.mjs";

// Coarse per-million-token USD price map (estimate only — for cost/task signal).
// Matched by substring against the model id; cache_read priced at ~0.1× input.
const PRICES = [
  { match: "opus",   in: 15,   out: 75,   cache_read: 1.5,  cache_create: 18.75 },
  { match: "sonnet", in: 3,    out: 15,   cache_read: 0.3,  cache_create: 3.75 },
  { match: "haiku",  in: 0.8,  out: 4,    cache_read: 0.08, cache_create: 1.0 },
  { match: "gpt",    in: 2.5,  out: 10,   cache_read: 0.25, cache_create: 2.5 },
  { match: "codex",  in: 2.5,  out: 10,   cache_read: 0.25, cache_create: 2.5 },
];
const DEFAULT_PRICE = { in: 3, out: 15, cache_read: 0.3, cache_create: 3.75 };

// Tool names that stand in for "the agent ran a check it can verify against".
// Coarse proxy: we can't see command bodies (by design), so Bash is the signal.
const VERIFY_TOOLS = new Set([
  "Bash", "shell", "run_terminal_cmd", "execute_command", // Claude / generic
  "exec_command", "local_shell_call", // Codex
]);

function priceFor(model) {
  if (!model) return DEFAULT_PRICE;
  const m = String(model).toLowerCase();
  return PRICES.find((p) => m.includes(p.match)) || DEFAULT_PRICE;
}

function eventCostUsd(ev) {
  if (!ev.tokens) return 0;
  const p = priceFor(ev.model);
  const t = ev.tokens;
  return (
    (t.in * p.in + t.out * p.out + t.cache_read * p.cache_read + t.cache_create * p.cache_create)
    / 1_000_000
  );
}

/** UTC day (YYYY-MM-DD) of an event; null when it has no usable timestamp. */
export function dayOf(ev) {
  if (!ev.ts) return null;
  const d = new Date(ev.ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Group events into UTC-day buckets → Map<"YYYY-MM-DD", NormalizedEvent[]>. */
export function bucketByDay(events) {
  const buckets = new Map();
  for (const ev of events) {
    const day = dayOf(ev) || "undated";
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(ev);
  }
  return buckets;
}

function ratio(n, d) {
  return d > 0 ? n / d : 0;
}

/**
 * Reduce a set of events into one signals object.
 * @returns {{
 *   sessions:number, tasks:number, events:number, total_tokens:number,
 *   delegation_ratio:number, correction_loop_avg:number, error_rate:number,
 *   cost_per_task:number, tokens_per_task:number, cache_hit_rate:number,
 *   tool_diversity:number, verify_tool_rate:number, subagent_usage:number,
 *   permission_events:number
 * }}
 */
export function computeSignals(events) {
  const bySession = new Map();
  for (const ev of events) {
    if (!bySession.has(ev.session_id)) bySession.set(ev.session_id, []);
    bySession.get(ev.session_id).push(ev);
  }

  let tasks = 0;
  let totalTok = 0;     // all four buckets (display/totals)
  let workTok = 0;      // in + out + cache_create — "fresh" effort, excludes cheap cache reads
  let subagentTok = 0;
  let sumIn = 0;
  let sumCacheRead = 0;
  let sumCacheCreate = 0;
  let totalCost = 0;
  let toolUseTotal = 0;
  let verifyToolUses = 0;
  let toolResults = 0;
  let toolResultErrors = 0;
  let permissionEvents = 0;
  let sessionsWithSubagent = 0;
  const diversityPerSession = [];

  for (const evs of bySession.values()) {
    const sessionTools = new Set();
    let sessionHasSubagent = false;
    for (const ev of evs) {
      if (ev.actor === "user" && ev.block_type === "text") tasks += 1;
      if (ev.tokens) {
        const tt = totalTokens(ev.tokens);
        totalTok += tt;
        workTok += ev.tokens.in + ev.tokens.out + ev.tokens.cache_create;
        sumIn += ev.tokens.in;
        sumCacheRead += ev.tokens.cache_read;
        sumCacheCreate += ev.tokens.cache_create;
        totalCost += eventCostUsd(ev);
        if (ev.actor === "subagent") subagentTok += tt;
      }
      if (ev.actor === "subagent") sessionHasSubagent = true;
      if (ev.block_type === "tool_use") {
        toolUseTotal += 1;
        if (ev.tool_name) sessionTools.add(ev.tool_name);
        if (ev.tool_name && VERIFY_TOOLS.has(ev.tool_name)) verifyToolUses += 1;
      }
      if (ev.block_type === "tool_result") {
        toolResults += 1;
        if (ev.is_error) toolResultErrors += 1;
      }
      if (ev.block_type === "permission" || ev.block_type === "mode") permissionEvents += 1;
    }
    diversityPerSession.push(sessionTools.size);
    if (sessionHasSubagent) sessionsWithSubagent += 1;
  }

  const sessions = bySession.size;
  const avgDiversity = diversityPerSession.length
    ? diversityPerSession.reduce((a, b) => a + b, 0) / diversityPerSession.length
    : 0;

  return {
    sessions,
    tasks,
    events: events.length,
    total_tokens: totalTok,
    delegation_ratio: ratio(subagentTok, totalTok),
    correction_loop_avg: ratio(toolResults, tasks),
    error_rate: ratio(toolResultErrors, toolResults),
    cost_per_task: ratio(totalCost, tasks),
    // "fresh" tokens per task — excludes cache reads (cheap, reflect context size
    // not work), so this is a fair efficiency signal for the Cost axis.
    tokens_per_task: ratio(workTok, tasks),
    // hit rate vs. ALL first-seen tokens (input + newly-cached), so it isn't
    // pinned at ~1.0 by accumulated reads.
    cache_hit_rate: ratio(sumCacheRead, sumCacheRead + sumIn + sumCacheCreate),
    tool_diversity: avgDiversity,
    verify_tool_rate: ratio(verifyToolUses, toolUseTotal),
    subagent_usage: ratio(sessionsWithSubagent, sessions),
    permission_events: permissionEvents,
  };
}
