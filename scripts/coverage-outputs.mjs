/**
 * The lifecycle of this repo's canonical coverage outputs (AIO-612).
 *
 * THE RULE: `coverage/coverage-summary.json` and `coverage/lcov.info` mean "a coverage run
 * completed successfully and this is the result". Nothing else may ever create them.
 *
 * WHY IT IS BUILT THIS WAY. The failure it guards against is publishing a PARTIAL measurement:
 * c8 writes real data for whatever executed, so a run that died halfway leaves an artifact that
 * is shape-identical AND plausibility-identical to a complete one. Measured on this repo, a
 * root-only run reads 81.87% lines / 78.82% branches against committed floors of 79.70% /
 * 71.50% — every floor clears, nothing goes red, and coverage under-reports indefinitely.
 * `scan-on-merge.yml` runs the full mode under `|| true`, so the failure the command reports is
 * discarded and the number is published anyway.
 *
 * THE FIRST THREE ATTEMPTS AT THIS WERE A BLACKLIST, and each one was defeated. Guard the client
 * pass failing; then the Node suite failing; then a merge that writes the outputs and fails
 * after; then the cleanup itself failing partway; then a prep step failing before the previous
 * run's outputs were invalidated. Enumerating failure modes and cleaning up after each one loses
 * to the next failure mode nobody enumerated.
 *
 * SO THE POLARITY IS INVERTED. A run produces its outputs under staging names inside
 * `coverage/.staged/`, and they are PROMOTED to the canonical names as the very last act of a
 * successful run. Every failure path is then safe by construction rather than by cleanup:
 *   - a merge that explodes after writing never had canonical names to leave behind;
 *   - a crash anywhere before promotion leaves nothing canonical, because nothing canonical was
 *     ever created;
 *   - a stale pair from a previous run is removed at invalidation, which is the FIRST thing
 *     either mode does — before any prep step that could fail and abort the run.
 *
 * Promotion itself is several renames rather than one, because consumers require fixed filenames
 * and no single filesystem operation can create them all. That is safe here for a reason
 * specific to this ordering: promotion runs ONLY on the success path, so every staged file holds
 * a complete, correct measurement. A partial promotion can therefore expose only correct data —
 * the dangerous direction, exposing a partial measurement under a canonical name, cannot happen
 * at all. Promotion still rolls back and fails closed if a rename throws.
 *
 * The degradation marker below is EXPLANATORY, not load-bearing. It tells a human why there is
 * no number. Nothing depends on it having been written for the system to be safe.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Where a run assembles its outputs before they have earned the canonical names. */
export const STAGING_DIR = ".staged";

/** Written alongside the outputs to say, in prose, why there is no publishable number. */
export const DEGRADED_MARKER = "coverage-degraded.json";

/**
 * Written INSIDE `coverage/shard-<k>/` when that shard's suite run failed.
 *
 * Sharded mode splits "run the suite" (`--shard`) from "produce the outputs" (`--merge`) across
 * two processes, so the merge cannot observe a suite failure directly — raw V8 data from a failed
 * shard is indistinguishable from a passing one's. The sentinel is the only channel between them,
 * and it lives in the shard directory because that directory IS the CI artifact.
 *
 * Deliberately NOT a `.json` name: `collectShardFiles` feeds every `*.json` in a shard directory
 * to `c8 report`, which would choke on a file that is not V8 coverage data.
 */
export const SHARD_FAILED_SENTINEL = "shard-failed.marker";

/**
 * Every output a run produces, as [staged name, canonical name, degraded name].
 *
 * The summary and the lcov are BOTH coverage sources — `merge-coverage.mjs` writes both,
 * `scan-on-merge.yml` names both as what the scanner picks up, and `readCoverageReport` falls
 * back to the lcov at precedence 3. Treating only the summary as canonical would leave the same
 * number readable through the other file.
 */
export const COVERAGE_OUTPUTS = [
  ["coverage-summary.json", "coverage-summary.json", "coverage-summary.degraded.json"],
  ["lcov.info", "lcov.info", "lcov.degraded.info"],
  [
    "coverage-baseline-candidate.json",
    "coverage-baseline-candidate.json",
    "coverage-baseline-candidate.degraded.json",
  ],
];

export const stagingDirectory = (root) => path.join(root, "coverage", STAGING_DIR);

/**
 * Remove everything a previous run may have left that could be mistaken for this one's result.
 *
 * MUST BE THE FIRST THING EITHER MODE DOES — before `ensureLoopBuiltStrict`, before the suite,
 * before anything that can throw. Running it later was its own bug: a prep step that failed left
 * the PREVIOUS run's canonical pair on disk, to be published as though it were this run's.
 *
 * Deliberately does not touch `coverage/root` or `coverage/shard-*`: merge mode needs the shard
 * data it is about to read, and full mode wipes the whole directory separately.
 */
