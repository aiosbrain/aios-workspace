#!/usr/bin/env node
// ensure-env.mjs — guarantee a workspace has a `.env` on disk before anything that
// shells out to dotenvx runs against it (npm run gui, aios onboard/connect, the Tauri
// sidecar). dotenvx's `run --` refuses to start at all if .env is missing — even
// before any real secret is ever set — which used to crash a scaffold-then-
// immediately-run-gui flow with MISSING_ENV_FILE. This is the one place that
// guarantee gets created, so the bash scaffolder (scripts/scaffold-project.sh) and
// the Tauri app (src-tauri/src/main.rs) call the same logic instead of each
// re-implementing it.
//
// Usage: node scripts/ensure-env.mjs --repo <path-to-workspace>

import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure `<repo>/.env` exists. Copies `.env.example` if present (it holds no real
 * values — safe to copy as-is), otherwise creates an empty file. Never overwrites an
 * existing `.env`. Returns true iff it created the file.
 */
export function ensureEnv(repo) {
  const envPath = join(repo, ".env");
  if (existsSync(envPath)) return false;
  const examplePath = join(repo, ".env.example");
  if (existsSync(examplePath)) copyFileSync(examplePath, envPath);
  else writeFileSync(envPath, "");
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
  if (!repo) {
    console.error("usage: node scripts/ensure-env.mjs --repo <path>");
    process.exit(1);
  }
  const created = ensureEnv(repo);
  if (created) console.log(`✓ created ${join(repo, ".env")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
