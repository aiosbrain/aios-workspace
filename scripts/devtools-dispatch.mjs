/**
 * devtools-dispatch.mjs — the ONE devtools-location contract for core (AIO-661).
 *
 * The mirror image of `toolkit-locate.mjs`. That module is how a devtools file reaches back into
 * core (devtools → core). This one is how CORE reaches OUT to devtools (core → devtools), which
 * is the direction the AIO-594 cut says must not exist as a static import: R6 in
 * `scripts/boundaries.json` forbids core importing `ship.mjs`, `ship/**`, `build.mjs`,
 * `roadmap-run.mjs`, `spec-eval.mjs`, `spec-publish.mjs`, `consolidate-findings.mjs`.
 *
 * Two callers legitimately need that direction anyway:
 *   - `scripts/cli/registry.mjs` — registers the five devtools commands so `aios ship` etc. still
 *     dispatch. Registration-only; nothing loads until the command actually runs.
 *   - `scripts/relay.mjs` — a core-staying orchestrator that drives `build` and the LLM spec-eval
 *     layer. These were the two hardest R6 grandfathers and the reason the removal PR was blocked.
 *
 * Both now load through `loadDevtoolsModule()` at POINT OF USE, so nothing is pulled in unless the
 * path that needs it actually executes.
 *
 * Resolution order:
 *   (a) explicit `--devtools-dir <path>` argv flag (or a `devtoolsDir` param)
 *   (b) `AIOS_DEVTOOLS_DIR` env var
 *   (c) an in-tree implementation at `scripts/<name>.mjs`, if one exists
 *   (d) the installed `@aiosbrain/aios-devtools` package
 *   (e) fail with an actionable error naming what was tried
 *
 * (c) is now dormant in this repo: AIO-662 deleted the in-tree implementations, so every load
 * resolves through (d). It is retained because it is what made the seam land as a behavioural
 * no-op — while the in-tree copies were still authoritative, preferring the package would have
 * silently swapped which code runs (npm's release vs this checkout's HEAD) as a side effect of a
 * seam change. It also still serves anyone running against a tree that has not taken the removal.
 *
 * An EXPLICIT source (a/b) that doesn't resolve is a hard error — it never silently falls back,
 * for the same reason toolkit-locate refuses to: a wrong-but-working fallback would run different
 * code than the operator asked for.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The devtools modules CORE dispatches to (AIO-594). Names are both the in-tree basename and the
 * package subpath export, which is why one name serves both resolution paths.
 *
 * `spec-publish` is deliberately NOT here. It is devtools-INTERNAL — reached through
 * `spec-eval.mjs`, never dispatched from core — and correspondingly it is not in the
 * `@aiosbrain/aios-devtools` package `exports` map. Listing it made this set "every devtools
 * file" rather than "every core dispatch target", which only showed up once the in-tree copies
 * were gone and resolution actually had to go through the package (AIO-662).
 */
export const DEVTOOLS_MODULES = Object.freeze([
  "ship",
  "build",
  "roadmap-run",
  "spec-eval",
  "consolidate-findings",
]);

export const DEVTOOLS_PACKAGE = "@aiosbrain/aios-devtools";

/**
 * Consume the core-owned global checkout selector from a command's argument list.
 *
 * `loadDevtoolsModule()` reads the original process argv to select the implementation, while the
 * selected command must receive only its own arguments. Keeping both sides on this parser prevents
 * the selector path from being mistaken for a build plan or an unknown spec option.
 *
 * @param {string[]} argv mutated in place
 * @returns {?string} the selected directory, or null when the flag was absent
 */
export function consumeDevtoolsDirArg(argv) {
  const i = argv.indexOf("--devtools-dir");
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(
      "--devtools-dir requires a path argument (got " +
        (value ? `'${value}'` : "nothing") +
        `). Pass --devtools-dir <aios-devtools-checkout>, or drop the flag to use ` +
        `AIOS_DEVTOOLS_DIR.`
    );
  }
  argv.splice(i, 2);
  return value;
}

function assertKnown(name) {
  if (!DEVTOOLS_MODULES.includes(name)) {
    throw new Error(
      `unknown devtools module '${name}'. Known: ${DEVTOOLS_MODULES.join(", ")}. ` +
        `See docs/devtools-toolkit-contract.md.`
    );
  }
}