export function invalidateCoverageOutputs(root) {
  const dir = path.join(root, "coverage");
  rmSync(stagingDirectory(root), { recursive: true, force: true });
  rmSync(path.join(dir, DEGRADED_MARKER), { force: true });
  for (const [, canonical, degraded] of COVERAGE_OUTPUTS) {
    rmSync(path.join(dir, canonical), { force: true });
    rmSync(path.join(dir, degraded), { force: true });
  }
}

/**
 * Give the staged outputs the canonical names. THE LAST ACT OF A SUCCESSFUL RUN.
 *
 * Staged files that do not exist are skipped rather than invented: full mode produces no baseline
 * candidate, and a promotion that finds nothing simply publishes nothing — the safe direction.
 *
 * @returns {string[]} the canonical paths now published, repo-relative.
 */
export function promoteCoverageOutputs(root) {
  const dir = path.join(root, "coverage");
  const staged = stagingDirectory(root);
  const promoted = [];
  try {
    for (const [stagedName, canonical] of COVERAGE_OUTPUTS) {
      const from = path.join(staged, stagedName);
      if (!existsSync(from)) continue;
      renameSync(from, path.join(dir, canonical));
      promoted.push(`coverage/${canonical}`);
    }
  } catch (error) {
    // Fail closed. Everything staged was correct, so what is already promoted is correct too —
    // but a half-published set is not what "the run completed" means, and leaving it would
    // reintroduce exactly the ambiguity this module exists to remove.
    for (const name of promoted) rmSync(path.join(root, name), { force: true });
    throw new Error(`run-coverage: failed to publish the coverage outputs — ${error.message}`);
  }
  return promoted;
}

/** Record that this shard's suite run failed, inside the directory the merge will read. */
export function markShardFailed(shardDir, reason) {
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(path.join(shardDir, SHARD_FAILED_SENTINEL), `${reason}\n`);
}

/**
 * Refuse to merge shard data when any shard's suite run failed.
 *
 * In CI this is belt-and-braces — the shard job's upload step is success()-gated and the
 * `coverage` job `needs: coverage-shard`, so failed-shard data never reaches the merge. It bites
 * on the LOCAL sharded path, where nothing stops you running the shards by hand, ignoring one
 * that failed, and merging anyway; and it keeps the outputs honest if that upload is ever
 * changed to `if: always()` for debuggability.
 */
export function refuseMergeIfShardsFailed(root, shardDirs) {
  const failed = shardDirs
    .filter((dir) => existsSync(path.join(dir, SHARD_FAILED_SENTINEL)))
    .map((dir) => path.relative(root, dir));
  if (!failed.length) return;
  markCoverageDegraded(root, `shard suite run failed in: ${failed.join(", ")}`, failed);
  throw new Error(
    `run-coverage: refusing to merge — the suite failed in ${failed.join(", ")}; ` +
      "re-run those shards rather than publishing a number built from a partial run"
  );
}

/**
 * Explain, on disk, why this run published nothing — and keep its partial data for whoever
 * investigates.
 *
 * EXPLANATORY, NOT LOAD-BEARING. Because the canonical names are only ever created by
 * `promoteCoverageOutputs`, a degraded run has already published nothing by the time this is
 * called. If this throws halfway, or is never reached at all, the outcome is unchanged: there is
 * no number. That is the point of the inversion — safety does not depend on cleanup succeeding.
 */
export function markCoverageDegraded(root, reason, missing) {
  const dir = path.join(root, "coverage");
  mkdirSync(dir, { recursive: true });
  const preserved = [];
  for (const [stagedName, , degraded] of COVERAGE_OUTPUTS) {
    const from = path.join(stagingDirectory(root), stagedName);
    if (!existsSync(from)) continue;
    renameSync(from, path.join(dir, degraded));
    preserved.push(`coverage/${degraded}`);
  }
  writeFileSync(
    path.join(dir, DEGRADED_MARKER),
    `${JSON.stringify({ reason, missing, preserved }, null, 2)}\n`
  );
  console.error(
    `run-coverage: coverage DEGRADED — ${reason}. Nothing was published; the partial data is ` +
      `kept as ${preserved.join(", ") || "(nothing was produced)"}.`
  );
}

/**
 * @param {string} coverageDir
 * @returns {?{reason:string, missing?:string[], preserved?:string[]}} null only when no marker
 *   is present.
 */
export function readDegradedMarker(coverageDir) {
  const file = path.join(coverageDir, DEGRADED_MARKER);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // A marker that exists but does not parse still means "something went wrong here". The
    // reader must not be able to turn a broken marker into a clean bill of health.
    return parsed && typeof parsed === "object"
      ? {
          reason: String(parsed.reason ?? "reason not recorded"),
          missing: parsed.missing,
          preserved: parsed.preserved,
        }
      : { reason: "degradation marker is malformed" };
  } catch {
    return { reason: "degradation marker is unreadable" };
  }
}
