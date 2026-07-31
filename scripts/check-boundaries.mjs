#!/usr/bin/env node
/**
 * Repo-boundary / seam gate (AIO-597, Wave 1 of the multi-repo split).
 *
 * This repo is being split into several repos (see ../CLAUDE.md §2c and RESOLVER.md "Repo
 * Topology" for the current state: aios-workspace core, @aiosbrain/foundation (published npm
 * package, née @aios-alpha/toolkit-common), aios-workspace-gui (cut; in-tree copy authoritative
 * until AIO-612), aios-devtools (planned), the operator-loop package (planned)). This validator
 * encodes the repo seams as import rules NOW, so
 * cross-seam coupling cannot accumulate before the cut. Bespoke check-* style (error text =
 * remediation prompt), not dependency-cruiser — parsing approach and reporting style mirror
 * `scripts/check-domain-isolation.mjs` (do not edit that file; it is a separate, orthogonal gate for
 * Engineering Constitution §4 domain isolation inside src/operator-loop).
 *
 * Rules (full text + rationale live in scripts/boundaries.json, machine-readable):
 *   R1 — scripts/<cmd>/* is importable only via its own top-level barrel scripts/<cmd>.mjs, or from
 *        another file inside the same scripts/<cmd>/ directory (same-dir siblings).
 *   R2 — hooks/** may import a top-level scripts/*.mjs barrel, never reach into a scripts/<cmd>/
 *        subdirectory directly.
 *   R3 — src/** (future @aios-alpha/operator-loop) must never import scripts/** (aios-workspace core /
 *        future @aios-alpha/toolkit-common).
 *   R4 — gui/server must not deep-import scripts/** at all, at any depth (future aios-workspace-gui
 *        seam contract: CLI --json output + @aios-alpha/toolkit-common only).
 *   R5 — nothing outside test/** may import test/** (tests are a leaf).
 *   R6 — core files must not import from the devtools path set (scripts/ship.mjs, scripts/ship/**,
 *        scripts/build.mjs, scripts/roadmap-run.mjs, scripts/spec-eval.mjs, scripts/spec-publish.mjs,
 *        scripts/consolidate-findings.mjs) — those files move to the aios-devtools repo (AIO-594).
 *        Devtools-internal imports are fine, and devtools files may import core (that is the
 *        dependency direction of the cut: devtools → core, never the reverse).
 *
 * Design decisions (documented here because they are NOT spelled out in boundaries.json):
 *   - Test files are exempt as an import SOURCE for R1–R4 and R6: any path under a `test/`
 *     directory, or matching `*.test.{mjs,cjs,ts,tsx,js}` anywhere (co-located tests like
 *     gui/server/foo.test.mjs), is never scanned. Tests routinely reach into implementation
 *     internals to unit-test them directly — that is normal and is not the coupling this gate
 *     exists to catch. For R6 specifically: which test files LEAVE with the devtools cut is
 *     decided by the extraction paths manifest (the AIO-603-style repo-cut rehearsal), not by
 *     this gate — a test importing ship.mjs is evidence it belongs in that manifest, not a seam
 *     violation. R5 is symmetric:
 *     it only restricts imports of test/** from OUTSIDE test/, so test-internal helper imports
 *     (e.g. test/ship-*.test.mjs → test/ship-test-helpers.mjs) are unaffected.
 *   - The `grandfathered` list in boundaries.json is ratchet-only-down: every entry is a REAL,
 *     measured (from, to) coupling in the tree at the time this gate was built, not a projection.
 *     Fixing a coupling and deleting its entry needs no permission; adding a new one does.
 *
 * Static parsing: static `import … from`, bare `import "x"`, dynamic `import("x")` (with or
 * without `await` — lazy loaders like `loader: () => import("../x.mjs")` count; AIO-594 review) /
 * `require("x")`. Reports file:line evidence; exits non-zero on any un-grandfathered violation.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitFiles } from "./git-files.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
// Rules travel with the script (co-located boundaries.json), independent of the tree being scanned
// (ROOT = cwd, matching scripts/check-domain-isolation.mjs's convention). Test-only override so
// test/check-boundaries.test.mjs can point at a small synthetic rules file instead of asserting
// against this repo's full, ever-changing grandfather list.
const RULES_PATH =
  process.env.CHECK_BOUNDARIES_RULES_PATH || path.join(SELF_DIR, "boundaries.json");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".aios",
  ".opencode",
]);

const SOURCE_EXT_RE = /\.(mjs|cjs|ts|tsx|js)$/;
const DECLARATION_EXT_RE = /\.d\.(m|c)?ts$/;

function loadRules() {
  const raw = JSON.parse(readFileSync(RULES_PATH, "utf8"));
  if (!Array.isArray(raw.rules) || !Array.isArray(raw.grandfathered)) {
    throw new Error(`${RULES_PATH} must have "rules" and "grandfathered" arrays`);
  }
  return raw;
}

function walkFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // dangling symlink etc.
    }
    if (st.isDirectory()) walkFiles(full, out);
    else if (SOURCE_EXT_RE.test(entry) && !DECLARATION_EXT_RE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Source files to scan, enumerated via git (AIO-517) rather than by walking the tree.
 * SKIP_DIR_NAMES is a hand-maintained list that has to track .gitignore to stay correct, and
 * it does not: `src-tauri/target` (1.6 GB / 35k files) has no entry, so the walk descends
 * into it. Git already knows exactly which content can reach a commit, so every ignored tree
 * is structurally invisible instead of being excluded by name.
 *
 * SKIP_DIR_NAMES is still applied on top, so a *tracked* build directory is treated exactly
 * as before — this narrows what is scanned, never widens it.
 *
 * Falls back to the walk when ROOT is not a git work tree, which is how the synthetic
 * fixture trees in test/check-boundaries.test.mjs are scanned.
 */