/** The explicit override, if the operator gave one. Returns null when they did not. */
export function explicitDevtoolsDir({
  devtoolsDir,
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  if (devtoolsDir) return { dir: devtoolsDir, source: "--devtools-dir" };
  const value = consumeDevtoolsDirArg([...argv]);
  if (value) {
    return { dir: value, source: "--devtools-dir" };
  }
  if (env.AIOS_DEVTOOLS_DIR) return { dir: env.AIOS_DEVTOOLS_DIR, source: "AIOS_DEVTOOLS_DIR" };
  return null;
}

/**
 * Resolve where a given devtools module should be loaded from, without loading it.
 * Exported so the resolution contract is testable without side effects.
 *
 * @param {string} name one of DEVTOOLS_MODULES
 * @returns {{kind: "file", specifier: string, source: string} | {kind: "package", specifier: string, source: string}}
 */
export function resolveDevtoolsModule(name, opts = {}) {
  assertKnown(name);
  const { coreScripts = HERE } = opts;

  const explicit = explicitDevtoolsDir(opts);
  if (explicit) {
    const file = path.resolve(explicit.dir, "scripts", `${name}.mjs`);
    if (!existsSync(file)) {
      throw new Error(
        `cannot locate devtools module '${name}': ${file} (via ${explicit.source}) does not ` +
          `exist. Point ${explicit.source} at an aios-devtools checkout, or unset it to use the ` +
          `installed ${DEVTOOLS_PACKAGE}. See docs/devtools-toolkit-contract.md.`
      );
    }
    return { kind: "file", specifier: pathToFileURL(file).href, source: explicit.source };
  }

  // In-tree, while it lasts. Pre-cut this always matches and the seam is a no-op.
  const inTree = path.join(coreScripts, `${name}.mjs`);
  if (existsSync(inTree)) {
    return { kind: "file", specifier: pathToFileURL(inTree).href, source: "in-tree" };
  }

  return { kind: "package", specifier: `${DEVTOOLS_PACKAGE}/${name}`, source: DEVTOOLS_PACKAGE };
}

/**
 * Core's own package root — the toolkit that owns `.claude/rubrics/`, the scaffold, and every
 * other core-owned asset a devtools module may need to read.
 */
export function coreToolkitDir({ coreScripts = HERE } = {}) {
  return path.resolve(coreScripts, "..");
}

/**
 * Tell an OUT-OF-TREE devtools module which toolkit it is running against.
 *
 * `scripts/toolkit-locate.mjs` falls back to "the repo containing this file". That is correct
 * in-tree, where the containing repo IS the toolkit — and wrong for every other layout, because
 * from an installed (or checked-out) `@aiosbrain/aios-devtools` it names the devtools root, which
 * ships no `scaffold/` and no `scripts/aios.mjs` and therefore is not a toolkit at all. Core is
 * the only participant that knows where the toolkit is, so core supplies it.
 *
 * PRECEDENCE IS PRESERVED, NOT OVERRIDDEN: an explicit `--toolkit-dir` or a pre-set
 * `AIOS_TOOLKIT_DIR` always wins, and the in-tree case is left alone so its resolution source
 * stays `containing-repo` exactly as before. This only fills a gap that would otherwise be a
 * hard error (AIO-686, copy-ledger row 13).
 */
export function applyToolkitDefault(resolved, opts = {}) {
  const { argv = process.argv.slice(2), env = process.env } = opts;
  if (resolved.source === "in-tree") return null;
  if (env.AIOS_TOOLKIT_DIR || argv.includes("--toolkit-dir")) return null;
  const dir = coreToolkitDir(opts);
  env.AIOS_TOOLKIT_DIR = dir;
  return dir;
}

/**
 * Load a devtools module at point of use.
 *
 * A missing package is turned into an actionable install instruction rather than a bare
 * ERR_MODULE_NOT_FOUND — post-cut this is the error an operator without devtools installed will
 * actually hit, and "Cannot find package" with no next step is exactly the failure the contract
 * exists to prevent.
 */
export async function loadDevtoolsModule(name, opts = {}) {
  const resolved = resolveDevtoolsModule(name, opts);
  applyToolkitDefault(resolved, opts);
  try {
    return await import(resolved.specifier);
  } catch (error) {
    throw missingPackageError(name, resolved, error, opts.command) ?? error;
  }
}

/**
 * Map a failed package load onto an actionable install instruction, or null when the failure is
 * something else and must surface as-is.
 *
 * Separated from `loadDevtoolsModule` so it stays testable now that `@aiosbrain/aios-devtools` is
 * a real dependency: the "package missing" path can no longer be reached by simply not having it
 * installed, and a test that silently stopped exercising the branch would be worse than no test.
 */
export function missingPackageError(name, resolved, error, command = name) {
  if (resolved.kind !== "package") return null;
  if (
    !/ERR_MODULE_NOT_FOUND|Cannot find package|is not defined by "exports"/.test(
      String(error?.message)
    )
  ) {
    return null;
  }
  // Name the command the OPERATOR typed, not the module it happens to resolve to. `aios spec`
  // loads the `spec-eval` module, and telling someone their "'spec-eval' command" is missing
  // sends them looking for a command that does not exist.
  const named = command === name ? `'${command}'` : `'${command}' (${name})`;
  return new Error(
    `the ${named} command lives in ${DEVTOOLS_PACKAGE}, which is not installed ` +
      `(or does not export ./${name}).\n` +
      `  Install it:             npm i ${DEVTOOLS_PACKAGE}\n` +
      `  Or point at a checkout: AIOS_DEVTOOLS_DIR=<path-to-aios-devtools>\n` +
      `  See docs/devtools-toolkit-contract.md.`
  );
}
