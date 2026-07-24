#!/usr/bin/env node
/**
 * Canonical Node test-suite discovery and runner.
 *
 * Every checked-in Node test under TEST_ROOTS is discovered recursively and
 * passed to one node:test invocation. node:test keeps file-level process
 * isolation while avoiding the startup cost of hundreds of serial Node
 * processes. GUI client tests are deliberately owned by Vitest.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_TEST_ROOTS = ["test", "gui/server", "scripts"];
const CLIENT_TEST_ROOT = "gui/client/src";
const TEST_FILE_RE = /\.test\.(?:mjs|js|ts|tsx)$/;
const NODE_TEST_FILE_RE = /\.test\.(?:mjs|js)$/;
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

export function discoverNodeTests() {
  return NODE_TEST_ROOTS.flatMap((root) =>
    walk(root, (name) => NODE_TEST_FILE_RE.test(name))
  ).sort();
}

export function discoverClientTests() {
  return walk(CLIENT_TEST_ROOT, (name) => TEST_FILE_RE.test(name)).sort();
}

export function discoverTestInventory() {
  const node = discoverNodeTests();
  const client = discoverClientTests();
  return { node, client, all: [...node, ...client].sort() };
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
    else if (arg === "--shard") options.shard = argv[++i];
    else if (arg.startsWith("--shard=")) options.shard = arg.slice("--shard=".length);
    else if (arg === "--concurrency") options.concurrency = argv[++i];
    else if (arg.startsWith("--concurrency=")) {
      options.concurrency = arg.slice("--concurrency=".length);
    } else if (arg === "--only") options.only.push(argv[++i]);
    else if (arg.startsWith("--only=")) options.only.push(arg.slice("--only=".length));
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
      process.stderr.write(
        `discovered ${inventory.all.length} tests (${inventory.node.length} Node, ${inventory.client.length} client)\n`
      );
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
