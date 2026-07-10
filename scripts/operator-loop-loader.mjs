/**
 * operator-loop-loader.mjs — dynamic loader for the compiled operator loop (AIO-315).
 *
 * The operator loop (C1 collector + manifest, C2 evidence ledger, …) is TypeScript
 * (workflow layer, per the Engineering Constitution), compiled to dist/operator-loop.
 * It is imported dynamically so no command depends on the build at import time; if it
 * isn't built, we self-heal once and otherwise fail with a clear hint rather than a
 * module-not-found stack.
 *
 * Extracted from scripts/aios.mjs so the handler modules (mode.mjs, loop.mjs, asks.mjs,
 * decisions.mjs, time.mjs, …) can all load the loop without importing back from aios.mjs.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { c, die } from "./cli-common.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function loadOperatorLoop() {
  const distPath = path.join(SCRIPT_DIR, "..", "dist", "operator-loop", "index.js");
  if (!existsSync(distPath)) {
    // Self-heal: fresh clones / worktrees may never have run `npm run build:loop`
    // (postinstall and worktree hydration both attempt it, but neither is a hard
    // guarantee — e.g. `npm install --omit=dev`, or hydration ran before this file
    // existed). Try once, synchronously, before falling back to die().
    console.log(c.dim("operator-loop is not built — building it now (first run)…"));
    try {
      execFileSync(process.execPath, [path.join(SCRIPT_DIR, "ensure-loop-built.mjs")], {
        cwd: path.join(SCRIPT_DIR, ".."),
        stdio: "inherit",
        timeout: 120_000,
      });
    } catch {
      // ensure-loop-built.mjs is itself best-effort and always exits 0; this only
      // catches a hard failure to spawn node or an execFileSync timeout kill. Fall
      // through to the existsSync check below either way.
    }
    if (!existsSync(distPath)) {
      die("operator-loop is not built — run: npm run build:loop");
    }
    console.log(c.green("✓ operator-loop built."));
  }
  return import(pathToFileURL(distPath).href);
}
