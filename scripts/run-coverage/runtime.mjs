/**
 * Shared machinery for the coverage modes: process execution, the client-workspace predicate,
 * the c8 invocations, and shard bookkeeping.
 *
 * Split out of scripts/run-coverage.mjs (AIO-612) when that file reached the 500-line cap for the
 * third time. The barrel keeps argument parsing and dispatch; `modes.mjs` holds the three modes;
 * this holds what both of those need. No behaviour changed in the move.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const C8 = path.join(ROOT, "node_modules", "c8", "bin", "c8.js");

// Root-derived so `runFull`/`runMerge` can be driven against a fixture root in tests instead of
// only against this checkout. The individual output filenames are NOT here — they live in
// scripts/coverage-outputs.mjs, which is the only thing allowed to create them.
export function coveragePaths(root) {
  return { dir: path.join(root, "coverage") };
}

export function shardDirectory(index, root = ROOT) {
  return path.join(root, "coverage", `shard-${index}`);
}

// Tests shell out to repo-local CLIs (e.g. dotenvx); when this script is run as
// `node scripts/run-coverage.mjs` (not via `npm run`), node_modules/.bin isn't on
// PATH, so prepend it the way npm would.
export const LOCAL_BIN_PATH = [path.join(ROOT, "node_modules", ".bin"), process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string}} [options] — `cwd` defaults to this checkout. Callers that were handed an
 *   injected `root` MUST pass it: probing one tree while executing in another answers a question
 *   about a directory the command never touches.
 */
export function execute(command, args, options = {}) {
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

export const CLIENT_WORKSPACE = "gui/client";

export function runClientCoverage(exec = execute, root = ROOT) {
  // Use the client manifest as the coverage ownership signal, not the root workspace registry.
  // During the GUI split those two pieces of metadata can change independently. `--prefix`
  // continues to execute the present client even after it is deregistered, while a malformed
  // client still fails the real command instead of being silently omitted from the denominator.
  return exec("npm", ["--prefix", CLIENT_WORKSPACE, "run", "test:coverage"], { cwd: root });
}

/**
 * Why `gui/client` cannot be covered here — or `"present"` when it can. The manifest is the
 * authority: while it exists, its source remains part of this repository's coverage denominator
 * even if root npm workspace metadata has already been changed. Once the GUI cut removes the
 * manifest, root-only coverage is intentional. A bare leftover directory is not enough.
 *
 * @param {string} root
 * @returns {"present" | "no-manifest"}
 */
export function clientWorkspaceStatus(root = ROOT) {
  if (!existsSync(path.join(root, "gui", "client", "package.json"))) return "no-manifest";
  return "present";
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
  if (status === "no-manifest") {
    // Same terminology as merge-coverage.mjs's "(root only — no gui/client report)" so the skip
    // reads as a deliberate decision in CI output, not as a step that quietly did nothing.
    console.log("run-coverage: skipping gui/client coverage (root only — no gui/client manifest)");
    return false;
  }
  await run();
  return true;
}

// Modes that execute the Node suite must fail on a TS compile error with one
// tsc diagnostic instead of dozens of ERR_MODULE_NOT_FOUND failures against a
// missing/stale dist/ (same guard as `npm run test:node`). Merge mode only
// reports over already-collected data, so it is exempt.
export function ensureLoopBuiltStrict(exec = execute, root = ROOT) {
  return exec(process.execPath, ["scripts/ensure-loop-built.mjs", "--strict"], { cwd: root });
}

export async function runNodeSuiteUnderC8(
  tempDirectory,
  extraSuiteArgs = [],
  extraC8Args = [],
  exec = execute,
  root = ROOT
) {
  await exec(
    process.execPath,
    [
      C8,
      "--temp-directory",
      tempDirectory,
      ...extraC8Args,
      process.execPath,
      "scripts/test-suite.mjs",
      "--concurrency=4",
      ...extraSuiteArgs,
    ],
    { cwd: root }
  );
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
 * @param {(suiteError: ?Error) => void} [afterMerge] — runs once the artifact is on disk and
 *   BEFORE the suite failure is re-thrown. This is the only point where a caller can still act
 *   on what the merge produced; re-throwing first is what previously made a suite failure skip
 *   the degradation handling entirely.
 */
export async function mergeThenPropagate(runSuite, merge, afterMerge = () => {}) {
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

  afterMerge(suiteError ?? null);

  if (suiteError) throw suiteError;
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
