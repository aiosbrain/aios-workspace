#!/usr/bin/env node
/**
 * Canonical Node test-suite discovery and runner.
 *
 * Every checked-in Node test under TEST_ROOTS is discovered recursively and
 * passed to one node:test invocation. node:test keeps file-level process
 * isolation while avoiding the startup cost of hundreds of serial Node
 * processes. The GUI client's Vitest suite left with the AIO-612 cut and now lives in
 * aiosbrain/aios-workspace-gui; this discovers Node tests only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NODE_TEST_ROOTS = ["test", "scripts"];
// test/test-suite.test.mjs imports this so its git-parity oracle can never silently disagree
// with what the runner actually executes.
export const NODE_TEST_FILE_RE = /\.test\.(?:mjs|js)$/;
// Test-looking sources a Node root can NOT execute — tracked files matching this
// under a Node root fail discovery loudly instead of being silently unrun.
const UNRUNNABLE_NODE_TEST_RE = /\.test\.(?:ts|tsx|mts|cts|cjs|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", "coverage", "dist", "target", ".git"]);

function walk(relativeRoot, matches) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  const found = [];
  const visit = (absoluteDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
      }
    }
  };
  visit(absoluteRoot);
  return found;
}

// Discovery is tracked-files-only: untracked scratch tests and gitignored
// artifact dirs never run (and never break the git-parity oracle). Returns null
// when git is unavailable (e.g. an npm-tarball install), in which case discovery
// falls back to the pure filesystem walk.
let trackedSetCache;
export function trackedFileSet() {
  if (trackedSetCache !== undefined) return trackedSetCache;
  const result = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  trackedSetCache =
    result.error || result.status !== 0 ? null : new Set(result.stdout.split("\0").filter(Boolean));
  return trackedSetCache;
}

function inSkippedDir(file) {
  return file
    .split("/")
    .slice(0, -1)
    .some((segment) => SKIP_DIRS.has(segment));
}

// Pure so the guard itself is testable: given a tracked-file list, return the
// tracked Node-root test files whose extension no Node-root runner executes.
export function findUnrunnableNodeTests(trackedFiles) {
  return [...trackedFiles]
    .filter(
      (file) =>
        NODE_TEST_ROOTS.some((root) => file.startsWith(`${root}/`)) &&
        !inSkippedDir(file) &&
        UNRUNNABLE_NODE_TEST_RE.test(file)
    )
    .sort();
}

function filterTracked(files) {
  const tracked = trackedFileSet();
  return tracked ? files.filter((file) => tracked.has(file)) : files;
}

export function discoverNodeTests() {
  const tracked = trackedFileSet();
  if (tracked) {
    const unrunnable = findUnrunnableNodeTests(tracked);
    if (unrunnable.length) {
      throw new Error(
        "tracked Node-root test file(s) with an extension the Node runner cannot execute " +
          `(convert to .mjs/.js): ${unrunnable.join(", ")}`
      );
    }
  }
  return filterTracked(
    NODE_TEST_ROOTS.flatMap((root) => walk(root, (name) => NODE_TEST_FILE_RE.test(name)))
  ).sort();
}

export function discoverTestInventory() {
  const node = discoverNodeTests();
  // `all` used to be the sorted union of the Node and client roots. The client half left with
  // gui/client (AIO-612), so it is now a copy of an already-sorted list — no re-sort. A bare
  // .sort() here is also a real defect, not just redundancy: it sorts by UTF-16 code unit, which
  // is only correct for these paths by accident, and SonarCloud flags it (javascript:S2871).
  // A copy, not an alias, so a caller mutating one cannot silently reorder the other.
  return { node, all: [...node] };
}

function parsePositiveInt(raw, label) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer (received ${JSON.stringify(raw)})`);
  }
  return value;
}

export function parseShard(raw) {
  if (!raw) return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) throw new Error(`--shard must use INDEX/TOTAL syntax (received ${raw})`);
  const index = parsePositiveInt(match[1], "shard index");
  const total = parsePositiveInt(match[2], "shard total");
  if (index > total) throw new Error(`shard index ${index} exceeds total ${total}`);
  return `${index}/${total}`;
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function inlineValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    list: false,
    json: false,
    liveInstall: false,
    shard: process.env.AIOS_TEST_SHARD || null,
    concurrency: process.env.AIOS_TEST_CONCURRENCY || null,
    only: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") options.list = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--live-install") options.liveInstall = true;
    else if (arg === "--shard") options.shard = requiredValue(argv, i++, "--shard");
    else if (arg.startsWith("--shard=")) options.shard = inlineValue(arg, "--shard");
    else if (arg === "--concurrency") {
      options.concurrency = requiredValue(argv, i++, "--concurrency");
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = inlineValue(arg, "--concurrency");
    } else if (arg === "--only") options.only.push(requiredValue(argv, i++, "--only"));
    else if (arg.startsWith("--only=")) options.only.push(inlineValue(arg, "--only"));
    else throw new Error(`unknown test-suite option: ${arg}`);
  }
  options.shard = parseShard(options.shard);
  options.concurrency = options.concurrency
    ? parsePositiveInt(options.concurrency, "concurrency")
    : Math.min(4, availableParallelism());
  return options;
}

function resolveOnly(files, requested) {
  if (!requested.length) return files;
  const normalized = new Set(requested.map((file) => file.replaceAll("\\", "/")));
  const unknown = [...normalized].filter((file) => !files.includes(file));
  if (unknown.length) throw new Error(`unknown test file(s): ${unknown.join(", ")}`);
  return files.filter((file) => normalized.has(file));
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const inventory = discoverTestInventory();
  const files = resolveOnly(inventory.node, options.only);
  if (!files.length) throw new Error("no Node test files discovered");

  if (options.list) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...inventory, selected: files }, null, 2)}\n`);
    } else {
      for (const file of files) process.stdout.write(`${file}\n`);
      process.stderr.write(`discovered ${inventory.all.length} Node tests\n`);
    }
    return 0;
  }

  const nodeArgs = ["--test", `--test-concurrency=${options.concurrency}`];
  if (options.shard) nodeArgs.push(`--test-shard=${options.shard}`);
  nodeArgs.push(...files);

  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      AIOS_TEST_SUITE: "1",
      // A developer's ambient AIOS_BUGBOT_DISABLE=1 (aios/.envrc exports it for local
      // convenience) must not leak into the test process — see test/local-bugbot-gate.test.mjs.
      AIOS_BUGBOT_DISABLE: "",
      ...(options.liveInstall ? { AIOS_LIVE_INSTALL_TESTS: "1" } : {}),
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write(`test-suite: ${error.message}\n`);
    process.exitCode = 1;
  }
}
