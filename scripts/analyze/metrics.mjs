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
  { match: "opus", in: 15, out: 75, cache_read: 1.5, cache_create: 18.75 },
  { match: "sonnet", in: 3, out: 15, cache_read: 0.3, cache_create: 3.75 },
  { match: "haiku", in: 0.8, out: 4, cache_read: 0.08, cache_create: 1.0 },
  { match: "gpt", in: 2.5, out: 10, cache_read: 0.25, cache_create: 2.5 },
  { match: "codex", in: 2.5, out: 10, cache_read: 0.25, cache_create: 2.5 },
];
const DEFAULT_PRICE = { in: 3, out: 15, cache_read: 0.3, cache_create: 3.75 };

// Tool names that stand in for "the agent ran a check it can verify against".
// Coarse proxy: we can't see command bodies (by design), so Bash is the signal.
const VERIFY_TOOLS = new Set([
  "Bash",
  "shell",
  "run_terminal_cmd",
  "execute_command", // Claude / generic
  "exec_command",
  "local_shell_call", // Codex
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
    (t.in * p.in + t.out * p.out + t.cache_read * p.cache_read + t.cache_create * p.cache_create) /
    1_000_000
  );
}

/** Sum estimated USD for assistant usage events (session-log cost estimates). */
export function totalCostUsd(events) {
  let sum = 0;
  for (const ev of events) {
    if (ev.actor === "assistant" || ev.actor === "subagent") sum += eventCostUsd(ev);
  }
  return sum;
}

