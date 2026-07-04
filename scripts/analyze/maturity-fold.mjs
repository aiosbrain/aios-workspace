/**
 * maturity-fold.mjs — the READ-side fold shared by AM1's consumers.
 *
 * The maturity store (.aios/loop/maturity/sessions.ndjson, written by AM1's
 * maturity-capture.mjs) co-mingles every repo that shared a workspace root, keyed
 * only by session_id and tagged with a `project` slug. Any reader that wants a
 * placement has to (a) filter to one project's slug and (b) fold the per-session
 * COUNTS back into the ratio signals that placement() consumes — recomputing
 * ratios, never averaging them, so the fold matches computeSessionRecord exactly.
 *
 * AM2's SessionStart brief (hooks/maturity-brief.mjs) and AM6's weekly report
 * (scripts/maturity-week.mjs) both need this, so it lives here once. Zero deps.
 */

import path from "node:path";

// 10 MB read cap — the store self-compacts at 20k lines, so a store past this is
// pathological; readers skip it to protect their compute budget (fail-open).
export const STORE_SIZE_CAP = 10 * 1024 * 1024;

/**
 * Slugify a cwd basename into a stable project id — VERBATIM from
 * maturity-capture.mjs's projectSlug so the slug a reader filters on matches
 * exactly what AM1 tagged each session with.
 */
export function projectSlug(cwd) {
  try {
    return path
      .basename(String(cwd || ""))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  } catch {
    return "";
  }
}

// Module-private ratio helper in metrics.mjs is not exported; inline it with
// identical semantics (0 when the denominator is non-positive) so the fold matches
// computeSessionRecord.
function ratio(n, d) {
  return d > 0 ? n / d : 0;
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/**
 * Fold same-project session records → the signals placement() consumes. Fold
 * COUNTS and recompute ratios (never average ratios) — matches
 * computeSessionRecord's formulas exactly.
 * @param {Array<object>} recent  session snapshots (each with `.counts` + `.signals`)
 */
export function foldSignals(recent) {
  const t = {
    in_tok: 0,
    out_tok: 0,
    cache_read_tok: 0,
    cache_create_tok: 0,
    subagent_tok: 0,
    tool_use_total: 0,
    verify_tool_uses: 0,
    tool_results: 0,
    tool_result_errors: 0,
    tasks: 0,
    permission_events: 0,
  };
  let subagentSessions = 0;
  let diversitySum = 0;
  for (const s of recent) {
    const c = s.counts || {};
    for (const k of Object.keys(t)) t[k] += num(c[k]);
    const sig = s.signals || {};
    if (sig.subagent_usage === 1) subagentSessions += 1;
    // tool_diversity is a MEAN of per-session distinct counts (matches computeSignals'
    // avgDiversity), NOT a union of counts.distinct_tools. Prefer the per-session numeric
    // signal (uncapped Set.size); fall back to the capped name-list length only if absent.
    diversitySum += Number.isFinite(Number(sig.tool_diversity))
      ? Number(sig.tool_diversity)
      : Array.isArray(c.distinct_tools)
        ? c.distinct_tools.length
        : 0;
  }
  const n = recent.length;
  const totalTok = t.in_tok + t.out_tok + t.cache_read_tok + t.cache_create_tok;
  const workTok = t.in_tok + t.out_tok + t.cache_create_tok; // "fresh" — excludes cache reads
  return {
    delegation_ratio: ratio(t.subagent_tok, totalTok),
    verify_tool_rate: ratio(t.verify_tool_uses, t.tool_use_total),
    cache_hit_rate: ratio(t.cache_read_tok, t.cache_read_tok + t.in_tok + t.cache_create_tok),
    tokens_per_task: ratio(workTok, t.tasks),
    permission_events: t.permission_events,
    subagent_usage: ratio(subagentSessions, n),
    tool_diversity: n > 0 ? diversitySum / n : 0,
  };
}
