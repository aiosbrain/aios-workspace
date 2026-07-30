/**
 * severity.mjs — the canonical finding-severity vocabulary and ranking helpers, as a
 * dependency-free core leaf module.
 *
 * SEVERITY_RANK and the ranking helpers moved here (AIO-594) from
 * scripts/review-bugbot/findings.mjs and scripts/consolidate-findings.mjs respectively:
 * core-staying commands (`aios verify`) must not import from the devtools path set
 * (consolidate-findings.mjs et al.) that is moving to the aios-devtools repo. findings.mjs
 * (the severity/verdict matcher dialect) and consolidate-findings.mjs both re-export these
 * for back-compat, so no existing call site changes meaning.
 */

// Rank for merging/comparing severities across sources (used by the consolidator).
export const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export function rankSeverity(sev) {
  return SEVERITY_RANK[sev] ?? 0;
}

export function normalizeSeverity(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.startsWith("crit")) return "Critical";
  if (t === "high") return "High";
  if (t === "medium" || t === "med") return "Medium";
  if (t === "low") return "Low";
  return null;
}

// Stable, deterministic severity order shared by report-only review fan-outs.
// Equal-severity findings retain their source order.
export function rankFindings(findings) {
  return findings
    .map((finding, sourceIndex) => ({
      ...finding,
      severity: normalizeSeverity(finding?.severity) ?? "Low",
      sourceIndex,
    }))
    .sort(
      (a, b) => rankSeverity(b.severity) - rankSeverity(a.severity) || a.sourceIndex - b.sourceIndex
    )
    .map(({ sourceIndex: _sourceIndex, ...finding }) => finding);
}
