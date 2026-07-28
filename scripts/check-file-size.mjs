#!/usr/bin/env node
/**
 * File-size gate v2 (AIO-596) — default-deny.
 *
 * AIO-320 shipped this gate as an enumerated ALLOWLIST: only the handful of files named in
 * `scripts/size-caps.json` were capped, everything else was ungated. That let brand-new
 * monster files grow unchecked as long as nobody added them to the list. This version flips
 * the polarity: every file matched by `include` (minus `exclude`) is subject to a single
 * `defaultCap`, line-count via `wc -l` semantics (newline count, matching the command line).
 *
 * Files that were already over `defaultCap` when the gate flipped are pinned in
 * `grandfathered` at their measured line count — a per-file ratchet CEILING, not a target.
 * That ceiling only ever moves DOWN as a file shrinks (via `--ratchet`, see below) or when a
 * file is fully extracted below `defaultCap` and its entry is deleted; it never moves up. A
 * brand-new file is never grandfathered — the moment it crosses `defaultCap` the gate fails,
 * full stop.
 *
 * Enumeration goes through `gitFiles()` (tracked + untracked-but-not-ignored), never a raw
 * filesystem walk — see scripts/git-files.mjs (AIO-517): a walk would descend into gitignored
 * build trees (`dist/`, `src-tauri/target/`) that `include`/`exclude` globs would otherwise
 * have to know to skip.
 *
 * Usage:
 *   node scripts/check-file-size.mjs             # enforce: exit 1 if anything is over its cap
 *   node scripts/check-file-size.mjs --ratchet    # also lower (never raise) any grandfathered
 *                                                  # cap whose file has shrunk below it, and
 *                                                  # persist that back to size-caps.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { gitFiles } from "./git-files.mjs";
import { globToRegex } from "../validation/agent-readiness-lib.mjs";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "scripts", "size-caps.json");
const RATCHET = process.argv.includes("--ratchet");

function countLines(abs) {
  const content = readFileSync(abs, "utf8");
  const nl = content.match(/\n/g);
  return nl ? nl.length : content.length > 0 ? 1 : 0;
}

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function matchesAny(rel, regexes) {
  return regexes.some((re) => re.test(rel));
}

/**
 * Deterministic code-unit ordering. Explicitly NOT `localeCompare`: this gate's output
 * (and the grandfathered list generated from it) has to be byte-identical on a
 * contributor's machine and on the CI runner, and locale collation is neither stable
 * across ICU versions nor independent of the environment's locale.
 */
const comparePaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Repo-relative paths (POSIX, sorted) matched by `include` and not by `exclude`. */
function enumerateTargets(config) {
  const files = gitFiles(ROOT);
  if (!files) {
    console.error(
      `✗ file-size gate: ${ROOT} is not a git work tree — cannot enumerate via \`git ls-files\`.`
    );
    process.exit(1);
  }
  const includeRe = config.include.map(globToRegex);
  const excludeRe = config.exclude.map(globToRegex);
  return files
    .filter((rel) => matchesAny(rel, includeRe) && !matchesAny(rel, excludeRe))
    .sort(comparePaths);
}

const config = loadConfig();
const defaultCap = config.defaultCap;
const grandfathered = config.grandfathered ?? {};
const targets = enumerateTargets(config);

const measurements = {};
const over = [];
const ratchetLowered = [];

for (const rel of targets) {
  let lines;
  try {
    lines = countLines(path.join(ROOT, rel));
  } catch {
    continue; // listed by git but unreadable right now (e.g. a broken symlink) — not this gate's job
  }
  measurements[rel] = lines;
  const isGrandfathered = Object.hasOwn(grandfathered, rel);
  const cap = isGrandfathered ? grandfathered[rel] : defaultCap;
  if (lines > cap) {
    over.push({ rel, lines, cap, isGrandfathered });
  } else if (RATCHET && isGrandfathered && lines < cap) {
    ratchetLowered.push({ rel, from: cap, to: lines });
  }
}

// A grandfathered entry whose file no longer matches (deleted, renamed, or shrunk below
// defaultCap and cleaned up) is advisory-only — that's usually the extraction PR doing its job.
const staleGrandfathered = Object.keys(grandfathered).filter((rel) => !(rel in measurements));

if (RATCHET && ratchetLowered.length > 0) {
  const nextGrandfathered = { ...grandfathered };
  for (const { rel, to } of ratchetLowered) nextGrandfathered[rel] = to;
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...config, grandfathered: nextGrandfathered }, null, 2) + "\n"
  );
  console.log(`↓ ratchet: lowered ${ratchetLowered.length} grandfathered cap(s):`);
  for (const { rel, from, to } of ratchetLowered) console.log(`  ${rel}: ${from} → ${to}`);
}

if (staleGrandfathered.length > 0) {
  console.log(
    `  (note: ${staleGrandfathered.length} grandfathered path(s) no longer matched — ` +
      `deleted, renamed, or extracted below cap: ${staleGrandfathered.join(", ")})`
  );
}

if (over.length > 0) {
  console.error("✗ file-size gate exceeded:\n");
  for (const o of over) {
    const label = o.isGrandfathered ? "grandfathered cap" : "default cap";
    console.error(`  ${o.rel}: ${o.lines} lines > ${label} ${o.cap} (over by ${o.lines - o.cap})`);
  }
  console.error(
    "\n  Extract to bring it under the cap. A grandfathered file may never grow past its recorded\n" +
      "  cap in scripts/size-caps.json — shrink the file (then optionally run --ratchet to lower\n" +
      "  the recorded cap to match). New files are never grandfathered."
  );
  process.exit(1);
}

console.log(
  `✓ file-size gate clean (${targets.length} files scanned, default cap ${defaultCap} lines, ` +
    `${Object.keys(grandfathered).length} grandfathered)`
);
