#!/usr/bin/env node
/**
 * Optional V1 Linear reconciliation gate.
 *
 * Compares docs/v1-operator-loop/README.md C1-C8 status tokens with the AIOS Linear
 * board. This is intentionally NOT required in public CI because Linear credentials are
 * private. With no LINEAR_API_KEY it exits 0 with a clear skip message.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOC = path.join(ROOT, "docs", "v1-operator-loop", "README.md");
const API = "https://api.linear.app/graphql";
const TEAM_KEY = "AIO";

function documentedComponents() {
  const doc = readFileSync(DOC, "utf8");
  const block = doc.match(
    /<!--\s*drift:operator-components\s*-->([\s\S]*?)<!--\s*\/drift:operator-components\s*-->/
  );
  if (!block) throw new Error("missing drift:operator-components block");
  const rows = [];
  for (const match of block[1].matchAll(/`([^`]+)`/g)) {
    const [component, identifier, status, spec] = match[1].split("|");
    if (!component || !identifier || !status || !spec) {
      throw new Error(`malformed component token: ${match[1]}`);
    }
    rows.push({ component, identifier, status, spec });
  }
  return rows;
}

function normalizeStatus(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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

const documented = documentedComponents();
const data = await gql(
  apiKey,
  `query($key:String!){
    issues(first:250, filter:{ team:{ key:{ eq:$key } } }){
      nodes{ identifier title state{ name } url }
    }
  }`,
  { key: TEAM_KEY }
);
const byIdentifier = new Map(data.issues.nodes.map((issue) => [issue.identifier, issue]));
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

if (failed) {
  console.error("\nV1 Linear drift detected. Update docs/v1-operator-loop/README.md or Linear.");
  process.exit(1);
}

console.log("\nV1 Linear statuses match docs/v1-operator-loop/README.md.");
