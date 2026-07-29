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

function usableLinearKey(value) {
  let key = String(value ?? "").trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (key.startsWith("encrypted:")) {
    throw new Error(
      "LINEAR_API_KEY is dotenvx-encrypted and could not be decrypted; run under dotenvx or provide a valid .env.keys"
    );
  }
  return key;
}

function parseDotenvValue(raw) {
  const value = String(raw ?? "").trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closing = value.indexOf(quote, 1);
    if (closing < 0) throw new Error("LINEAR_API_KEY has an invalid quoted value in .env");
    const suffix = value.slice(closing + 1).trim();
    if (suffix && !suffix.startsWith("#")) {
      throw new Error("LINEAR_API_KEY has an invalid value after its closing quote in .env");
    }
    return value.slice(1, closing);
  }
  const comment = value.indexOf("#");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

export function resolveLinearKey({
  repo,
  env = process.env,
  execFile = execFileSync,
} = {}) {
  const ambient = usableLinearKey(env.LINEAR_API_KEY);
  if (ambient) return ambient;
  const envPath = path.join(repo, ".env");
  if (existsSync(envPath)) {
    try {
      const out = execFile("dotenvx", ["get", "LINEAR_API_KEY", "-f", envPath], {
        cwd: repo,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      const decrypted = usableLinearKey(out);
      if (decrypted) return decrypted;
    } catch {
      // Fall through to plain dotenv parsing for unencrypted local files.
    }
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*LINEAR_API_KEY\s*=\s*(.*)$/);
      if (!match) continue;
      const key = usableLinearKey(parseDotenvValue(match[1]));
      if (key) return key;
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
