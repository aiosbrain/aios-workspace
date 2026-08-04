/**
 * The three coverage modes: full, shard, merge.
 *
 * Split out of scripts/run-coverage.mjs (AIO-612) at the 500-line cap. The invariant they all
 * share lives in scripts/coverage-outputs.mjs: the canonical output names are created ONLY by
 * `promoteCoverageOutputs`, as the last act of a run that completed.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBaseline } from "../check-coverage.mjs";
import {
  cleanupSuccessfulCoverageRun,
  hasCanonicalCoverageOutputs,
  markCoverageDegraded,
  markShardFailed,
  promoteCoverageOutputs,
  refuseMergeIfShardsFailed,
  removeRotatedSnapshot,
  rotateCoverageDirectory,
  rotateShardDirectory,
  stagingDirectory,
} from "../coverage-outputs.mjs";
import {
  C8,
  CLIENT_WORKSPACE,
  ROOT,
  collectShardFiles,
  coveragePaths,
  ensureLoopBuiltStrict,
  execute,
  mergeThenPropagate,
  runClientCoverage,
  runClientCoverageIfPresent,
  runNodeSuiteUnderC8,
  selectShardCoverageRoot,
  shardDirectory,
} from "./runtime.mjs";

function cleanupAfterPublication(root, cleanup) {
  try {
    cleanup(root);
  } catch (error) {
    // Publication is already complete and correct. Cleanup is deliberately non-load-bearing: a
    // residue warning must not turn a successful run into a failed command after canonical paths
    // have appeared.
    console.error(`run-coverage: published coverage; deferred cleanup failed: ${error.message}`);
  }
}

export async function runFull({
  root = ROOT,
  exec = execute,
  removeSnapshot = removeRotatedSnapshot,
  cleanup = cleanupSuccessfulCoverageRun,
} = {}) {
  // FIRST filesystem operation: one same-filesystem rename hides every old canonical path
  // together. Snapshot cleanup happens only after that namespace boundary and cannot expose a
  // torn state even if it fails or the process is killed.
  const coverageSnapshot = rotateCoverageDirectory(root);
  removeSnapshot(coverageSnapshot);
  rmSync(path.join(root, "gui", "client", "coverage"), { recursive: true, force: true });

  await ensureLoopBuiltStrict(exec, root);
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-"));
  const staged = stagingDirectory(root);
  try {
    // Keep the independently configured reports separate and deterministic.
    // Client coverage is sub-second; sequencing it avoids future port/fixture
    // conflicts if browser tests grow integration coverage.
    //
    // DEFERRED, for exactly the reason spelled out below about the Node suite. This call used to
    // throw straight out of runFull, so merge-coverage.mjs never ran and NO artifact was written
    // at all — the same null-coverage outcome, reached by a different route. A present but broken
    // client (a malformed gui/client/package.json is enough) must still fail closed without
    // destroying the ROOT coverage number. Root coverage is still real data and the dashboard
    // should get it; the client failure is re-thrown after the merge, so the command still exits
    // nonzero.
    //
    // CURRENTLY UNREACHABLE, DELIBERATELY KEPT. Since the GUI cut (#549) there is no
    // `gui/client/package.json`, so `runClientCoverageIfPresent` skips without calling `run()`
    // and `clientError` can never be non-null. The code that makes it reachable again — the
    // predicate, the runner, the whole branch — is still here, and this finding has already
    // survived two rounds by being fixed only for the case someone happened to hit first.
    const failures = [];
    let clientError = null;
    try {
      await runClientCoverageIfPresent(() => runClientCoverage(exec, root), root);
    } catch (error) {
      clientError = error;
      failures.push({
        missing: CLIENT_WORKSPACE,
        reason: `client coverage failed: ${error.message}`,
      });
      console.error(
        `run-coverage: client coverage FAILED (${error.message}) — continuing so the root ` +
          "artifact is still produced; this failure is re-thrown after the merge."
      );
    }

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
    //
    // AND THE OUTPUTS ONLY EARN THE CANONICAL NAMES IF THE RUN COMPLETED. merge-coverage writes
    // into the staging directory; promotion below is the last act of a successful run. See
    // scripts/coverage-outputs.mjs for why this is a whitelist over success rather than a
    // blacklist over failure modes.
    //
    // The degradation handling goes in `afterMerge` because `mergeThenPropagate` re-throws a
    // suite failure itself, so anything after that call is unreachable on that path — which is
    // exactly how the suite case went unguarded while the client case was fixed twice.
    await mergeThenPropagate(
      () => runNodeSuiteUnderC8(tempDirectory, [], [], exec, root),
      () =>
        exec(process.execPath, ["scripts/merge-coverage.mjs", "--out-dir", staged], { cwd: root }),
      (suiteError) => {
        // Listed first: when both failed it is the more informative reason, matching the error
        // `mergeThenPropagate` re-throws.
        if (suiteError) {
          failures.unshift({
            missing: "node suite (partial c8 data)",
            reason: `node suite failed: ${suiteError.message}`,
          });
        }
        if (failures.length) {
          markCoverageDegraded(
            root,
            failures.map((f) => f.reason).join("; "),
            failures.map((f) => f.missing)
          );
        }
      }
    );

    // Reached only when the suite passed; mergeThenPropagate re-throws a suite failure itself,
    // and that is the more informative error when both fail.
    if (clientError) throw clientError;

    promoteCoverageOutputs(root);
    cleanupAfterPublication(root, cleanup);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export async function runShard(
  shard,
  { root = ROOT, exec = execute, removeSnapshot = removeRotatedSnapshot } = {}
) {
  const shardDir = shardDirectory(shard.index, root);
  // A previous completed full/merge run may have left scanner-readable canonical outputs. Hide
  // that entire tree with the same one-rename boundary before strict prep; its shard data belongs
  // to the previous measurement and must not be mixed into this new shard series. Otherwise,
  // rotate only this shard so independently accumulated sibling shards remain available.
  const shardSnapshot = hasCanonicalCoverageOutputs(root)
    ? rotateCoverageDirectory(root)
    : rotateShardDirectory(shardDir);
  // c8 collects raw V8 data into the shard directory; --reporter=none skips
  // report generation — the merge step is the only report/gate producer.
  try {
    await ensureLoopBuiltStrict(exec, root);
    await runNodeSuiteUnderC8(
      shardDir,
      [`--shard=${shard.raw}`],
      ["--reporter=none", "--clean=false"],
      exec,
      root
    );
    removeSnapshot(shardSnapshot);
  } catch (error) {
    // Record prep, suite, and post-rotation cleanup failures WHERE THE MERGE WILL SEE THEM. Never
    // replace the real error if writing the explanatory sentinel also fails.
    try {
      markShardFailed(shardDir, error.message);
    } catch (markerError) {
      console.error(`run-coverage: could not record shard failure: ${markerError.message}`);
    }
    throw error;
  }
  console.log(`run-coverage: shard ${shard.raw} raw coverage in ${path.relative(root, shardDir)}`);
}

export async function runMerge(
  total,
  { root = ROOT, exec = execute, cleanup = cleanupSuccessfulCoverageRun } = {}
) {
  const paths = coveragePaths(root);
  // FIRST filesystem operation: rotate the whole tree. The immutable snapshot is the shard input;
  // every report, marker, staging file, and promoted output below belongs to a fresh coverage/.
  const coverageSnapshot = rotateCoverageDirectory(root);
  const shardSource = selectShardCoverageRoot(root, coverageSnapshot);
  const shardDirs = Array.from({ length: total }, (_, i) =>
    shardDirectory(i + 1, root, shardSource)
  );
  refuseMergeIfShardsFailed(root, shardDirs);
  const files = collectShardFiles(total, root, shardSource);
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "aios-c8-merge-"));
  try {
    for (const file of files) copyFileSync(file.source, path.join(tempDirectory, file.name));
    // Keep the rotated source until publication succeeds. The temp copy is disposable; the
    // ignored snapshot is what makes a report/merge/promotion failure retryable.

    rmSync(path.join(paths.dir, "root"), { recursive: true, force: true });
    rmSync(path.join(root, "gui", "client", "coverage"), { recursive: true, force: true });

    await runClientCoverageIfPresent(() => runClientCoverage(exec, root), root);

    // Report over the union of every shard's raw V8 data with the same
    // .c8rc.json include/exclude/remap rules as the unsharded run.
    await exec(process.execPath, [C8, "report", "--temp-directory", tempDirectory], { cwd: root });

    const staged = stagingDirectory(root);
    await exec(process.execPath, ["scripts/merge-coverage.mjs", "--out-dir", staged], {
      cwd: root,
    });

    // Built from the STAGED summary, and staged itself: like the summary and the lcov it is a
    // result, and results do not exist until the run has completed.
    const summary = JSON.parse(readFileSync(path.join(staged, "coverage-summary.json"), "utf8"));
    mkdirSync(staged, { recursive: true });
    writeFileSync(
      path.join(staged, "coverage-baseline-candidate.json"),
      `${JSON.stringify(buildBaseline(summary), null, 2)}\n`
    );

    const published = promoteCoverageOutputs(root);
    cleanupAfterPublication(root, cleanup);
    console.log(`run-coverage: merged ${total} shard(s) → ${published.join(", ")}`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
