/**
 * The degraded-coverage contract (AIO-612): how a coverage run that measured only PART of the
 * repo says so, and how every reader finds out.
 *
 * Read and write live in one module deliberately. The producer (`run-coverage.mjs`) and the
 * reader (`coverage-report.mjs`) have to agree on a filename and a shape, and the last time
 * those two halves were spread across files they drifted.
 *
 * WHY ANY OF THIS EXISTS. When the client coverage pass fails, `runFull` still merges root-only
 * coverage and writes the artifact — which is right, losing the data entirely is worse. But a
 * root-only summary is shape-identical AND plausibility-identical to a complete one: measured on
 * this repo it reads 81.87% lines / 78.82% branches against committed floors of 79.70% / 71.50%,
 * so every floor clears and nothing goes red. `scan-on-merge.yml` runs that mode under `|| true`,
 * so the failure it re-throws is discarded and the number is published anyway.
 *
 * TWO MECHANISMS, because there are two kinds of consumer:
 *   1. the marker — for anything that goes through `readCoverageReport`, which refuses to
 *      publish a number while it exists and can explain WHY;
 *   2. moving the data off the canonical filenames — for everything else. `aios_ingest.cli scan`,
 *      the scanner scan-on-merge.yml actually publishes this repo's number from, reads
 *      `coverage/coverage-summary.json` DIRECTLY and never calls our JS. The marker is invisible
 *      to it. An empty canonical path is not.
 *
 * Both point the same way: a consumer that finds nothing publishes null, and null is VISIBLY
 * wrong so it gets fixed. A plausible-but-low number is not visibly wrong and never gets fixed.
 * The data is preserved throughout — it just stops answering to the name that means "complete".
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The file `run-coverage.mjs` writes when it produces an artifact it knows is incomplete. */
export const DEGRADED_MARKER = "coverage-degraded.json";

/**
 * Written INSIDE `coverage/shard-<k>/` when that shard's suite run failed.
 *
 * Sharded mode splits "run the suite" (`--shard`) from "produce the artifact" (`--merge`) across
 * two processes, so the merge cannot observe a suite failure directly — raw V8 data from a failed
 * shard is indistinguishable from a passing one. The sentinel is the only channel between them,
 * and it lives in the shard directory because that directory IS the CI artifact.
 *
 * Deliberately NOT a `.json` name: `collectShardFiles` feeds every `*.json` in a shard directory
 * to `c8 report`, which would choke on a file that is not V8 coverage data.
 */
export const SHARD_FAILED_SENTINEL = "shard-failed.marker";

/**
 * Every artifact a consumer might read as "this repo's coverage", and the name its degraded
 * counterpart is preserved under. BOTH entries matter: merge-coverage.mjs writes the summary and
 * the lcov, and scan-on-merge.yml names both as what the scanner picks up — quarantining only
 * the summary would leave the same root-only number readable through the lcov fallback
 * (`readCoverageReport` precedence 3).
 */
export const CANONICAL_ARTIFACTS = [
  ["coverage-summary.json", "coverage-summary.degraded.json"],
  ["lcov.info", "lcov.degraded.info"],
];

/** Record that this shard's suite run failed, inside the directory the merge will read. */
export function markShardFailed(shardDir, reason) {
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(path.join(shardDir, SHARD_FAILED_SENTINEL), `${reason}\n`);
}

/**
 * Refuse to merge shard data when any shard's suite run failed.
 *
 * A SHARD THAT FAILED IS A RUN THAT DID NOT COMPLETE, and its raw V8 data is indistinguishable
 * from a passing shard's. Merge mode never runs the suite itself, so the sentinel is the only way
 * it can know. In CI this is belt-and-braces — the shard job's upload step is success()-gated and
 * the `coverage` job `needs: coverage-shard`, so failed-shard data never reaches the merge. It
 * bites on the LOCAL sharded path, where nothing stops you running the shards by hand, ignoring
 * one that failed, and merging anyway; and it is what keeps the artifact honest if that upload is
 * ever changed to `if: always()` for debuggability.
 *
 * Marks as well as throws: merge mode does NOT wipe coverage/, so a summary/lcov from an earlier
 * run may still be sitting at the canonical names, and throwing alone would leave that stale,
 * complete-looking pair as the answer to "what is this repo's coverage".
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
 * Move the canonical artifacts aside so NOTHING is left at the names consumers read.
 * @returns {string[]} the degraded names now holding the data, for the marker to record.
 */
export function quarantineDegradedArtifacts(root) {
  const dir = path.join(root, "coverage");
  const moved = [];
  for (const [canonical, degraded] of CANONICAL_ARTIFACTS) {
    const from = path.join(dir, canonical);
    // Absent is fine: a merge that failed outright never wrote these, and there is then nothing
    // at the canonical name either — which is already the safe state.
    if (!existsSync(from)) continue;
    renameSync(from, path.join(dir, degraded));
    moved.push(`coverage/${degraded}`);
  }
  return moved;
}

/** Record that the artifact just produced is INCOMPLETE, and move it off the canonical names. */
export function markCoverageDegraded(root, reason, missing) {
  const dir = path.join(root, "coverage");
  mkdirSync(dir, { recursive: true });
  const preserved = quarantineDegradedArtifacts(root);
  writeFileSync(
    path.join(dir, DEGRADED_MARKER),
    `${JSON.stringify({ reason, missing, preserved }, null, 2)}\n`
  );
  console.error(
    `run-coverage: coverage marked DEGRADED — ${reason}. No artifact is left at the canonical ` +
      `name; the partial data is preserved as ${preserved.join(", ") || "(nothing was produced)"}.`
  );
}

/**
 * Drop any marker a previous run left, so one bad run cannot suppress every later good one — and
 * the quarantined copies with it, so nobody investigating a later run reads a stale partial
 * measurement believing it came from this one.
 */
export function clearCoverageDegraded(root) {
  const dir = path.join(root, "coverage");
  rmSync(path.join(dir, DEGRADED_MARKER), { force: true });
  for (const [, degraded] of CANONICAL_ARTIFACTS) rmSync(path.join(dir, degraded), { force: true });
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
    // reader must not be able to turn a broken marker into a clean bill of health — that is the
    // same silent-success direction the marker exists to close.
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
