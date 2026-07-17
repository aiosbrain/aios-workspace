#!/usr/bin/env node
/**
 * Thin CLI shim — forwards to the aios-workspace toolkit with --repo set to this workspace.
 * Resolves the toolkit CHECKOUT: $AIOS_TOOLKIT_DIR (the canonical var, shared with the CLI;
 * the entrypoint derives as <dir>/TOOLKIT_CLI), the deprecated $AIOS_TOOLKIT_CLI, then common
 * relative ~/Projects layouts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLKIT_CLI = "scripts/aios.mjs"; // the entrypoint within a toolkit checkout
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromDir = (dir) => resolve(dir, TOOLKIT_CLI);

// AIOS_TOOLKIT_CLI (a direct path to the entrypoint) is the deprecated predecessor of
// AIOS_TOOLKIT_DIR — honored so existing custom-path configs keep working, with a nudge.
if (process.env.AIOS_TOOLKIT_CLI && !process.env.AIOS_TOOLKIT_DIR) {
  process.stderr.write(
    "aios: AIOS_TOOLKIT_CLI is deprecated — set AIOS_TOOLKIT_DIR=<aios-workspace checkout> instead.\n"
  );
}

const candidates = [
  process.env.AIOS_TOOLKIT_DIR && fromDir(process.env.AIOS_TOOLKIT_DIR),
  process.env.AIOS_TOOLKIT_CLI, // deprecated alias: already a direct path to the entrypoint
  fromDir(resolve(workspaceRoot, "../aios-workspace")),
  fromDir(resolve(workspaceRoot, "../aios/aios-workspace")),
  fromDir(resolve(workspaceRoot, "../../aios-workspace")),
].filter(Boolean);

const toolkit = candidates.find((p) => existsSync(p));
if (!toolkit) {
  console.error(
    "aios: toolkit CLI not found.\n" +
      "  Clone github.com/aiosbrain/aios-workspace nearby, or set:\n" +
      "  export AIOS_TOOLKIT_DIR=/path/to/aios-workspace"
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const hasRepo = args.some((a) => a === "--repo" || a.startsWith("--repo="));
const forwarded = hasRepo ? args : [...args, "--repo", workspaceRoot];

const result = spawnSync(process.execPath, [toolkit, ...forwarded], {
  stdio: "inherit",
  cwd: workspaceRoot,
  env: process.env,
});

process.exit(result.status ?? 1);
