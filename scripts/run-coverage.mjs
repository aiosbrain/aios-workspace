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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFull, runMerge, runShard } from "./run-coverage/modes.mjs";

export {
  clientWorkspaceStatus,
  collectShardFiles,
  hasClientWorkspace,
  mergeThenPropagate,
  runClientCoverageIfPresent,
  shardDirectory,
} from "./run-coverage/runtime.mjs";
export { runFull, runMerge } from "./run-coverage/modes.mjs";

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

/**
 * The real dispatcher. `deps` ({ root, exec }) defaults to this checkout and a real spawn, and is
 * overridden ONLY by tests — which drive this entry point rather than the guard helper, so a
 * regression that unguards one mode's `runClientCoverage` call is caught at the call site.
 */
export async function main(argv, deps = {}) {
  const options = parseArgs(argv);
  if (options.mode === "shard") await runShard(options.shard, deps);
  else if (options.mode === "merge") await runMerge(options.merge, deps);
  else await runFull(deps);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
