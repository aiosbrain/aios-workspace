#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUMMARY_FILE = path.join(ROOT, "coverage", "coverage-summary.json");
const LCOV_FILE = path.join(ROOT, "coverage", "lcov.info");
const BASELINE_FILE = path.join(ROOT, "coverage-baseline.json");
const METRICS = ["lines", "statements", "functions", "branches"];
const SOURCE_PATHSPECS = [
  ":(glob)scripts/**/*.mjs",
  ":(glob)hooks/**/*.mjs",
  ":(glob)validation/**/*.mjs",
  ":(glob)packages/**/*.mjs",
  ":(glob)src/**/*.ts",
];
// Test/coverage/build-lane infrastructure: excluded from instrumentation in
// .c8rc.json and exempt from the missing-LCOV fail-closed check. Keep this
// list and the .c8rc.json "exclude" tool-script entries in lockstep.
const COVERAGE_TOOL_FILES = new Set([
  "scripts/test-suite.mjs",
  "scripts/run-coverage.mjs",
  "scripts/merge-coverage.mjs",
  "scripts/check-coverage.mjs",
  "scripts/run-mutation.mjs",
  "scripts/ensure-loop-built.mjs",
]);

// A large PR diff easily exceeds execFileSync's default 1 MiB maxBuffer and
// would kill the required coverage lane with ENOBUFS.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
}

// Decode a git C-style quoted path ("b/caf\303\251.ts") to its literal form.
export function unquoteGitPath(raw) {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  const simpleEscapes = new Map([
    ["a", 0x07],
    ["b", 0x08],
    ["f", 0x0c],
    ["n", 0x0a],
    ["r", 0x0d],
    ["t", 0x09],
    ["v", 0x0b],
    ["\\", 0x5c],
    ['"', 0x22],
  ]);
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "\\" || i === inner.length - 1) {
      bytes.push(...Buffer.from(inner[i], "utf8"));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length;
    } else {
      const next = inner[i + 1];
      const mapped = simpleEscapes.get(next);
      if (mapped === undefined) bytes.push(...Buffer.from(next, "utf8"));
      else bytes.push(mapped);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function parseChangedLines(diff) {
  const changed = new Map();
  let file = null;
  // Only a "+++" line inside a file header block (opened by "diff --git",
  // before the first hunk) names a file. An *added source line* whose content
  // starts "++ b/…" also renders as "+++ b/…" but appears inside a hunk, and
  // must never be taken as a header (it would misattribute later hunks).
  let inHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (line.startsWith("@@")) inHeader = false;
    if (inHeader && line.startsWith("+++ ")) {
      const target = unquoteGitPath(line.slice(4));
      file = target.startsWith("b/") ? target.slice(2) : null; // "+++ /dev/null" = deletion
      if (file && !changed.has(file)) changed.set(file, new Set());
      inHeader = false;
      continue;
    }
    if (!file || !line.startsWith("@@")) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) {
      changed.get(file).add(lineNumber);
    }
  }
  return changed;
}

export function parseLcov(text, root = ROOT) {
  const coverage = new Map();
  let file = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      const raw = line.slice(3);
      const absolute = path.isAbsolute(raw) ? raw : path.join(root, raw);
      file = path.relative(root, absolute).split(path.sep).join("/");
      if (!coverage.has(file)) coverage.set(file, new Map());
    } else if (file && line.startsWith("DA:")) {
      const [lineNumber, hits] = line.slice(3).split(",").map(Number);
      coverage.get(file).set(lineNumber, hits);
    } else if (line === "end_of_record") {
      file = null;
    }
  }
  return coverage;
}

export function changedLineCoverage(changed, coverage) {
  let total = 0;
  let covered = 0;
  const files = [];
  for (const [file, lines] of changed) {
    const executed = coverage.get(file);
    if (!executed) continue;
    let fileTotal = 0;
    let fileCovered = 0;
    for (const line of lines) {
      if (!executed.has(line)) continue;
      fileTotal += 1;
      if (executed.get(line) > 0) fileCovered += 1;
    }
    if (fileTotal) files.push({ file, total: fileTotal, covered: fileCovered });
    total += fileTotal;
    covered += fileCovered;
  }
  return { total, covered, pct: total ? Number(((covered / total) * 100).toFixed(2)) : 100, files };
}

export function isCoverageSource(file) {
  const normalized = file.split(path.sep).join("/");
  if (COVERAGE_TOOL_FILES.has(normalized) || /\.test\.[^/]+$/.test(normalized)) return false;
  // Declaration files carry no executable code and never appear in LCOV —
  // exempt them everywhere (a src/**/*.d.ts would otherwise false-positive
  // the fail-closed missing-LCOV check).
  if (/\.d\.ts$/.test(normalized)) return false;
  return (
    /^(?:scripts|hooks|validation)\/.+\.mjs$/.test(normalized) || /^src\/.+\.ts$/.test(normalized)
  );
}

export function missingCoverageFiles(changed, coverage) {
  return [...changed.keys()].filter((file) => isCoverageSource(file) && !coverage.has(file)).sort();
}

