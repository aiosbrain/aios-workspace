// toolkit-locate.mjs — the ONE toolkit-location contract for the GUI server (AIO-600 C5).
//
// The GUI server shells out to the toolkit CLI (`scripts/aios.mjs`) and optionally loads the
// compiled operator loop (`dist/operator-loop/index.js`). Pre-split, both lived at a hard-coded
// `../../` relative to gui/server; post-split the GUI repo cannot assume adjacency. Every toolkit
// path the GUI server (or its helpers) needs MUST resolve through this module — never a bare
// `path.join(HERE, "..", "..")`.
//
// Resolution order (documented in docs/gui-toolkit-contract.md):
//   (a) explicit `--toolkit-dir <path>` argv flag
//   (b) `AIOS_TOOLKIT_DIR` env var (set by the supported launcher, scripts/run-gui.mjs)
//   (c) adjacent-checkout compatibility fallback: gui/server/../../ (the pre-split layout)
//   (d) fail with an actionable error
// An EXPLICIT source (a/b) that points at a non-toolkit dir is a hard error — it never silently
// falls back, because a wrong-but-working fallback would spawn a different toolkit than the one
// the operator asked for. The resolved dir is realpath'd before anything is spawned from it, so
// symlinked checkouts (worktree layouts) can't yield mismatched relative paths later.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A directory qualifies as a toolkit root only if it has ALL of these. */
export const TOOLKIT_MARKERS = ["scripts/aios.mjs", "scaffold", "package.json"];

function missingMarkers(dir) {
  return TOOLKIT_MARKERS.filter((m) => !existsSync(path.join(dir, m)));
}

/**
 * Resolve the toolkit checkout per the contract above.
 * @param {{argv?: string[], env?: Record<string,string|undefined>, fallbackDir?: string}} [opts]
 * @returns {{dir: string, source: "--toolkit-dir"|"AIOS_TOOLKIT_DIR"|"adjacent-checkout"}}
 * @throws {Error} actionable message naming the candidate, its source, and the missing markers
 */
export function locateToolkit({
  argv = process.argv.slice(2),
  env = process.env,
  fallbackDir = path.resolve(HERE, "..", ".."),
} = {}) {
  const i = argv.indexOf("--toolkit-dir");
  let candidate;
  if (i !== -1) {
    // A PRESENT flag is an explicit source: a missing value (trailing flag, or another
    // option where the path should be) is a hard, actionable error — never a silent
    // fall-through to env/fallback, same rule as an explicit-but-invalid path.
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(
        "--toolkit-dir requires a path argument (got " +
          (value ? `'${value}'` : "nothing") +
          "). Pass --toolkit-dir <toolkit-checkout>, or drop the flag to use " +
          "AIOS_TOOLKIT_DIR / the adjacent-checkout fallback."
      );
    }
    candidate = { dir: value, source: "--toolkit-dir" };
  } else if (env.AIOS_TOOLKIT_DIR)
    candidate = { dir: env.AIOS_TOOLKIT_DIR, source: "AIOS_TOOLKIT_DIR" };
  else candidate = { dir: fallbackDir, source: "adjacent-checkout" };

  const abs = path.resolve(candidate.dir);
  const missing = existsSync(abs) ? missingMarkers(abs) : [...TOOLKIT_MARKERS];
  if (missing.length) {
    throw new Error(
      `cannot locate the AIOS toolkit: ${abs} (via ${candidate.source}) is missing ${missing.join(", ")}. ` +
        `Launch through the toolkit (\`npm run gui -- --repo <workspace>\`), or point the server at a ` +
        `toolkit checkout with \`--toolkit-dir <path>\` or AIOS_TOOLKIT_DIR.`
    );
  }
  return { dir: realpathSync(abs), source: candidate.source };
}

let _cached;
/** Memoized process-wide resolution (argv + env read once, consistent everywhere). */
export function getToolkit() {
  if (!_cached) _cached = locateToolkit();
  return _cached;
}

/** Absolute path of the toolkit CLI in the resolved toolkit. */
export function toolkitCli() {
  return path.join(getToolkit().dir, "scripts", "aios.mjs");
}
