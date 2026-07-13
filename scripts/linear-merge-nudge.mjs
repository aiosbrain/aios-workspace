#!/usr/bin/env node
/**
 * linear-merge-nudge.mjs — the mechanical reconciliation nudge for merged PRs.
 *
 * Problem: `aios-work-sync.yml` posts a "merged" work-event to the brain, but nothing checks
 * whether the Linear issue a PR references actually got moved to Done/Canceled. A PR can merge,
 * reference AIO-123, and leave AIO-123 sitting in "In Progress" forever — silently stale, with no
 * signal anywhere that the board and reality have drifted.
 *
 * This script closes that gap: given a PR's title + branch name, it extracts `AIO-\d+`
 * identifiers, looks up each issue's current state via the Linear GraphQL API, and returns a
 * decision — nudge (state isn't a completed one) or skip (no ids, or already Done/Canceled).
 *
 * Zero deps beyond Node's built-in fetch. Every network/env seam is an injectable parameter so
 * the identifier-extraction + decision logic is fully unit-testable without hitting Linear.
 */

import { appendFileSync } from "node:fs";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

// Linear's two WorkflowState "completed" types. Anything else (unstarted/started/backlog/
// triage) is NOT a resolved state and should be nudged.
const COMPLETED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Extract unique AIO-<n> identifiers from arbitrary PR text (title + branch name).
 * Matches the same `AIO-\d+` shape used elsewhere in this repo's PM plumbing, but scoped to the
 * AIO team prefix specifically (the task calling this one only cares about the AIOS board).
 */
export function extractAioIds(...texts) {
  const re = /\bAIO-(\d+)\b/g;
  const ids = new Set();
  for (const text of texts) {
    for (const m of String(text ?? "").matchAll(re)) {
      ids.add(`AIO-${m[1]}`);
    }
  }
  return [...ids];
}

/**
 * Query Linear for an issue's current workflow state.
 * @param {string} identifier e.g. "AIO-123"
 * @param {object} o
 * @param {string} o.apiKey       raw Linear personal/API key (sent unmodified, no Bearer prefix)
 * @param {Function} [o.fetchFn]  injectable fetch (defaults to globalThis.fetch)
 * @returns {Promise<{identifier: string, name: string, type: string} | null>} null if not found
 */
export async function getIssueState(identifier, { apiKey, fetchFn = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error("getIssueState requires apiKey.");
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier);
  if (!m) throw new Error(`invalid Linear identifier '${identifier}'.`);
  const [, teamKey, num] = m;
  const query = `query GetIssueState($key: String!, $num: Float!) {
    issues(filter: { team: { key: { eq: $key } }, number: { eq: $num } }, first: 1) {
      nodes { identifier state { name type } }
    }
  }`;
  const res = await fetchFn(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { key: teamKey, num: Number(num) } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linear HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const node = json?.data?.issues?.nodes?.[0];
  if (!node) return null;
  return {
    identifier: node.identifier,
    name: node.state?.name ?? "Unknown",
    type: node.state?.type ?? "unknown",
  };
}

/** True when a state type counts as "resolved" for reconciliation purposes. */
export function isResolvedStateType(stateType) {
  return COMPLETED_STATE_TYPES.has(stateType);
}

/** Build the PR-comment body for a single stale identifier. */
export function buildNudgeComment(identifier, stateName) {
  return (
    `Merged PR references ${identifier} which is still in state ${stateName} — ` +
    `update the Linear board (add a comment + move state) or note why it stays open.`
  );
}

/**
 * Compute the reconciliation decision for a PR given its title + branch name.
 * Returns one identifier-state pair per referenced issue not yet resolved. Issues that don't
 * resolve (not found in Linear) are reported separately as `notFound` — worth logging, not
 * nudge-worthy on their own since a bad match shouldn't spam the PR thread.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.branch
 * @param {string} o.apiKey
 * @param {Function} [o.fetchFn]
 */
export async function computeNudges({ title, branch, apiKey, fetchFn }) {
  const ids = extractAioIds(title, branch);
  if (!ids.length) return { ids: [], stale: [], notFound: [] };

  const stale = [];
  const notFound = [];
  for (const id of ids) {
    const state = await getIssueState(id, { apiKey, fetchFn });
    if (!state) {
      notFound.push(id);
      continue;
    }
    if (!isResolvedStateType(state.type)) {
      stale.push({ identifier: state.identifier, stateName: state.name });
    }
  }
  return { ids, stale, notFound };
}

// ── CLI entrypoint — reads PR context from env, prints the GitHub Actions output ────────────
// Env contract (set by the calling workflow):
//   PR_TITLE, PR_BRANCH   — the merged PR's title + head ref
//   LINEAR_API_KEY        — Linear API key; if unset, exits 0 (fail-open) with a log line
//   GITHUB_OUTPUT         — (optional) GitHub Actions output file; when present, writes
//                           `should_comment=true|false` and `comment_body=<...>` for the next step
async function main() {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.log("LINEAR_API_KEY not set — skipping Linear merge-nudge (fail-open).");
    process.exit(0);
  }

  const title = process.env.PR_TITLE ?? "";
  const branch = process.env.PR_BRANCH ?? "";

  let result;
  try {
    result = await computeNudges({ title, branch, apiKey });
  } catch (e) {
    console.error(`linear-merge-nudge: ${e.message}`);
    process.exit(0); // fail-open: a Linear API hiccup should never fail the merge workflow
  }

  if (!result.ids.length) {
    console.log("No AIO-<n> identifier found in PR title/branch — nothing to reconcile.");
    process.exit(0);
  }

  if (result.notFound.length) {
    console.log(`Referenced but not found in Linear: ${result.notFound.join(", ")}`);
  }

  if (!result.stale.length) {
    console.log(
      `All referenced issues (${result.ids.join(", ")}) are Done/Canceled — no nudge needed.`
    );
    writeOutput({ should_comment: "false", comment_body: "" });
    process.exit(0);
  }

  const body = result.stale.map((s) => buildNudgeComment(s.identifier, s.stateName)).join("\n\n");
  console.log(body);
  writeOutput({ should_comment: "true", comment_body: body });
}

function writeOutput(kv) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(kv).map(([k, v]) => {
    if (String(v).includes("\n")) {
      const delim = `EOF_${Math.random().toString(36).slice(2)}`;
      return `${k}<<${delim}\n${v}\n${delim}`;
    }
    return `${k}=${v}`;
  });
  appendFileSync(file, lines.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