export function resolveBase(explicit, gitCommand = git, env = process.env) {
  const candidates = explicit
    ? [explicit]
    : [env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null, "origin/main"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      gitCommand(["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      // Try the next authoritative base. Never silently narrow to HEAD^.
    }
  }
  throw new Error(
    `cannot resolve coverage diff base (${candidates.join(", ")}); ` +
      "fetch the base branch or pass --base <ref>"
  );
}

export function resolveMergeBase(explicit, gitCommand = git, env = process.env) {
  const target = resolveBase(explicit, gitCommand, env);
  try {
    const base = gitCommand(["merge-base", target, "HEAD"]).trim();
    if (!base) throw new Error("empty merge base");
    return base;
  } catch (error) {
    throw new Error(`cannot compute merge base between ${target} and HEAD`, { cause: error });
  }
}

export function coverageDiffArgs(base) {
  // --default-prefix: a developer's `diff.noprefix=true` git config would strip
  // the a/ b/ prefixes parseChangedLines keys on, degrading the changed-line
  // gate to a vacuous 100% (0/0) locally.
  return ["diff", "--default-prefix", "--unified=0", "--no-color", base, "--", ...SOURCE_PATHSPECS];
}

function roundedFloor(value) {
  return Math.floor(value * 10) / 10;
}

// Coverage totals jitter a few hundredths of a point between identical CI runs
// (timing-dependent branches); a floor equal to the live value goes red on noise.
const BASELINE_JITTER_MARGIN = 0.2;

export function buildBaseline(summary) {
  return {
    version: 1,
    minimum: Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        Math.max(0, roundedFloor(summary.total[metric].pct - BASELINE_JITTER_MARGIN)),
      ])
    ),
    changedLines: 80,
  };
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function inlineValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv, env = process.env) {
  const options = { writeBaseline: false, base: null, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write-baseline") options.writeBaseline = true;
    else if (arg === "--base") options.base = requiredValue(argv, i++, "--base");
    else if (arg.startsWith("--base=")) options.base = inlineValue(arg, "--base");
    else if (arg === "--output") options.output = requiredValue(argv, i++, "--output");
    else if (arg.startsWith("--output=")) options.output = inlineValue(arg, "--output");
    else throw new Error(`unknown coverage option: ${arg}`);
  }
  if (options.writeBaseline && !options.output) {
    throw new Error(
      "--write-baseline requires --output <path>; use the CI-generated candidate as the tracked baseline"
    );
  }
  if (!options.writeBaseline && options.output) {
    throw new Error("--output requires --write-baseline");
  }
  if (options.writeBaseline && env.GITHUB_ACTIONS !== "true") {
    throw new Error("--write-baseline is restricted to GitHub Actions");
  }
  return options;
}

function writeBaseline(summary, output) {
  const outputFile = path.resolve(ROOT, output);
  const relative = path.relative(ROOT, outputFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("--output must stay inside the repository");
  }
  writeFileSync(outputFile, `${JSON.stringify(buildBaseline(summary), null, 2)}\n`);
  console.log(`coverage: wrote CI baseline candidate to ${relative}`);
}

function main(argv) {
  const options = parseArgs(argv);
  if (!existsSync(SUMMARY_FILE) || !existsSync(LCOV_FILE)) {
    throw new Error("coverage reports are missing; run npm run test:coverage:report first");
  }
  const summary = JSON.parse(readFileSync(SUMMARY_FILE, "utf8"));
  if (options.writeBaseline) {
    writeBaseline(summary, options.output);
    return;
  }
  if (!existsSync(BASELINE_FILE)) {
    throw new Error("coverage-baseline.json is missing");
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const failures = [];
  for (const metric of METRICS) {
    const actual = summary.total[metric].pct;
    const minimum = baseline.minimum[metric];
    if (actual < minimum) failures.push(`${metric}: ${actual}% < ${minimum}% baseline`);
  }

  // Compare the PR's own changes, not reverse changes from a moving main tip
  // when a long-running worktree temporarily falls behind origin/main.
  const base = resolveMergeBase(options.base);
  const diff = git(coverageDiffArgs(base));
  const changed = parseChangedLines(diff);
  const lcov = parseLcov(readFileSync(LCOV_FILE, "utf8"));
  const missing = missingCoverageFiles(changed, lcov);
  if (missing.length) {
    failures.push(`changed production files missing from LCOV: ${missing.join(", ")}`);
  }
  const changedResult = changedLineCoverage(changed, lcov);
  if (changedResult.pct < baseline.changedLines) {
    failures.push(
      `changed executable lines: ${changedResult.pct}% < ${baseline.changedLines}% ` +
        `(${changedResult.covered}/${changedResult.total})`
    );
  }

  console.log(
    `coverage: lines ${summary.total.lines.pct}% · branches ${summary.total.branches.pct}% · ` +
      `changed lines ${changedResult.pct}% (${changedResult.covered}/${changedResult.total})`
  );
  if (failures.length) throw new Error(`coverage gate failed\n- ${failures.join("\n- ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
