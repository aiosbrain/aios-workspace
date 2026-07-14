#!/usr/bin/env node
/**
 * Optional V1 Linear reconciliation gate.
 *
 * Compares docs/v1-operator-loop/README.md C1-C8 status tokens with the AIOS Linear
 * board. This is intentionally NOT required in public CI because Linear credentials are
 * private. With no LINEAR_API_KEY it exits 0 with a clear skip message.
 */
import path from "node:path";
import {
  blockedByIdentifiers,
  documentedComponents,
  fetchAllTeamIssues,
  normalizeStatus,
} from "./v1-linear-reconciliation.mjs";

const ROOT = process.cwd();
const DOC = path.join(ROOT, "docs", "v1-operator-loop", "README.md");
const API = "https://api.linear.app/graphql";
const TEAM_KEY = "AIO";

async function gql(apiKey, query, variables) {
  const response = await fetch(API, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || json.errors) {
    const reason = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Linear query failed: ${reason}`);
  }
  return json.data;
}

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.log("Skipping V1 Linear drift check: LINEAR_API_KEY is not set.");
  process.exit(0);
}

const documented = documentedComponents(DOC);
const issues = await fetchAllTeamIssues(
  (query, variables) => gql(apiKey, query, variables),
  TEAM_KEY
);
const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
let failed = false;

for (const row of documented) {
  const issue = byIdentifier.get(row.identifier);
  if (!issue) {
    console.error(`x ${row.component}: ${row.identifier} not found in Linear team ${TEAM_KEY}`);
    failed = true;
    continue;
  }
  const linearStatus = normalizeStatus(issue.state?.name);
  if (linearStatus !== row.status) {
    console.error(
      `x ${row.component}: ${row.identifier} status drift docs=${row.status} linear=${linearStatus} (${issue.url})`
    );
    failed = true;
  } else {
    console.log(`ok ${row.component}: ${row.identifier} ${row.status}`);
  }
}

const parent = byIdentifier.get("AIO-122");
if (!parent) {
  console.error("x closeout: AIO-122 not found in Linear");
  failed = true;
} else {
  const blockers = blockedByIdentifiers(parent);
  if (blockers.includes("AIO-130")) {
    console.error("x closeout: stale AIO-130 blocker is still attached to AIO-122");
    failed = true;
  } else {
    console.log("ok closeout: AIO-122 has no stale AIO-130 blocker");
  }
}

if (failed) {
  console.error("\nV1 Linear drift detected. Update docs/v1-operator-loop/README.md or Linear.");
  process.exit(1);
}

console.log("\nV1 Linear statuses match docs/v1-operator-loop/README.md.");
