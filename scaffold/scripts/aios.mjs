#!/usr/bin/env node
/**
 * Thin CLI shim — forwards to the aios-workspace toolkit with --repo set to this workspace.
 * Resolution order: $AIOS_TOOLKIT_CLI, then common relative paths from ~/Projects layouts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.AIOS_TOOLKIT_CLI,
  resolve(workspaceRoot, "../aios-workspace/scripts/aios.mjs"),
  resolve(workspaceRoot, "../aios/aios-workspace/scripts/aios.mjs"),
  resolve(workspaceRoot, "../../aios-workspace/scripts/aios.mjs"),
].filter(Boolean);

const toolkit = candidates.find((p) => existsSync(p));
if (!toolkit) {
  console.error(
    "aios: toolkit CLI not found.\n" +
      "  Clone github.com/aiosbrain/aios-workspace nearby, or set:\n" +
      "  export AIOS_TOOLKIT_CLI=/path/to/aios-workspace/scripts/aios.mjs"
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
