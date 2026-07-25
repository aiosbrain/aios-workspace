#!/usr/bin/env node
/**
 * Coverage runner with an optional CI sharding contract.
 *
 * - no flags:        client Vitest coverage, then the full Node suite under c8,
 *                    then merge into the stable PR artifacts (current behavior).
 * - --shard <k>/<n>: run only that shard of the Node suite under c8, leaving the
 *                    shard's raw V8 coverage data under coverage/shard-<k>/.
 *                    No final report, no gate check. Exits nonzero on failure.
 * - --merge <n>:     run client Vitest coverage, then merge coverage/shard-1..n/
 *                    into the standard outputs check-coverage.mjs consumes
 *                    (coverage/coverage-summary.json + coverage/lcov.info) plus
 *                    the baseline candidate coverage/coverage-baseline-candidate.json.
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseline } from "./check-coverage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const C8 = path.join(ROOT, "node_modules", "c8", "bin", "c8.js");
const COVERAGE_DIR = path.join(ROOT, "coverage");
const OUTPUT_SUMMARY = path.join(COVERAGE_DIR, "coverage-summary.json");
const CANDIDATE_FILE = path.join(COVERAGE_DIR, "coverage-baseline-candidate.json");

export function shardDirectory(index, root = ROOT) {
  return path.join(root, "coverage", `shard-${index}`);
}

function parsePositiveInt(raw, label) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== String(raw).trim()) {
    throw new Error(`${label} must be a positive integer (received ${JSON.stringify(raw)})`);
  }
  return value;
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

export function parseArgs(argv) {
  let shard = null;
  let merge = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--shard") shard = requiredValue(argv, i++, "--shard");
    else if (arg.startsWith("--shard=")) shard = inlineValue(arg, "--shard");
    else if (arg === "--merge") merge = requiredValue(argv, i++, "--merge");
    else if (arg.startsWith("--merge=")) merge = inlineValue(arg, "--merge");
    else throw new Error(`unknown run-coverage option: ${arg}`);
  }
  if (shard && merge) throw new Error("--shard and --merge are mutually exclusive");
  const options = { mode: "full", shard: null, merge: null };
  if (shard) {
    const match = /^(\d+)\/(\d+)$/.exec(shard);
    if (!match) throw new Error(`--shard must use INDEX/TOTAL syntax (received ${shard})`);
    const index = parsePositiveInt(match[1], "shard index");
    const total = parsePositiveInt(match[2], "shard total");
    if (index > total) throw new Error(`shard index ${index} exceeds total ${total}`);
    options.mode = "shard";
    options.shard = { index, total, raw: `${index}/${total}` };
  } else if (merge) {
    options.mode = "merge";
    options.merge = parsePositiveInt(merge, "--merge shard total");
  }
  return options;
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited ${signal ? `with ${signal}` : `with status ${code}`}`));
    });
  });
}

function runClientCoverage() {
  return execute("npm", ["run", "test:coverage", "--workspace", "gui/client"]);
}

async function runNodeSuiteUnderC8(tempDirectory, extraSuiteArgs = [], extraC8Args = []) {
  await execute(process.execPath, [
    C8,
    "--temp-directory",
    tempDirectory,
    ...extraC8Args,
    process.execPath,
    "scripts/test-suite.mjs",
    "--concurrency=4",
    ...extraSuiteArgs,
  ]);
}

async function runFull() {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-"));
  try {
    rmSync(COVERAGE_DIR, { recursive: true, force: true });
    rmSync(path.join(ROOT, "gui", "client", "coverage"), { recursive: true, force: true });

    // Keep the independently configured reports separate and deterministic.
    // Client coverage is sub-second; sequencing it avoids future port/fixture
    // conflicts if browser tests grow integration coverage.
    await runClientCoverage();
    await runNodeSuiteUnderC8(tempDirectory);
    await execute(process.execPath, ["scripts/merge-coverage.mjs"]);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function runShard(shard) {
  const shardDir = shardDirectory(shard.index);
  rmSync(shardDir, { recursive: true, force: true });
  // c8 collects raw V8 data into the shard directory; --reporter=none skips
  // report generation — the merge step is the only report/gate producer.
  await runNodeSuiteUnderC8(
    shardDir,
    [`--shard=${shard.raw}`],
    ["--reporter=none", "--clean=false"]
  );
  console.log(`run-coverage: shard ${shard.raw} raw coverage in ${path.relative(ROOT, shardDir)}`);
}

export function collectShardFiles(total, root = ROOT) {
  const missing = [];
  const files = [];
  for (let index = 1; index <= total; index += 1) {
    const dir = shardDirectory(index, root);
    const entries = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    if (!entries.length) {
      missing.push(path.relative(root, dir));
      continue;
    }
    for (const entry of entries) {
      // Prefix with the shard index: V8 file names (coverage-<pid>-<ts>-<n>.json)
      // can collide across shard runs from different machines.
      files.push({ source: path.join(dir, entry), name: `coverage-s${index}-${entry}` });
    }
  }
  if (missing.length) {
    throw new Error(`run-coverage: missing shard coverage data in: ${missing.join(", ")}`);
  }
  return files;
}

async function runMerge(total) {
  const files = collectShardFiles(total);
  rmSync(path.join(COVERAGE_DIR, "root"), { recursive: true, force: true });
  rmSync(path.join(ROOT, "gui", "client", "coverage"), { recursive: true, force: true });
  rmSync(OUTPUT_SUMMARY, { force: true });
  rmSync(path.join(COVERAGE_DIR, "lcov.info"), { force: true });

  await runClientCoverage();

  const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-merge-"));
  try {
    for (const file of files) copyFileSync(file.source, path.join(tempDirectory, file.name));
    // Report over the union of every shard's raw V8 data with the same
    // .c8rc.json include/exclude/remap rules as the unsharded run.
    await execute(process.execPath, [C8, "report", "--temp-directory", tempDirectory]);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }

  await execute(process.execPath, ["scripts/merge-coverage.mjs"]);

  const summary = JSON.parse(readFileSync(OUTPUT_SUMMARY, "utf8"));
  mkdirSync(COVERAGE_DIR, { recursive: true });
  writeFileSync(CANDIDATE_FILE, `${JSON.stringify(buildBaseline(summary), null, 2)}\n`);
  console.log(
    `run-coverage: merged ${total} shard(s) → coverage/coverage-summary.json, ` +
      "coverage/lcov.info, coverage/coverage-baseline-candidate.json"
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === "shard") await runShard(options.shard);
  else if (options.mode === "merge") await runMerge(options.merge);
  else await runFull();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
