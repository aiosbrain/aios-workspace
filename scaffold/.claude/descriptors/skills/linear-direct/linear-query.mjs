#!/usr/bin/env node
/**
 * linear-query.mjs — run a Linear GraphQL query with your personal API key.
 *
 * The default query paginates every open issue assigned to the authenticated viewer. An explicit
 * --query remains a single generic GraphQL request. Credentials resolve locally and are never
 * printed or passed in argv.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  queryAssignedOpenIssues,
  requestLinear,
} from "./linear-query-client.mjs";

function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function resolveLinearKey({
  repo,
  env = process.env,
  execFile = execFileSync,
} = {}) {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  const envPath = path.join(repo, ".env");
  if (existsSync(envPath)) {
    try {
      const out = execFile("dotenvx", ["get", "LINEAR_API_KEY", "-f", envPath], {
        cwd: repo,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (out) return out;
    } catch {
      // Fall through to plain dotenv parsing for unencrypted local files.
    }
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*LINEAR_API_KEY\s*=\s*(.+)\s*$/);
      if (match) return match[1].replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("no LINEAR_API_KEY found (env or .env). Connect Linear first");
}

export async function queryAssignedOpenIssuesForRepo(
  repo,
  { env = process.env, fetchImpl = fetch } = {}
) {
  return queryAssignedOpenIssues({
    apiKey: resolveLinearKey({ repo, env }),
    fetchImpl,
  });
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl = fetch } = {}
) {
  const repo = path.resolve(flag(argv, "--repo", process.cwd()));
  const query = flag(argv, "--query");
  const apiKey = resolveLinearKey({ repo, env });
  const data = query
    ? await requestLinear({ query, apiKey, fetchImpl })
    : await queryAssignedOpenIssues({ apiKey, fetchImpl });
  console.log(JSON.stringify(data, null, 2));
  return data;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`linear-query: ${error instanceof Error ? error.message : "request failed"}`);
    process.exitCode = 1;
  });
}
