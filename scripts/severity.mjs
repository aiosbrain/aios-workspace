/**
 * severity.mjs — the canonical finding-severity vocabulary, ranking helpers, AND the
 * structural severity matchers, as a dependency-free core leaf module.
 *
 * SEVERITY_RANK and the ranking helpers moved here (AIO-594) from
 * scripts/review-bugbot/findings.mjs and scripts/consolidate-findings.mjs respectively;
 * the structural matchers (`hasFindingsAtOrAbove`, `hasCriticalOrHighFindings`,
 * `canonicalSeverity`) followed in the devtools-seam wave (AIO-594 F1): the devtools-bound
 * consolidator and build loop gate on them, and core-staying commands must not import from
 * the devtools path set — nor devtools files statically from review-bugbot. findings.mjs
 * (the verdict-protocol dialect) and consolidate-findings.mjs both re-export these for
 * back-compat, so no existing call site changes meaning. This leaf is the ONE home of the
 * matcher — do not duplicate it elsewhere (it is the mutation target for the
 * severity-classification concern).
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

/** The canonical-cased severity name for a case-insensitive value, or null. */
export function canonicalSeverity(value) {
  const found = Object.keys(SEVERITY_RANK).find(
    (severity) => severity.toLowerCase() === String(value ?? "").toLowerCase()
  );
  return found ?? null;
}

// Structural matchers for a listed Critical/High finding: a leading bullet
// (`- Critical: …`), a leading severity table cell (`| High |`), or the bracket form
// (`[High] file:line — …`) that the consolidated findings report (code-reviewer.md's
// "Output format") emits. Prose such as "no Critical or High findings" matches NONE of
// these — only an actual listed finding. This is the single severity dialect: both the
// Cursor review loop and the consolidator gate on the same matcher.
// All three tolerate markdown emphasis around the severity (`**[High]**`, `**High**`): the
// consolidator model bolds findings, and a decoration-blind matcher silently downgraded a
// BLOCKED round to CLEAR (AIO-239 / observation.md §9 — the verdict must not hinge on `**`).
const MD = "(?:\\*\\*|__|\\*|_)?"; // optional emphasis opener/closer

/** True when review text contains a listed finding at or above the requested severity. */
export function hasFindingsAtOrAbove(text, failOn = "high") {
  const canonical = canonicalSeverity(failOn);
  if (!canonical) throw new Error(`invalid Bugbot severity: ${failOn}`);
  const threshold = SEVERITY_RANK[canonical];
  const severity = "(Critical|High|Medium|Low)";
  const patterns = [
    new RegExp(
      `^\\s*(?:(?:[-*]|\\d+[.)]|#{1,6})\\s+)?${MD}\`?${severity}\\s+Severity\`?${MD}\\s*(?::|—|-\\s+|$)`,
      "i"
    ),
    new RegExp(`^\\s*(?:[-*]|\\d+[.)])\\s*${MD}\`?${severity}\`?${MD}\\s*(?::|—|-\\s+)`, "i"),
    new RegExp(`^\\s*(?:[-*]|\\d+[.)])\\s*${MD}\\[${severity}\\]${MD}`, "i"),
    new RegExp(`^\\s*\\|\\s*${MD}\`?${severity}\`?${MD}\\s*\\|`, "i"),
    new RegExp(`^\\s*${MD}\\[${severity}\\]`, "i"),
    new RegExp(`^\\s*${MD}\`?${severity}\`?${MD}\\s*(?::|—|-\\s+)`, "i"),
  ];
  return String(text ?? "")
    .split("\n")
    .some((line) => {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (!match) continue;
        const listed = canonicalSeverity(match[1]);
        if (listed && SEVERITY_RANK[listed] >= threshold) return true;
      }
      return false;
    });
}

/** True when review text lists a Critical/High finding (bullet, table row, or bracket). */
export function hasCriticalOrHighFindings(text) {
  return hasFindingsAtOrAbove(text, "high");
}
