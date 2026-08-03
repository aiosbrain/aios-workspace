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

// Root-derived so `runFull`/`runMerge` can be driven against a fixture root in tests instead of
// only against this checkout.
function coveragePaths(root) {
  const dir = path.join(root, "coverage");
  return {
    dir,
    summary: path.join(dir, "coverage-summary.json"),
    candidate: path.join(dir, "coverage-baseline-candidate.json"),
    lcov: path.join(dir, "lcov.info"),
  };
}

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

// Tests shell out to repo-local CLIs (e.g. dotenvx); when this script is run as
// `node scripts/run-coverage.mjs` (not via `npm run`), node_modules/.bin isn't on
// PATH, so prepend it the way npm would.
const LOCAL_BIN_PATH = [path.join(ROOT, "node_modules", ".bin"), process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter);

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, PATH: LOCAL_BIN_PATH },
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

const CLIENT_WORKSPACE = "gui/client";

function runClientCoverage(exec = execute) {
  return exec("npm", ["run", "test:coverage", "--workspace", CLIENT_WORKSPACE]);
}

function rootWorkspacePatterns(root) {
  // An unreadable/unparseable root manifest means npm cannot resolve ANY workspace, so treating
  // it as "no workspaces" matches what the npm call would do — without throwing from the guard.
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const list = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : manifest.workspaces?.packages;
    return Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function matchesWorkspacePattern(pattern, target) {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  // Single pass, so no sentinel can collide with literal text in the pattern.
  const source = normalized.replace(/\*\*|\*|[.+^${}()|[\]\\?]/g, (token) => {
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    return `\\${token}`;
  });
  return new RegExp(`^${source}$`).test(target);
}

/**
 * Why `gui/client` cannot be covered here — or `"present"` when it can.
 *
 * TWO conditions, because either one alone is a false positive:
 *
 * - the manifest `gui/client/package.json` must exist. A bare `gui/client/` directory (stale
 *   build output, an untracked `coverage/` left behind after the sources go) is not a workspace;
 *   npm resolves `--workspace gui/client` through the manifest.
 * - the root `package.json` `workspaces` array must still match `gui/client`. AIO-612 PR-B
 *   deregisters the workspace at one stage and deletes the tree at a later one, so the repo
 *   passes THROUGH a state where the manifest is still on disk but npm already answers
 *   `No workspaces found: --workspace=gui/client` and exits 1. A manifest-only predicate returns
 *   true there, the command fails, and in `runFull` that failure is swallowed by
 *   scan-on-merge.yml's `|| true` — the exact null-coverage incident this guard exists to stop.
 *
 * @param {string} root
 * @returns {"present" | "no-manifest" | "deregistered"}
 */
export function clientWorkspaceStatus(root = ROOT) {
  if (!existsSync(path.join(root, "gui", "client", "package.json"))) return "no-manifest";
  const registered = rootWorkspacePatterns(root).some((pattern) =>
    matchesWorkspacePattern(pattern, CLIENT_WORKSPACE)
  );
  return registered ? "present" : "deregistered";
}

export function hasClientWorkspace(root = ROOT) {
  return clientWorkspaceStatus(root) === "present";
}

/**
 * Run the client Vitest coverage pass, or skip it loudly when `gui/client` is not a usable
 * workspace.
 *
 * Both callers (`runFull` and `runMerge`) go through here. `runMerge` is exercised by CI's
 * coverage job; `runFull` is NOT exercised by any CI job — it is reached only via
 * `npm run test:coverage`, which scan-on-merge.yml runs under `|| true`. So a `runFull` that
 * throws here fails silently and the scanner pushes `test_coverage_pct: null`. Guarding one site
 * and not the other would look green and report nothing.
 *
 * @param {() => Promise<void>} run
 * @param {string} root
 * @returns {Promise<boolean>} whether the client pass actually ran
 */
export async function runClientCoverageIfPresent(run = runClientCoverage, root = ROOT) {
  const status = clientWorkspaceStatus(root);
  if (status !== "present") {
    // Same terminology as merge-coverage.mjs's "(root only — no gui/client report)" so the skip
    // reads as a deliberate decision in CI output, not as a step that quietly did nothing. The
    // reason is named because "deleted" and "still on disk but deregistered" want different
    // follow-ups from whoever is reading the log.
    console.log(
      `run-coverage: skipping gui/client coverage (root only — ${
        status === "no-manifest"
          ? "no gui/client workspace"
          : "gui/client is no longer a registered npm workspace"
      })`
    );
    return false;
  }
  await run();
  return true;
}

// Modes that execute the Node suite must fail on a TS compile error with one
// tsc diagnostic instead of dozens of ERR_MODULE_NOT_FOUND failures against a
// missing/stale dist/ (same guard as `npm run test:node`). Merge mode only
// reports over already-collected data, so it is exempt.
function ensureLoopBuiltStrict(exec = execute) {
  return exec(process.execPath, ["scripts/ensure-loop-built.mjs", "--strict"]);
}

async function runNodeSuiteUnderC8(
  tempDirectory,
  extraSuiteArgs = [],
  extraC8Args = [],
  exec = execute
) {
  await exec(process.execPath, [
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

/**
 * Run the suite, then produce the coverage artifact WHETHER OR NOT the suite passed, then
 * propagate the suite's failure.
 *
 * Injectable so the ordering contract is testable without spawning a real suite. The invariant:
 * `merge` is always attempted, and a suite failure always wins as the thrown error.
 *
 * @param {() => Promise<void>} runSuite
 * @param {() => Promise<void>} merge
 */
export async function mergeThenPropagate(runSuite, merge) {
  let suiteError;
  try {
    await runSuite();
  } catch (error) {
    suiteError = error;
  }

  try {
    await merge();
  } catch (mergeError) {
    // A merge failure on its own is real and must surface. After a suite failure it is usually
    // a consequence (a crash so early that c8 wrote nothing), and masking the original failure
    // with it would send you debugging the wrong thing.
    if (!suiteError) throw mergeError;
    console.error(`coverage artifact unavailable after suite failure: ${mergeError.message}`);
  }

  if (suiteError) throw suiteError;
}

export async function runFull({ root = ROOT, exec = execute } = {}) {
  const paths = coveragePaths(root);
  await ensureLoopBuiltStrict(exec);
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-"));
  try {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(path.join(root, "gui", "client", "coverage"), { recursive: true, force: true });

    // Keep the independently configured reports separate and deterministic.
    // Client coverage is sub-second; sequencing it avoids future port/fixture
    // conflicts if browser tests grow integration coverage.
    await runClientCoverageIfPresent(() => runClientCoverage(exec), root);

    // The suite's pass/fail and the coverage ARTIFACT are two different outputs, and they were
    // coupled: a single failing test threw here, so merge-coverage.mjs never ran and
    // coverage/coverage-summary.json was never written.
    //
    // That silently destroyed the metric. scan-on-merge.yml runs `npm run test:coverage || true`
    // — deliberately, because coverage is a metrics source and must never block the scan — so the
    // throw was swallowed, the scan proceeded, the scanner found no artifact, and pushed
    // test_coverage_pct: null. The Codebases dashboard then showed this repo with no coverage at
    // all despite a 2500-test suite. It had never once reported.
    //
    // c8 writes its report even when the wrapped process exits nonzero (verified), so the raw
    // data for everything that DID execute is already on disk by the time we get here. Produce
    // the artifact, THEN propagate the failure — the gate keeps failing exactly as before.
    await mergeThenPropagate(
      () => runNodeSuiteUnderC8(tempDirectory, [], [], exec),
      () => exec(process.execPath, ["scripts/merge-coverage.mjs"])
    );
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function runShard(shard, { root = ROOT, exec = execute } = {}) {
  await ensureLoopBuiltStrict(exec);
  const shardDir = shardDirectory(shard.index, root);
  rmSync(shardDir, { recursive: true, force: true });
  // c8 collects raw V8 data into the shard directory; --reporter=none skips
  // report generation — the merge step is the only report/gate producer.
  await runNodeSuiteUnderC8(
    shardDir,
    [`--shard=${shard.raw}`],
    ["--reporter=none", "--clean=false"],
    exec
  );
  console.log(`run-coverage: shard ${shard.raw} raw coverage in ${path.relative(root, shardDir)}`);
}

export function collectShardFiles(total, root = ROOT) {
  // The shard total is written in three places (ci.yml coverage-shard matrix,
  // `--shard k/N`, `--merge N`). If they drift, extra shard-<k> data beyond the
  // merge total would be silently ignored, under-reporting coverage — refuse.
  const coverageRoot = path.join(root, "coverage");
  const strays = (existsSync(coverageRoot) ? readdirSync(coverageRoot) : [])
    .filter((entry) => {
      const match = /^shard-(\d+)$/.exec(entry);
      return match !== null && Number.parseInt(match[1], 10) > total;
    })
    .sort()
    .map((entry) => `coverage/${entry}`);
  if (strays.length) {
    throw new Error(
      `run-coverage: shard data beyond --merge ${total} exists: ${strays.join(", ")} — ` +
        "the shard total drifted (ci.yml coverage-shard matrix, --shard and --merge " +
        "must agree); merging a subset would under-report coverage"
    );
  }
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

export async function runMerge(total, { root = ROOT, exec = execute } = {}) {
  const paths = coveragePaths(root);
  const files = collectShardFiles(total, root);
  rmSync(path.join(paths.dir, "root"), { recursive: true, force: true });
  rmSync(path.join(root, "gui", "client", "coverage"), { recursive: true, force: true });
  rmSync(paths.summary, { force: true });
  rmSync(paths.lcov, { force: true });

  await runClientCoverageIfPresent(() => runClientCoverage(exec), root);

  const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-merge-"));
  try {
    for (const file of files) copyFileSync(file.source, path.join(tempDirectory, file.name));
    // Report over the union of every shard's raw V8 data with the same
    // .c8rc.json include/exclude/remap rules as the unsharded run.
    await exec(process.execPath, [C8, "report", "--temp-directory", tempDirectory]);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }

  await exec(process.execPath, ["scripts/merge-coverage.mjs"]);

  const summary = JSON.parse(readFileSync(paths.summary, "utf8"));
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.candidate, `${JSON.stringify(buildBaseline(summary), null, 2)}\n`);
  console.log(
    `run-coverage: merged ${total} shard(s) → coverage/coverage-summary.json, ` +
      "coverage/lcov.info, coverage/coverage-baseline-candidate.json"
  );
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
