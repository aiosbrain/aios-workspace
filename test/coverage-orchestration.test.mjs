/**
 * Coverage ORCHESTRATION contract — the ordering guarantee between running the suite and
 * producing the coverage artifact (scripts/run-coverage.mjs).
 *
 * Split from coverage-tools.test.mjs, which covers diff/LCOV parsing and report merging and was
 * at its 500-line cap. These tests are about sequencing, not parsing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mergeThenPropagate } from "../scripts/run-coverage.mjs";

test("a failing suite still produces the coverage artifact, then rethrows", async () => {
  // The bug this pins: run-coverage threw on suite failure, so merge-coverage never ran and
  // coverage/coverage-summary.json was never written. scan-on-merge runs `test:coverage || true`
  // (coverage is a metrics source, never a scan blocker), so the throw was swallowed, the
  // scanner found no artifact, and pushed test_coverage_pct: null — the Codebases dashboard
  // showed aios-workspace with no coverage despite a 2500-test suite.
  let merged = false;
  const suiteFailure = new Error("suite exited with status 1");
  await assert.rejects(
    () =>
      mergeThenPropagate(
        () => Promise.reject(suiteFailure),
        () => {
          merged = true;
          return Promise.resolve();
        }
      ),
    (err) => err === suiteFailure // the SUITE failure propagates, not a merge error
  );
  assert.equal(merged, true, "the artifact must still be produced when the suite fails");
});

test("a passing suite still merges, and a merge failure surfaces on its own", async () => {
  let merged = false;
  await mergeThenPropagate(
    () => Promise.resolve(),
    () => {
      merged = true;
      return Promise.resolve();
    }
  );
  assert.equal(merged, true);

  const mergeFailure = new Error("merge-coverage: missing required report");
  await assert.rejects(
    () =>
      mergeThenPropagate(
        () => Promise.resolve(),
        () => Promise.reject(mergeFailure)
      ),
    (err) => err === mergeFailure
  );
});

test("a merge failure never masks the suite failure that caused it", async () => {
  // If the suite crashed early enough that c8 wrote nothing, merge fails as a CONSEQUENCE.
  // Reporting that instead of the real failure sends you debugging the wrong thing.
  const suiteFailure = new Error("suite exited with status 1");
  await assert.rejects(
    () =>
      mergeThenPropagate(
        () => Promise.reject(suiteFailure),
        () => Promise.reject(new Error("merge-coverage: missing required report"))
      ),
    (err) => err === suiteFailure
  );
});
