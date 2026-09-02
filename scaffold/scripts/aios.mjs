#!/usr/bin/env node
/**
 * Thin CLI shim — forwards to the aios toolkit with --repo set to this workspace.
 *
 * v2 resolution order (AIO-635 Decision 2):
 *   1. $AIOS_TOOLKIT_DIR — explicit config. Set-but-invalid is a HARD error, never a
 *      silent fall-through (the explicit-source rule of the toolkit locator).
 *   2. $AIOS_TOOLKIT_CLI — deprecated alias (stderr warning; deleted at v3.0.0).
 *   3. The `source` line this workspace's own version stamp records, when it is an
 *      absolute path that still resolves. Recorded state beats ambient PATH, so every
 *      checkout-stamped workspace behaves identically; a workspace last synced from a
 *      registry root has a `pkg:` source line that falls through to PATH by construction.
 *   4. A PATH-installed `aios` (a `command -v`-equivalent walk of $PATH). The hit is
 *      realpath'd and rejected when it is this shim itself or lies under the workspace
 *      root — npm bin stubs are wrappers whose realpath differs from the shim file, so
 *      the old equality-only self-exec guard is extended to directory containment. The
 *      surviving hit is spawned directly by absolute path (never through a shell).
 *   5. Relative ~/Projects layout guesses — legacy last resort (deleted at v3.0.0).
 *
 * Streams: every notice here goes to stderr; stdout carries only the delegated
 * command's stdout. The child's exit status is preserved.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLKIT_CLI = "scripts/aios.mjs"; // the entrypoint within a toolkit checkout
const currentScript = realpathSync(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(dirname(currentScript), "..");
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
// same line (scripts/update/stamp.mjs). Only absolute filesystem paths are accepted — a
// clone URL or a `pkg:@aiosbrain/aios@<version>` registry source falls through (to PATH).
const fromStamp = () => {
  try {
    const stamp = readFileSync(resolve(workspaceRoot, ".aios-toolkit-version"), "utf8");
    const source = /^source (.+)$/m.exec(stamp);
    const sourcePath = source?.[1].trim();
    return sourcePath && isAbsolute(sourcePath) ? fromDir(sourcePath) : undefined;
  } catch {
    return undefined; // no stamp, or unreadable — no signal, not an error
  }
};

// A usable toolkit-entrypoint file: exists, and is not this shim re-resolving itself.
const usableEntry = (p) => {
  try {
    return !!p && existsSync(p) && realpathSync(p) !== currentScript;
  } catch {
    return false;
  }
};

// PATH-installed `aios` — the directory-containment extension of the self-exec guard.
const fromPath = () => {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir, "aios");
    try {
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (real === currentScript) continue; // this shim on PATH — never self-exec
      if (real === workspaceRoot || real.startsWith(workspaceRoot + sep)) continue;
      return candidate; // spawned by ABSOLUTE path, never through a shell
    } catch {
      continue; // not executable / dangling — keep walking
    }
  }
  return undefined;
};

function resolveDelegate() {
  // 1. Explicit config: set-but-invalid is a hard error, never a fall-through.
  if (process.env.AIOS_TOOLKIT_DIR) {
    const entry = fromDir(process.env.AIOS_TOOLKIT_DIR);
    if (usableEntry(entry)) return { entry };
    process.stderr.write(
      `aios: AIOS_TOOLKIT_DIR=${process.env.AIOS_TOOLKIT_DIR} does not contain ${TOOLKIT_CLI} — ` +
        "fix or unset it (an explicit source never silently falls through).\n"
    );
    process.exit(1);
  }
  // 2. Deprecated alias; 3. the stamp's recorded source.
  for (const entry of [process.env.AIOS_TOOLKIT_CLI, fromStamp()]) {
    if (usableEntry(entry)) return { entry };
  }
  // 4. PATH-installed aios.
  const bin = fromPath();
  if (bin) return { bin };
  // 5. Legacy relative-layout guesses (v2 only; deleted at v3.0.0).
  for (const entry of [
    fromDir(resolve(workspaceRoot, "../aios-workspace")),
    fromDir(resolve(workspaceRoot, "../aios/aios-workspace")),
    fromDir(resolve(workspaceRoot, "../../aios-workspace")),
  ]) {
    if (usableEntry(entry)) return { entry };
  }
  return null;
}

const delegate = resolveDelegate();
if (!delegate) {
  console.error(
    "aios: no AIOS CLI found.\n" +
      "  Neither AIOS_TOOLKIT_DIR, this workspace's .aios-toolkit-version, a PATH-installed\n" +
      "  `aios`, nor a nearby checkout resolves.\n" +
      "  Install the CLI:  npm i -g @aiosbrain/aios\n" +
      "  or clone github.com/aiosbrain/aios-workspace and set AIOS_TOOLKIT_DIR=/path/to/it"
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const hasRepo = args.some((a) => a === "--repo" || a.startsWith("--repo="));
const forwarded = hasRepo ? args : [...args, "--repo", workspaceRoot];

const result = delegate.bin
  ? spawnSync(delegate.bin, forwarded, { stdio: "inherit", cwd: workspaceRoot, env: process.env })
  : spawnSync(process.execPath, [delegate.entry, ...forwarded], {
      stdio: "inherit",
      cwd: workspaceRoot,
      env: process.env,
    });

process.exit(result.status ?? 1);
