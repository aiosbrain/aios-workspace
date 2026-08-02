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
 *   (c) the in-tree implementation at `scripts/<name>.mjs`, while it still exists
 *   (d) the installed `@aiosbrain/aios-devtools` package
 *   (e) fail with an actionable error naming what was tried
 *
 * (c) BEFORE (d) is deliberate and load-bearing for this PR. Until the removal PR lands, CLAUDE.md
 * §2c says the in-tree `scripts/` implementations are authoritative — so preferring the published
 * package here would silently swap which code runs (npm 0.2.0 vs this checkout's HEAD) as a side
 * effect of a seam change. With this order the seam is a behavioural NO-OP today: every load
 * resolves to exactly the file the old static import named. When the removal PR deletes those
 * files, (c) simply stops matching and (d) takes over, with no further change here.
 *
 * An EXPLICIT source (a/b) that doesn't resolve is a hard error — it never silently falls back,
 * for the same reason toolkit-locate refuses to: a wrong-but-working fallback would run different
 * code than the operator asked for.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The devtools-bound command set (AIO-594). Keys are both the in-tree basename and the
 *  package subpath export, which is why one name serves both resolution paths. */
export const DEVTOOLS_MODULES = Object.freeze([
  "ship",
  "build",
  "roadmap-run",
  "spec-eval",
  "spec-publish",
  "consolidate-findings",
]);

export const DEVTOOLS_PACKAGE = "@aiosbrain/aios-devtools";

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
  const i = argv.indexOf("--devtools-dir");
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(
        "--devtools-dir requires a path argument (got " +
          (value ? `'${value}'` : "nothing") +
          `). Pass --devtools-dir <aios-devtools-checkout>, or drop the flag to use ` +
          `AIOS_DEVTOOLS_DIR.`
      );
    }
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
 * Load a devtools module at point of use.
 *
 * A missing package is turned into an actionable install instruction rather than a bare
 * ERR_MODULE_NOT_FOUND — post-cut this is the error an operator without devtools installed will
 * actually hit, and "Cannot find package" with no next step is exactly the failure the contract
 * exists to prevent.
 */
export async function loadDevtoolsModule(name, opts = {}) {
  const resolved = resolveDevtoolsModule(name, opts);
  try {
    return await import(resolved.specifier);
  } catch (error) {
    if (
      resolved.kind === "package" &&
      /ERR_MODULE_NOT_FOUND|Cannot find package/.test(String(error?.message))
    ) {
      throw new Error(
        `the '${name}' command lives in ${DEVTOOLS_PACKAGE}, which is not installed.\n` +
          `  Install it:            npm i -D ${DEVTOOLS_PACKAGE}\n` +
          `  Or point at a checkout: AIOS_DEVTOOLS_DIR=<path-to-aios-devtools>\n` +
          `  See docs/devtools-toolkit-contract.md.`
      );
    }
    throw error;
  }
}
