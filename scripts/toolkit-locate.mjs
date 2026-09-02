/**
 * toolkit-locate.mjs — the ONE toolkit-location contract for the devtools-bound command set
 * (AIO-594; docs/devtools-toolkit-contract.md).
 *
 * The devtools files (ship.mjs, ship/, build.mjs, roadmap-run.mjs, spec-eval.mjs,
 * spec-publish.mjs, consolidate-findings.mjs) move to the aios-devtools repo. Core-staying
 * engines they invoke (review-bugbot.mjs, simplify.mjs, relay.mjs, spec-author.mjs) MUST be
 * loaded through `loadToolkitModule()` — never a static `import` — so the same files run both
 * in-monorepo and standalone with core available as a toolkit checkout. Sibling of the GUI's
 * `gui/server/toolkit-locate.mjs` (AIO-600 C5): same markers, same explicit-source-never-falls-
 * back rule, different fallback (the containing repo root, which IS the toolkit pre-cut).
 *
 * Resolution order:
 *   (a) explicit `--toolkit-dir <path>` argv flag (or a `toolkitDir` param)
 *   (b) `AIOS_TOOLKIT_DIR` env var
 *   (c) the containing repo root, when it looks like a toolkit (pre-cut: always)
 *   (d) fail with an actionable error naming AIOS_TOOLKIT_DIR
 * An EXPLICIT source (a/b) that points at a non-toolkit dir is a hard error — it never silently
 * falls back, because a wrong-but-working fallback would run a different toolkit than the one
 * the operator asked for. The resolved dir is realpath'd so in-monorepo seam loads resolve to
 * the same module URLs as the pre-seam static imports (one ESM cache entry, not two instances).
 *
 * PARITY (AIO-663, copy-ledger row 16): this file is byte-identical to
 * `scripts/toolkit-locate.mjs` in `aiosbrain/aios-devtools`, and that repo's
 * `scripts/check-copy-parity.mjs` fails CI when the two diverge. Both copies therefore carry the
 * FULL API surface even where one side has no in-repo caller — core keeps `stripToolkitDirArgs()`
 * (only the devtools commands call it) rather than let the module that defines the split's seam
 * disagree with itself across the split. Change it in both repos, in the same shape, or neither.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DISTRIBUTION_MARKERS, missingDistributionMarkers, isDistributionRoot } from "./cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Toolkit detection is the ONE classifier in `scripts/cli/distribution-root.mjs`
 * (AIO-635 Decision 3) — this module re-exports the marker set and boolean under their
 * historical names so the devtools copy and the GUI's sibling keep a stable surface.
 * A `checkout` OR `registry` (npm-installed / unpacked tarball) root both qualify.
 */
export const TOOLKIT_MARKERS = DISTRIBUTION_MARKERS;

function missingMarkers(dir) {
  return missingDistributionMarkers(dir);
}

export function looksLikeToolkit(dir) {
  return isDistributionRoot(dir);
}

/**
 * The single validation rule for the flag's value, shared by `locateToolkit` and
 * `stripToolkitDirArgs` so the flag cannot mean one thing to the locator and another to the
 * normalizer. Any leading `-` is rejected, not just `--`: short flags (`-h`, `-n`) are real, and
 * `stripToolkitDirArgs` DROPS the value it consumes, so a lenient rule would silently swallow the
 * following option and then fail with a confusing "cannot locate the AIOS toolkit: <cwd>/-h".
 * A genuine path starting with `-` is still reachable as `./-h`.
 */
function requireToolkitDirValue(value) {
  if (!value || value.startsWith("-")) {
    throw new Error(
      "--toolkit-dir requires a path argument (got " +
        (value ? `'${value}'` : "nothing") +
        "). Pass --toolkit-dir <toolkit-checkout>, or drop the flag to use AIOS_TOOLKIT_DIR."
    );
  }
  return value;
}

/** Remove the global toolkit selector before command-specific positional parsing. */
export function stripToolkitDirArgs(argv = []) {
  const normalized = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--toolkit-dir") {
      normalized.push(argv[i]);
      continue;
    }
    requireToolkitDirValue(argv[i + 1]);
    i++;
  }
  return normalized;
}

/**
 * Resolve the toolkit checkout per the contract above.
 * @param {{toolkitDir?: string, argv?: string[], env?: Record<string,string|undefined>,
 *          containingRoot?: string}} [opts]
 * @returns {{dir: string, source: "--toolkit-dir"|"AIOS_TOOLKIT_DIR"|"containing-repo"}}
 * @throws {Error} actionable message naming the candidate, its source, and the missing markers
 */
export function locateToolkit({
  toolkitDir,
  argv = process.argv.slice(2),
  env = process.env,
  containingRoot = path.resolve(HERE, ".."),
} = {}) {
  const i = argv.indexOf("--toolkit-dir");
  let candidate;
  if (toolkitDir) {
    candidate = { dir: toolkitDir, source: "--toolkit-dir" };
  } else if (i !== -1) {
    // A PRESENT flag is an explicit source: a missing value (trailing flag, or another option
    // where the path should be) is a hard, actionable error — never a silent fall-through.
    const value = requireToolkitDirValue(argv[i + 1]);
    candidate = { dir: value, source: "--toolkit-dir" };
  } else if (env.AIOS_TOOLKIT_DIR) {
    candidate = { dir: env.AIOS_TOOLKIT_DIR, source: "AIOS_TOOLKIT_DIR" };
  } else {
    candidate = { dir: containingRoot, source: "containing-repo" };
  }

  const abs = path.resolve(candidate.dir);
  const missing = existsSync(abs) ? missingMarkers(abs) : [...TOOLKIT_MARKERS];
  if (missing.length) {
    throw new Error(
      `cannot locate the AIOS toolkit: ${abs} (via ${candidate.source}) is missing ` +
        `${missing.join(", ")}. Set AIOS_TOOLKIT_DIR to an aios-workspace checkout ` +
        `(or pass --toolkit-dir <path>). See docs/devtools-toolkit-contract.md.`
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

/**
 * Load a core-staying `scripts/<rel>` module from the resolved toolkit at point-of-use.
 * In-monorepo this resolves to the very same file the old static imports named, so Node's
 * ESM cache yields the same module instances as before — no behavior change.
 */
export async function loadToolkitModule(rel) {
  return import(pathToFileURL(path.join(getToolkit().dir, "scripts", rel)).href);
}
