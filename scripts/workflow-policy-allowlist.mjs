/**
 * workflow-policy-allowlist.mjs — validation of the reviewed-waiver file for
 * scripts/check-workflow-policy.mjs (leak-gate-remediation-plan.md §5.1 item 3).
 *
 * Split from workflow-policy-rules.mjs on the 500-line cap, and a reasonable seam anyway: this is
 * the part that decides whether a WAIVER is acceptable, not whether a workflow is. The two must not
 * drift into each other — a waiver that cannot name a real rule is a failure regardless of what any
 * workflow contains.
 */
import { MIN_JUSTIFICATION, RULES } from "./workflow-policy-catalogue.mjs";

function entryProblems(entry) {
  const problems = [];
  if (typeof entry?.workflow !== "string" || entry.workflow.trim() === "")
    problems.push("`workflow` must be a repo-relative path");
  if (typeof entry?.job !== "string" || entry.job.trim() === "")
    problems.push('`job` must be a job id, or "*" for every job in that one file');
  if (typeof entry?.rule !== "string" || !Object.hasOwn(RULES, entry.rule))
    problems.push(
      `\`rule\` must be one of: ${Object.keys(RULES).join(", ")} (a blanket waiver is not expressible)`
    );
  if (typeof entry?.owner !== "string" || entry.owner.trim() === "")
    problems.push("`owner` must name an accountable person or team");
  if (
    typeof entry?.justification !== "string" ||
    entry.justification.trim().length < MIN_JUSTIFICATION
  )
    problems.push(
      `\`justification\` must be at least ${MIN_JUSTIFICATION} characters and name the follow-up that removes this waiver`
    );
  return problems;
}

/** Validate the waiver file. Returns { entries, findings } — a bad entry is itself a violation. */
export function validateAllowlist(raw, file) {
  const findings = [];
  const entries = [];
  const invalid = (detail) =>
    findings.push({ file, job: "(allowlist)", rule: "allowlist-entry-invalid", line: 0, detail });
  const list = Array.isArray(raw?.entries) ? raw.entries : null;
  if (!list) {
    invalid("the allowlist must be an object with an `entries` array");
    return { entries, findings };
  }
  for (const [index, entry] of list.entries()) {
    const problems = entryProblems(entry);
    if (problems.length) invalid(`entry #${index + 1}: ${problems.join("; ")}`);
    else entries.push({ ...entry, used: false });
  }
  return { entries, findings };
}