/** Sum token counts from assistant usage events. */
export function totalTokensFromEvents(events) {
  let input = 0,
    output = 0,
    cache_read = 0;
  for (const ev of events) {
    if (!ev.tokens) continue;
    input += ev.tokens.in || 0;
    output += ev.tokens.out || 0;
    cache_read += ev.tokens.cache_read || 0;
  }
  return { input, output, cache_read, total: input + output + cache_read };
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

// Idle-gap threshold (minutes) for splitting the global activity timeline into focus blocks.
// SOURCE OF TRUTH: DEFAULT_IDLE_GAP_MIN in src/operator-loop/time/config.ts. Duplicated here as
// a literal (NOT imported) because metrics.mjs is plain ESM and must never import from dist/.
const IDLE_GAP_MIN = 25;
const FIVE_MIN_MS = 5 * 60_000;

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Attention / sanity signals over the GLOBAL event timeline (all sessions interleaved, events
 * with a usable `ts`, sorted ascending). Operationally defined — see
 * docs/v1-operator-loop/domains/sanity-metrics.md:
 *
 *  - active_hours (internal denominator): the sorted global timeline is split into blocks at gaps
 *    > IDLE_GAP_MIN; each block's duration = last.ts − first.ts with a FLOOR of 1 min per block
 *    (a single-event block counts as 1 min); active_hours = Σ block-min / 60.
 *  - focus_block_avg_min: mean block duration in minutes (2dp). 0 when no timestamped events.
 *  - context_switch_rate: count of transitions where `project` changes between CONSECUTIVE USER
 *    PROMPTS (actor==="user" && block_type==="text", both projects non-null, global ts order)
 *    / active_hours (2dp; 0 when active_hours is 0). Prompts are the human acting — raw-event
 *    transitions would count sub-second interleaving of concurrent sessions, which measures the
 *    machine, not the operator's attention.
 *  - interrupts_per_hour: user prompts that HOP sessions — events with actor==="user" &&
 *    block_type==="text" whose session_id differs from the previous such event — / active_hours
 *    (2dp). Measures attention-splitting across concurrent sessions (the ergonomics lever).
 *  - concurrent_sessions_peak: max distinct session_ids with ≥1 event in any single 5-min UTC
 *    bucket (integer).
 *
 * @returns {{active_hours:number, focus_block_avg_min:number, context_switch_rate:number,
 *   interrupts_per_hour:number, concurrent_sessions_peak:number}}
 */
export function computeAttentionSignals(events) {
  const timed = events
    .filter((e) => e.ts && Number.isFinite(new Date(e.ts).getTime()))
    .map((e) => ({ ev: e, ms: new Date(e.ts).getTime() }))
    .sort((a, b) => a.ms - b.ms);

  if (timed.length === 0) {
    return {
      active_hours: 0,
      focus_block_avg_min: 0,
      context_switch_rate: 0,
      interrupts_per_hour: 0,
      concurrent_sessions_peak: 0,
    };
  }

  const gapMs = IDLE_GAP_MIN * 60_000;

  // 1) Focus blocks: split the global timeline at idle gaps; floor each block at 1 min.
  const blockMins = [];
  let blockStart = timed[0].ms;
  let prev = timed[0].ms;
  for (let i = 1; i < timed.length; i++) {
    const t = timed[i].ms;
    if (t - prev > gapMs) {
      blockMins.push(Math.max(1, (prev - blockStart) / 60_000));
      blockStart = t;
    }
    prev = t;
  }
  blockMins.push(Math.max(1, (prev - blockStart) / 60_000));

  const totalBlockMin = blockMins.reduce((a, b) => a + b, 0);
  const activeHours = totalBlockMin / 60;
  const focusBlockAvgMin = totalBlockMin / blockMins.length;

  // 2) Context switches: project changes between consecutive USER PROMPTS (the human's
  //    attention thread) — not raw events, which interleave sub-second under concurrency.
  let switches = 0;
  let lastPromptProject = null;
  for (const { ev } of timed) {
    if (ev.actor !== "user" || ev.block_type !== "text" || ev.project == null) continue;
    if (lastPromptProject != null && ev.project !== lastPromptProject) switches += 1;
    lastPromptProject = ev.project;
  }

  // 3) Interrupts: session-hopping user text prompts.
  let interrupts = 0;
  let lastPromptSession = null;
  let seenPrompt = false;
  for (const { ev } of timed) {
    if (ev.actor === "user" && ev.block_type === "text") {
      if (seenPrompt && ev.session_id !== lastPromptSession) interrupts += 1;
      lastPromptSession = ev.session_id;
      seenPrompt = true;
    }
  }

  // 4) Concurrent sessions peak: max distinct session_ids sharing one 5-min UTC bucket.
  const bucketSessions = new Map(); // bucketIndex → Set<session_id>
  for (const { ev, ms } of timed) {
    const bucket = Math.floor(ms / FIVE_MIN_MS);
    let set = bucketSessions.get(bucket);
    if (!set) bucketSessions.set(bucket, (set = new Set()));
    set.add(ev.session_id);
  }
  let peak = 0;
  for (const set of bucketSessions.values()) peak = Math.max(peak, set.size);

  return {
    active_hours: round2(activeHours),
    focus_block_avg_min: round2(focusBlockAvgMin),
    context_switch_rate: activeHours > 0 ? round2(switches / activeHours) : 0,
    interrupts_per_hour: activeHours > 0 ? round2(interrupts / activeHours) : 0,
    concurrent_sessions_peak: peak,
  };
}

/**
 * Reduce a set of events into one signals object.
 * @returns {{
 *   sessions:number, tasks:number, events:number, total_tokens:number,
 *   delegation_ratio:number, correction_loop_avg:number, error_rate:number,
 *   cost_per_task:number, tokens_per_task:number, cache_hit_rate:number,
 *   tool_diversity:number, verify_tool_rate:number, subagent_usage:number,
 *   permission_events:number, active_hours:number, focus_block_avg_min:number,
 *   context_switch_rate:number, interrupts_per_hour:number,
 *   concurrent_sessions_peak:number
 * }}
 * The attention/sanity signals (active_hours + the 4 operational signals) are LOCAL-ONLY: they
 * are computed here so they flow into `--json` totals and per-day buckets, but they are NOT added
 * to buildPushPayload (report.mjs) — they never cross the tier boundary to the brain (EE10).
 */
export function computeSignals(events) {
  const bySession = new Map();
  for (const ev of events) {
    if (!bySession.has(ev.session_id)) bySession.set(ev.session_id, []);
    bySession.get(ev.session_id).push(ev);
  }

  let tasks = 0;
  let totalTok = 0; // all four buckets (display/totals)
  let workTok = 0; // in + out + cache_create — "fresh" effort, excludes cheap cache reads
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
    total_cost_usd: totalCost,
    input_tokens: sumIn,
    output_tokens: events.reduce((s, ev) => s + (ev.tokens?.out || 0), 0),
    cache_read_tokens: sumCacheRead,
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
    // Attention / sanity signals (LOCAL-ONLY — never pushed; see buildPushPayload).
    ...computeAttentionSignals(events),
  };
}
