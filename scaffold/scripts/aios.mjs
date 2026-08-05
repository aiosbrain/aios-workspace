#!/usr/bin/env node
/**
 * Thin CLI shim — forwards to the aios-workspace toolkit with --repo set to this workspace.
 * Resolves the toolkit CHECKOUT in this order: $AIOS_TOOLKIT_DIR (the canonical var, shared
 * with the CLI; the entrypoint derives as <dir>/TOOLKIT_CLI), the deprecated $AIOS_TOOLKIT_CLI,
 * the `source` line this workspace's own version stamp records, then common relative
 * ~/Projects layouts. Explicit configuration beats recorded state; recorded state beats
 * guessing at the directory layout.
 *
 * The stamp step is what makes a scaffolded workspace work with no setup at all: without it,
 * the shim only resolved when someone exported the env var or happened to lay their
 * directories out to match one of the guesses below.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// The checkout this workspace was stamped from is already on disk: scaffold-project.sh
// writes `source <path>` into .aios-toolkit-version, and every `aios update` rewrites the
// same line (scripts/update/stamp.mjs). Reading it means a workspace resolves its CLI with
// no env var and no directory-layout luck — including workspaces scaffolded before this
// shim learned to look. `source` holds a clone URL instead of a path when update fell back
// to an ephemeral clone; that just fails the existsSync below and falls through.
//
// This execs a path named by a file inside the workspace, which is the same trust level the
// relative guesses below already carry — and `aios update` already treats this exact file as
// its 3-way merge base.
const fromStamp = () => {
  try {
    const stamp = readFileSync(resolve(workspaceRoot, ".aios-toolkit-version"), "utf8");
    const source = /^source (.+)$/m.exec(stamp);
    return source && fromDir(resolve(workspaceRoot, source[1].trim()));
  } catch {
    return undefined; // no stamp, or unreadable — no signal, not an error
  }
};

const candidates = [
  process.env.AIOS_TOOLKIT_DIR && fromDir(process.env.AIOS_TOOLKIT_DIR),
  process.env.AIOS_TOOLKIT_CLI, // deprecated alias: already a direct path to the entrypoint
  fromStamp(),
  fromDir(resolve(workspaceRoot, "../aios-workspace")),
  fromDir(resolve(workspaceRoot, "../aios/aios-workspace")),
  fromDir(resolve(workspaceRoot, "../../aios-workspace")),
].filter(Boolean);

const toolkit = candidates.find((p) => existsSync(p));
if (!toolkit) {
  console.error(
    "aios: aios-workspace checkout not found.\n" +
      "  Neither AIOS_TOOLKIT_DIR nor this workspace's .aios-toolkit-version\n" +
      "  points at a checkout that still exists.\n" +
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
