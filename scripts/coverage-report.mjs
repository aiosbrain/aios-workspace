#!/usr/bin/env node
/**
 * coverage-report.mjs — the ONE normalized coverage artifact reader/producer
 * (AIO-531 producer, folded into AIO-605 as a prerequisite; spec:
 * docs/v1-operator-loop/domains/codebase-health.md + test-coverage-brain.md).
 *
 * Detection precedence (first hit wins):
 *   1. coverage/coverage-report.json  — a pre-normalized artifact already matching this
 *      shape (the pluggability escape hatch: any stack can emit it via a tiny converter).
 *   2. coverage/coverage-summary.json — istanbul summary (`total` block).
 *   3. coverage/lcov.info             — LF/LH, FNF/FNH, BRF/BRH aggregate parse.
 *
 * Precedence 0, ahead of all three: a `coverage/coverage-degraded.json` marker means the run
 * measured only part of the repo, and NO number is publishable — see scripts/coverage-degraded.mjs
 * for why, and for the second half of that guard (the artifacts are also moved off the canonical
 * filenames, which is what reaches consumers that never call this module).
 *
 * Every consumer reads THIS module — the codebase-health scorer contains no second
 * coverage/lcov parser (one-artifact rule, asserted by a unit test). Output is
 * scalars only: percentages + a measured-at date. No file paths ever leave here.
 *
 * CLI: `node scripts/coverage-report.mjs [repo-path]` prints one normalized JSON
 * object; with no coverage artifact it prints `null` and exits 0 (default-deny
 * observable). Zero dependencies (node:* builtins only).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEGRADED_MARKER, readDegradedMarker } from "./coverage-degraded.mjs";

const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

function measuredAt(file) {
  try {
    return statSync(file).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function asPct(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** Precedence 1: a pre-normalized artifact. Valid only when lines_pct is a 0–100 number. */
function readPreNormalized(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || asPct(raw.lines_pct) === null) return null;
  return {
    source: "normalized",
    lines_pct: asPct(raw.lines_pct),
    statements_pct: asPct(raw.statements_pct),
    functions_pct: asPct(raw.functions_pct),
    branches_pct: asPct(raw.branches_pct),
    measured_at: typeof raw.measured_at === "string" ? raw.measured_at : measuredAt(file),
  };
}

/** Precedence 2: istanbul coverage-summary.json (`total.lines.pct` et al). */
function readIstanbulSummary(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const total = raw?.total;
  if (!total || asPct(total.lines?.pct) === null) return null;
  return {
    source: "istanbul",
    lines_pct: asPct(total.lines?.pct),
    statements_pct: asPct(total.statements?.pct),
    functions_pct: asPct(total.functions?.pct),
    branches_pct: asPct(total.branches?.pct),
    measured_at: measuredAt(file),
  };
}

/** Precedence 3: lcov.info — sum LF/LH (lines), FNF/FNH (functions), BRF/BRH (branches). */
function readLcov(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const sums = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };
  for (const line of text.split("\n")) {
    const m = line.match(/^(LF|LH|FNF|FNH|BRF|BRH):(\d+)/);
    if (m) sums[m[1]] += Number(m[2]);
  }
  if (sums.LF === 0) return null; // no line records → not a usable lcov artifact
  return {
    source: "lcov",
    lines_pct: pct1(sums.LH, sums.LF),
    statements_pct: null, // lcov has no statement records distinct from lines
    functions_pct: pct1(sums.FNH, sums.FNF),
    branches_pct: pct1(sums.BRH, sums.BRF),
    measured_at: measuredAt(file),
  };
}

/**
 * Read the repo's normalized coverage, or null when no artifact exists.
 * @param {string} repoPath
 * @returns {?{source:string, lines_pct:number, statements_pct:?number,
 *   functions_pct:?number, branches_pct:?number, measured_at:string, schema_version:1}}
 */
export function readCoverageReport(repoPath) {
  const dir = path.join(repoPath, "coverage");

  // A DEGRADED RUN HAS NO PUBLISHABLE NUMBER. When part of the measurement failed, what is on
  // disk is real data for everything that DID run — and completely indistinguishable, in shape
  // and in plausibility, from a complete measurement. Publishing it is the silent failure this
  // guard exists to prevent: measured on this repo, root-only coverage reads 81.87% lines /
  // 78.82% branches against floors of 79.70% / 71.50%, so every floor clears, nothing goes red,
  // and the number under-reports indefinitely. `null` is the loud direction — the health check
  // reports "no coverage artifact", which is visibly wrong and gets fixed.
  //
  // `run-coverage.mjs` ALSO moves the partial data off the canonical names, so consumers that
  // never call this function reach the same conclusion by finding nothing. This check is the
  // belt to that pair of braces, and the only one that can explain WHY.
  const degraded = readDegradedMarker(dir);
  if (degraded) {
    const preserved = Array.isArray(degraded.preserved) ? degraded.preserved.join(", ") : null;
    console.error(
      `coverage-report: refusing to publish a degraded measurement — ${degraded.reason}. ` +
        `The partial data is preserved${preserved ? ` as ${preserved}` : " in coverage/"}; fix ` +
        `the underlying failure rather than deleting coverage/${DEGRADED_MARKER}.`
    );
    return null;
  }

  const attempts = [
    [path.join(dir, "coverage-report.json"), readPreNormalized],
    [path.join(dir, "coverage-summary.json"), readIstanbulSummary],
    [path.join(dir, "lcov.info"), readLcov],
  ];
  for (const [file, reader] of attempts) {
    if (!existsSync(file)) continue;
    const result = reader(file);
    if (result) return { schema_version: 1, ...result };
  }
  return null;
}

// CLI: print the normalized object (or literal `null`), always exit 0.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || ".");
  console.log(JSON.stringify(readCoverageReport(repo), null, 2));
}
