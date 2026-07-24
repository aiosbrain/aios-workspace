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
const SOURCE_PATHSPECS = [":(glob)**/*.mjs", ":(glob)**/*.js", ":(glob)**/*.ts", ":(glob)**/*.tsx"];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

export function parseChangedLines(diff) {
  const changed = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (!changed.has(file)) changed.set(file, new Set());
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
  return ["diff", "--unified=0", "--no-color", base, "--", ...SOURCE_PATHSPECS];
}

function roundedFloor(value) {
  return Math.floor(value * 10) / 10;
}

export function buildBaseline(summary) {
  return {
    version: 1,
    minimum: Object.fromEntries(
      METRICS.map((metric) => [metric, roundedFloor(summary.total[metric].pct)])
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
