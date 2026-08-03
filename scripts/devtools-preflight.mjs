#!/usr/bin/env node
/**
 * devtools-preflight.mjs — is the devtools distribution actually usable? (AIO-665)
 *
 * Sibling of `gui-runtime-preflight.mjs`: the GUI seam has a preflight because resolving a
 * package is not the same as proving the thing can run. The devtools seam has the same gap, and
 * a sharper one — `@aiosbrain/aios-devtools` is resolved through FOUR different sources
 * (`--devtools-dir`, `AIOS_DEVTOOLS_DIR`, an in-tree copy, the installed package), so "it works
 * on my machine" can mean four different code paths. This reports which one is live.
 *
 * Read-only. Never throws for a missing devtools — absence is a reportable state, not a crash,
 * because the five delegated commands are supposed to fail individually with their own
 * actionable error rather than taking the whole CLI down.
 *
 * CLI: `node scripts/devtools-preflight.mjs [--json]`
 *   exit 0 — every dispatch target resolves
 *   exit 1 — at least one does not (the report says which, and why)
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVTOOLS_MODULES, DEVTOOLS_PACKAGE, resolveDevtoolsModule } from "./devtools-dispatch.mjs";

const require = createRequire(import.meta.url);

/** The installed package's version, or null when it isn't installed. */
export function devtoolsPackageVersion({ req = require } = {}) {
  try {
    return req(`${DEVTOOLS_PACKAGE}/package.json`).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The declared dependency range for devtools in this repo's package.json — the thing that
 * decides what a FRESH install gets, as opposed to what happens to be in node_modules here.
 */
export function declaredDevtoolsRange({ pkg } = {}) {
  const manifest =
    pkg ?? require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
  return (
    manifest.dependencies?.[DEVTOOLS_PACKAGE] ??
    manifest.devDependencies?.[DEVTOOLS_PACKAGE] ??
    manifest.peerDependencies?.[DEVTOOLS_PACKAGE] ??
    null
  );
}

// Exact npm semver only: no comparators, partials, wildcards, tags, aliases, URLs, or compound
// ranges. Pre-release/build metadata remain valid exact versions.
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactDevtoolsVersion(value) {
  return typeof value === "string" && EXACT_SEMVER.test(value.trim());
}

/**
 * Resolve every dispatch target and report where each one comes from.
 * @returns {{ok: boolean, declared: ?string, installed: ?string, modules: Array<object>}}
 */
export function checkDevtools(opts = {}) {
  const { req = require } = opts;
  const declared = declaredDevtoolsRange(opts);
  const modules = DEVTOOLS_MODULES.map((name) => {
    let r;
    try {
      r = resolveDevtoolsModule(name, opts);
    } catch (error) {
      return { name, ok: false, source: null, error: error.message };
    }
    // resolveDevtoolsModule only BUILDS a specifier — for the package branch it returns
    // "@aiosbrain/aios-devtools/ship" without checking anything exists. Reporting that as ✓
    // is precisely the false pass this preflight is supposed to catch, so actually resolve it.
    // (The file branches are already existence-checked inside resolveDevtoolsModule.)
    if (r.kind === "package") {
      try {
        req.resolve(r.specifier);
      } catch (error) {
        return {
          name,
          ok: false,
          source: r.source,
          error: `${r.specifier} does not resolve — ${DEVTOOLS_PACKAGE} is not installed (or does not export ./${name})`,
        };
      }
    }
    return { name, ok: true, source: r.source, specifier: r.specifier };
  });
  return {
    ok: modules.every((m) => m.ok) && (declared === null || isExactDevtoolsVersion(declared)),
    declared,
    installed: devtoolsPackageVersion(opts),
    modules,
  };
}

/**
 * Human-readable lines. Separated from the check so `aios` surfaces and CI can share the
 * verdict without either owning the formatting.
 */
export function formatDevtoolsReport(report) {
  const lines = [];
  lines.push(`devtools: ${DEVTOOLS_PACKAGE}`);
  lines.push(`  declared:  ${report.declared ?? "<not a dependency>"}`);
  lines.push(`  installed: ${report.installed ?? "<not installed>"}`);
  // Anything but an exact registry version defeats the reproducibility guarantee. This includes
  // comparators, partials, wildcards, tags and local/workspace sources — not only caret/tilde.
  if (report.declared && !isExactDevtoolsVersion(report.declared)) {
    lines.push(
      `  ✗ pin:      '${report.declared}' is not an EXACT VERSION — use a full semver such as 0.2.0`
    );
  }
  for (const m of report.modules) {
    lines.push(
      m.ok ? `  ✓ ${m.name.padEnd(22)} via ${m.source}` : `  ✗ ${m.name.padEnd(22)} ${m.error}`
    );
  }
  if (report.modules.some((m) => !m.ok)) {
    lines.push("");
    lines.push(`  Install it:             npm i ${DEVTOOLS_PACKAGE}`);
    lines.push("  Or point at a checkout: AIOS_DEVTOOLS_DIR=<path-to-aios-devtools>");
    lines.push(
      "  Rollback:               npm i -g @aiosbrain/aios@0.9.1 (last release with in-tree devtools)"
    );
  }
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDevtools();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDevtoolsReport(report).join("\n"));
  process.exit(report.ok ? 0 : 1);
}
