/**
 * Shared fixtures for the review-evidence suites (AIO-777). Split out because the two suites
 * live in separate files to stay under the file-size gate, not because they are unrelated.
 */
export const HEAD = "0123456789abcdef0123456789abcdef01234567";
export const STALE = "76543210fedcba9876543210fedcba9876543210";

export function attestation(sha = HEAD, findings = "- no reportable findings") {
  return [
    "## Findings",
    findings,
    "## Mergeability",
    "- Ready to merge",
    "## Open Questions",
    "- none",
    "## Verification",
    `- Reviewed at ${sha}`,
    "",
    "MERGE_READY",
  ].join("\n");
}

export function exemption(sha = HEAD, reason = "- dependabot lockfile bump, no source change") {
  return [
    "## Exemption",
    reason,
    "## Verification",
    `- Exempt at ${sha}`,
    "",
    "REVIEW_EXEMPT",
  ].join("\n");
}
