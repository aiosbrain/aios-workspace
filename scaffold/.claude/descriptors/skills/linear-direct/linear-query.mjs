#!/usr/bin/env node
/**
 * linear-query.mjs — run a Linear GraphQL query with your personal API key.
 *
 * Our own Linear connector (Linear's official MCP is OAuth-only). Calls the public
 * GraphQL API directly. Endpoint/auth verified against https://linear.app/developers
 * on 2026-06-14:  POST https://api.linear.app/graphql  ·  Authorization: <api-key>
 * (personal keys are sent raw, not as a Bearer token).
 *
 * The key is resolved locally (env → dotenvx → .env); never printed, never leaves
 * this machine.
 *
 *   node .claude/skills/linear-direct/linear-query.mjs [--query '<graphql>'] [--repo PATH]
 *   (default query: your assigned, open issues)
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const API = "https://api.linear.app/graphql";
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
const repo = path.resolve(flag("--repo", process.cwd()));

const DEFAULT_QUERY = `{
  viewer {
    name
    assignedIssues(first: 25, filter: { state: { type: { neq: "completed" } } }) {
      nodes { identifier title state { name } priorityLabel url }
    }
  }
}`;
const query = flag("--query", DEFAULT_QUERY);

function resolveKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const envPath = path.join(repo, ".env");
  if (existsSync(envPath)) {
    try {
      const out = execFileSync("dotenvx", ["get", "LINEAR_API_KEY", "-f", envPath], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (out) return out;
    } catch { /* fall through */ }
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*LINEAR_API_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  console.error("linear-query: no LINEAR_API_KEY found (env or .env). Connect Linear first.");
  process.exit(1);
}

const res = await fetch(API, {
  method: "POST",
  headers: { Authorization: resolveKey(), "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
});
const json = await res.json().catch(() => null);
if (!res.ok || (json && json.errors)) {
  console.error(`linear-query: request failed${json && json.errors ? " — " + json.errors.map((e) => e.message).join("; ") : ` (HTTP ${res.status})`}`);
  process.exit(1);
}
console.log(JSON.stringify(json.data, null, 2));
