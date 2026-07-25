#!/usr/bin/env node
// ensure-loop-built.mjs — best-effort, never-fail build of the operator-loop TS
// workflow layer (dist/operator-loop, per tsconfig.json). Shared by three call
// sites so the compile logic + staleness check lives in exactly one place:
//   1. `npm run postinstall` (scripts/postinstall-banner.mjs chains into this)
//   2. worktree hydration (scripts/link-worktree-env.sh)
//   3. the lazy self-heal in scripts/aios.mjs's loadOperatorLoop()
//
// Contract (default/soft mode): this script NEVER throws and ALWAYS exits 0.
// It is best-effort — callers that need a hard guarantee (the CLI's die()
// backstop) re-check existsSync(dist/operator-loop/index.js) themselves after
// invoking it.
//
// Strict mode (`--strict` flag or AIOS_LOOP_BUILD_STRICT=1): for TEST paths
// (e.g. `npm run test:node`), where "tests passed against stale dist/" would be
// a false green. When a rebuild is needed and fails (or typescript isn't
// installed), strict mode surfaces the real tsc diagnostics and exits nonzero.
// The mtime-gated no-op is unchanged: a fresh dist/ still exits 0 immediately
// without invoking tsc. `build:loop` uses --noEmitOnError, so a failed compile
// never refreshes dist/ mtimes and the staleness check stays sound on re-runs.
//
// Usage: node scripts/ensure-loop-built.mjs [repoRoot] [--quiet] [--strict]
//   repoRoot  defaults to the parent of this script's own directory. Callers
//             don't need to pass it explicitly as long as they invoke the copy
//             of this file that lives in the checkout/worktree whose sibling
//             dist/ they want built — e.g. link-worktree-env.sh runs
//             `(cd "$here" && node scripts/ensure-loop-built.mjs)`, so the
//             worktree's own script resolves the worktree's own repoRoot. An
//             explicit repoRoot is only needed when invoking a *different*
//             checkout's copy of this script than the one you want built.

import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const strict = args.includes("--strict") || process.env.AIOS_LOOP_BUILD_STRICT === "1";
const repoRoot = args.find((a) => !a.startsWith("--")) || path.join(SCRIPT_DIR, "..");

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[0;32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const red = (s) => `\x1b[0;31m${s}\x1b[0m`;

function note(msg) {
  if (!quiet) console.log(dim(msg));
}

// Walk a directory recursively and return the newest .ts file mtime (ms), or 0 if
// the directory doesn't exist / has no .ts files. Mirrors tsconfig.json's include:
// ["src/operator-loop/**/*.ts", "src/timeline/**/*.ts"].
function newestTsMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const mtime = statSync(p).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  walk(dir);
  return newest;
}

const distIndex = path.join(repoRoot, "dist", "operator-loop", "index.js");
const distMtime = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;

const newestSrc = Math.max(
  newestTsMtime(path.join(repoRoot, "src", "operator-loop")),
  newestTsMtime(path.join(repoRoot, "src", "timeline"))
);

const missing = distMtime === 0;
const stale = !missing && newestSrc > distMtime;

if (!missing && !stale) {
  note("operator-loop: dist/ is up to date — nothing to build.");
  process.exit(0);
}

// tsc must be resolvable from repoRoot's node_modules for the build to work.
// `npm install --omit=dev` (or any prod-only install) leaves this absent — that's
// a valid, expected state, not an error. Skip gracefully; the CLI's die() message
// (or the demo-preflight-buildcheck skill) is the backstop that tells a human to
// install devDependencies and build manually.
const tscBin = path.join(repoRoot, "node_modules", ".bin", "tsc");
const tscPkg = path.join(repoRoot, "node_modules", "typescript", "package.json");
if (!existsSync(tscBin) && !existsSync(tscPkg)) {
  if (strict) {
    console.error(
      red(
        `operator-loop: dist/ is ${missing ? "missing" : "stale"} and typescript is not installed — ` +
          "cannot verify the workflow layer compiles.\n" +
          "  Install devDependencies (npm install) and run: npm run build:loop"
      )
    );
    process.exit(1);
  }
  note(
    "operator-loop: typescript not installed (devDependencies) — skipping automatic build.\n" +
      "  Install devDependencies and run: npm run build:loop"
  );
  process.exit(0);
}

note(`operator-loop: ${missing ? "not built" : "stale"} — running npm run build:loop…`);

try {
  execFileSync("npm", ["run", "build:loop", "--silent"], {
    cwd: repoRoot,
    // In strict mode always stream tsc's diagnostics — that IS the point.
    stdio: strict || !quiet ? "inherit" : "pipe",
    timeout: 120_000,
  });
  note(green("operator-loop: build:loop succeeded."));
} catch (e) {
  const reason = e && e.signal === "SIGTERM" ? "timed out after 120s" : "failed";
  if (strict) {
    console.error(
      red(
        `operator-loop: build:loop ${reason} — fix the TypeScript errors above before running tests ` +
          "(tests would otherwise run against stale dist/)."
      )
    );
    process.exit(1);
  }
  console.log(
    yellow(`operator-loop: automatic build:loop ${reason} — run it manually: npm run build:loop`)
  );
}

// Soft mode always exits 0 — best-effort by design; callers verify success by
// checking existsSync(dist/operator-loop/index.js) themselves. Strict mode has
// already exited nonzero above on any failure.
process.exit(0);
