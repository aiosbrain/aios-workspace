/**
 * delivery/github.mjs — read-only GitHub PR state for `aios delivery status` (AIO-579).
 *
 * One bulk `gh pr list` call per repo (not a per-PR `gh pr checks`/`gh pr view` fan-out) so a
 * two-repo reconciliation stays a handful of GitHub API calls even with a large open+merged
 * backlog. The check-rollup aggregation mirrors the FAIL/PENDING state sets already used by
 * `scripts/pr-backlog-report.mjs` (that file's helpers are file-private, so the sets are
 * reproduced here rather than reaching into another lane's module) and by
 * `scripts/consolidate-findings.mjs`'s `CI_RED`/`CI_PENDING`.
 */

import { safeGh } from "./safe-exec.mjs";

// Fields pulled in one shot: PR identity, head/base, merge + review state, and the full check
// rollup (so per-PR check status never needs a second `gh pr checks` call).
const PR_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "mergeStateStatus",
  "mergeable",
  "reviewDecision",
  "statusCheckRollup",
  "createdAt",
  "updatedAt",
  "mergedAt",
  "closedAt",
].join(",");

/**
 * @param {string} repoSlug   "owner/repo"
 * @param {{state?: "open"|"closed"|"merged"|"all", limit?: number}} [opts]
 * @returns {Array<object>}  raw `gh pr list --json` records
 * @throws when the `gh pr list` call itself fails (auth/network/API) — callers must not
 *         swallow that into "no PRs", the same rule `scripts/pr.mjs`'s `existingPrNumber` follows.
 */
export function fetchPullRequests(repoSlug, { state = "all", limit = 50 } = {}) {
  const out = safeGh([
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    PR_JSON_FIELDS,
  ]);
  return JSON.parse(out);
}

// Mirrors pr-backlog-report.mjs's FAIL_STATES/PENDING_STATES (kept in sync by convention, not
// by import — see the module doc comment above).
const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const PENDING_STATES = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED", ""]);

function checkState(check) {
  if (check.__typename === "StatusContext") return check.state ?? "";
  return check.conclusion || check.status || "";
}

/**
 * Aggregate a PR's `statusCheckRollup` into one bucket. "fail" wins over "pending" (a red
 * check plus other still-running checks is still a red board); an empty rollup is "none"
 * (distinct from "pass" — nothing has reported yet, which is itself worth surfacing).
 *
 * @param {object} pr  a `gh pr list --json …statusCheckRollup` record
 * @returns {"pass"|"fail"|"pending"|"none"}
 */
export function aggregateChecks(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  if (!rollup.length) return "none";
  const states = rollup.map(checkState);
  if (states.some((s) => FAIL_STATES.has(s))) return "fail";
  if (states.some((s) => PENDING_STATES.has(s))) return "pending";
  return "pass";
}