function enumerateSourceFiles(root) {
  const rels = gitFiles(root);
  if (!rels) return walkFiles(root, []);
  return rels
    .filter(
      (rel) =>
        SOURCE_EXT_RE.test(rel) &&
        !DECLARATION_EXT_RE.test(rel) &&
        !rel.split("/").some((segment) => SKIP_DIR_NAMES.has(segment))
    )
    .map((rel) => path.join(root, rel));
}

// Mirrors scripts/check-domain-isolation.mjs's parsing approach, extended to also recognize
// `export … from "…"` (re-export) — this repo's barrel files (e.g. scripts/review-bugbot.mjs)
// aggregate their subdirectory via re-export as much as via import, and src/operator-loop/parsers.ts
// (a real R3 grandfather) is ENTIRELY re-export statements with no plain `import` at all. The
// `^[ \t]*` line anchor is deliberate: without it, a non-greedy `[\s\S]*?` scan can start matching
// inside a comment that merely contains the word "import" or "export" (parsers.ts's own header
// comment does) and run on to an unrelated `from "…"` clause several statements later.
function parseStaticImports(content) {
  const out = [];
  const reFrom = /^[ \t]*(export|import)\s+(type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/gm;
  let m;
  while ((m = reFrom.exec(content)) !== null) {
    out.push({ mod: m[3], index: m.index, detail: `${m[1]} … from "${m[3]}"` });
  }
  const reBare = /^\s*import\s+["']([^"']+)["']/gm;
  while ((m = reBare.exec(content)) !== null) {
    out.push({ mod: m[1], index: m.index, detail: `import "${m[1]}"` });
  }
  return out;
}

function parseDynamicImports(content) {
  const out = [];
  const re = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({ mod: m[1], index: m.index, detail: `dynamic import("${m[1]}")` });
  }
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

// Any path under a `test/` directory component, or a co-located `*.test.<ext>` file, is exempt as
// an import SOURCE (see header comment).
function isTestFile(relPosixPath) {
  return /(^|\/)test\//.test(relPosixPath) || /\.test\.(mjs|cjs|ts|tsx|js)$/.test(relPosixPath);
}

// Resolve a relative import specifier to a repo-relative path. This repo's ESM imports always carry
// an explicit extension, but we fall back defensively to common resolutions so the gate doesn't
// silently blind itself if that ever changes.
function resolveImportTarget(fromAbs, mod) {
  if (!mod.startsWith(".")) return null; // bare specifier → external package, not our concern
  let target = path.resolve(path.dirname(fromAbs), mod);
  if (!existsSync(target)) {
    let found = false;
    for (const ext of [".mjs", ".ts", ".js", ".cjs"]) {
      if (existsSync(target + ext)) {
        target = target + ext;
        found = true;
        break;
      }
    }
    if (!found) {
      for (const idx of ["index.mjs", "index.ts", "index.js"]) {
        const cand = path.join(target, idx);
        if (existsSync(cand)) {
          target = cand;
          found = true;
          break;
        }
      }
    }
  }
  return toPosix(path.relative(ROOT, target));
}

// Returns the violated rule id, or null if the import is allowed.
function matchRule(fromRel, toRel) {
  // R5 is symmetric to the others: it restricts test/** as a TARGET, from any non-test source.
  if (/^test\//.test(toRel)) return "R5";

  // R6 — the devtools path set (AIO-594) as a TARGET, from any non-devtools source. Checked
  // before R1-R4 because the repo seam is the stronger claim; devtools-internal imports
  // (e.g. ship.mjs → build.mjs) fall through to the barrel rules below.
  if (DEVTOOLS_PATH_RE.test(toRel) && !DEVTOOLS_PATH_RE.test(fromRel)) return "R6";

  if (fromRel.startsWith("scripts/")) {
    const deep = toRel.match(/^scripts\/([^/]+)\/.+$/);
    if (!deep) return null; // target is a top-level scripts/*.mjs barrel → always fine
    const cmd = deep[1];
    const fromDir = path.posix.dirname(fromRel);
    const toDir = path.posix.dirname(toRel);
    if (fromDir === toDir) return null; // same-dir sibling inside scripts/<cmd>/
    if (fromRel === `scripts/${cmd}.mjs`) return null; // the cmd's own barrel importing its subdir
    return "R1";
  }

  if (fromRel.startsWith("hooks/")) {
    const deep = toRel.match(/^scripts\/([^/]+)\/.+$/);
    return deep ? "R2" : null; // hooks importing a top-level scripts/*.mjs barrel is fine
  }

  if (fromRel.startsWith("src/")) {
    return toRel.startsWith("scripts/") ? "R3" : null;
  }

  if (fromRel.startsWith("gui/server/")) {
    return toRel.startsWith("scripts/") ? "R4" : null;
  }

  return null;
}

// The devtools path set (AIO-594): the exact files moving to the aiosbrain/aios-devtools repo.
const DEVTOOLS_PATH_RE =
  /^scripts\/(ship\.mjs$|ship\/|build\.mjs$|roadmap-run\.mjs$|spec-eval\.mjs$|spec-publish\.mjs$|consolidate-findings\.mjs$)/;

function buildGrandfatherKey(from, to) {
  return `${from} ${to}`;
}

function run() {
  const { rules, grandfathered } = loadRules();
  const grandfatherSet = new Set(grandfathered.map((g) => buildGrandfatherKey(g.from, g.to)));
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const files = enumerateSourceFiles(ROOT);
  const violations = [];
  const usedGrandfather = new Set();

  for (const fileAbs of files) {
    const fileRel = toPosix(path.relative(ROOT, fileAbs));
    if (isTestFile(fileRel)) continue;

    const content = readFileSync(fileAbs, "utf8");
    const imports = [...parseStaticImports(content), ...parseDynamicImports(content)];

    for (const imp of imports) {
      const toRel = resolveImportTarget(fileAbs, imp.mod);
      if (!toRel) continue;

      const ruleId = matchRule(fileRel, toRel);
      if (!ruleId) continue;

      const key = buildGrandfatherKey(fileRel, toRel);
      if (grandfatherSet.has(key)) {
        usedGrandfather.add(key);
        continue;
      }

      violations.push({
        file: fileRel,
        line: lineOf(content, imp.index),
        to: toRel,
        ruleId,
        detail: imp.detail,
      });
    }
  }

  if (violations.length > 0) {
    console.error("✗ repo-boundary gate failed (AIO-597 — rules = future repo seams):\n");
    for (const v of violations) {
      const rule = ruleById.get(v.ruleId);
      console.error(`  ${v.file}:${v.line}  [${v.ruleId}]  ${v.detail} → ${v.to}`);
      if (rule) console.error(`      ${rule.description}`);
    }
    console.error(
      "\n  Fix by routing through the owning barrel / typed contract, or — if this genuinely cannot\n" +
        "  be fixed right now — add a specific { from, to, reason, issue } entry to scripts/boundaries.json\n" +
        '  under "grandfathered" (ratchet-only-down: new entries need a reason, not permission to add debt\n' +
        "  silently).\n"
    );
    process.exit(1);
  }

  const staleGrandfather = grandfathered.filter(
    (g) => !usedGrandfather.has(buildGrandfatherKey(g.from, g.to))
  );
  if (staleGrandfather.length > 0) {
    console.error(
      "✗ stale grandfather entries in scripts/boundaries.json (the coupling no longer exists):\n"
    );
    for (const g of staleGrandfather) {
      console.error(`  ${g.from} → ${g.to}`);
    }
    console.error(
      "\n  Remove the stale entries — grandfathers ratchet down, they never accumulate unused.\n"
    );
    process.exit(1);
  }

  console.log(
    `✓ repo-boundary gate clean (${files.length} files scanned, ${grandfathered.length} grandfathered couplings all still in use)`
  );
}

run();
