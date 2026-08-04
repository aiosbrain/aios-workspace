import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { COVERAGE_SNAPSHOT_PREFIX, rotateCoverageDirectory } from "../scripts/coverage-outputs.mjs";
import { main } from "../scripts/run-coverage.mjs";
import { readCoverageReport } from "../scripts/coverage-report.mjs";
import { LCOV, SUMMARY, makeRoot, recorder } from "./run-coverage-guard-fixtures.mjs";

/**
 * AIO-612 — ARTIFACT INTEGRITY, as distinct from the client-ownership predicate next door
 * (test/run-coverage-client-guard.test.mjs, AIO-742). That predicate decides whether
 * `gui/client` can be covered at all. These tests cover the other half: whether the artifact
 * that comes out the far end is HONEST about what it measured.
 *
 * That half has its own failure mode, and adversarial review found it live on main. Capturing a
 * client failure so the ROOT artifact is still produced (rather than losing it entirely) is
 * right — but a root-only summary is shape-identical AND plausibility-identical to a complete
 * one, and `scan-on-merge.yml` runs the full mode under `|| true`, so the re-thrown error is
 * DISCARDED and the number gets published anyway. Measured on this repo: root-only reads 81.87%
 * lines / 78.82% branches against floors of 79.70% / 71.50% — every floor clears, nothing goes
 * red, and coverage under-reports indefinitely.
 *
 * Two mechanisms close it, and the split matters. The marker reaches consumers that go through
 * `readCoverageReport`. Moving the data off the canonical names reaches every OTHER consumer —
 * including `aios_ingest.cli scan`, the scanner scan-on-merge.yml actually publishes from, which
 * reads `coverage/coverage-summary.json` directly and never calls our JS. A consumer that finds
 * nothing at the canonical path publishes null; null is visibly wrong, so it gets fixed.
 */

const CANONICAL = ["coverage-summary.json", "lcov.info"];
const QUARANTINED = ["coverage-summary.degraded.json", "lcov.degraded.info"];

const at = (root, name) => path.join(root, "coverage", name);

function silenceErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

const isNodeSuite = (args) => args.some((a) => String(a).endsWith("test-suite.mjs"));

/** Drive a mode with an `exec` that fails on selected commands, and return whatever it threw. */
async function runWith(root, rec, argv, shouldFail) {
  const failing = async (command, args, options) => {
    const boom = shouldFail(command, args);
    if (boom) throw new Error(boom);
    return rec.exec(command, args, options);
  };
  const original = console.error;
  console.error = () => {};
  try {
    await main(argv, { root, exec: failing });
    return null;
  } catch (caught) {
    return caught;
  } finally {
    console.error = original;
  }
}

const runWithFailingSuite = (root, rec, argv = []) =>
  runWith(root, rec, argv, (_c, a) => isNodeSuite(a) && "17 tests failed");

const snapshots = (root) =>
  readdirSync(root).filter((entry) => entry.startsWith(COVERAGE_SNAPSHOT_PREFIX));

test("coverage invalidation is one parent rename with no child removal", () => {
  const calls = [];
  const root = path.resolve("/fixture/repo");
  const result = rotateCoverageDirectory(root, {
    uuid: () => "fixed-id",
    pathExists: (target) => {
      calls.push(["exists", target]);
      return true;
    },
    rename: (from, to) => calls.push(["rename", from, to]),
  });

  assert.equal(result, path.join(root, ".coverage-stale-fixed-id"));
  assert.deepEqual(calls, [
    ["exists", path.join(root, "coverage")],
    ["rename", path.join(root, "coverage"), result],
  ]);
});

test("SIGKILL after rotation cannot expose a torn canonical coverage directory", async () => {
  const root = makeRoot();
  writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
  writeFileSync(at(root, "lcov.info"), LCOV);
  const moduleUrl = new URL("../scripts/coverage-outputs.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { rotateCoverageDirectory } from ${JSON.stringify(moduleUrl)};\n` +
        `rotateCoverageDirectory(${JSON.stringify(root)});\n` +
        `process.stdout.write("rotated\\n");\n` +
        `setInterval(() => {}, 60_000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("rotation acknowledgement timed out")), 5000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("rotated\n")) return;
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill("SIGKILL");
    await once(child, "exit");

    assert.equal(existsSync(path.join(root, "coverage")), false);
    const rotated = snapshots(root);
    assert.equal(rotated.length, 1);
    assert.equal(
      readFileSync(path.join(root, rotated[0], "coverage-summary.json"), "utf8"),
      SUMMARY
    );
    assert.equal(readFileSync(path.join(root, rotated[0], "lcov.info"), "utf8"), LCOV);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory-shaped canonical children are hidden by the parent rotation", () => {
  const root = makeRoot();
  try {
    mkdirSync(path.join(at(root, "coverage-summary.json"), "blocker"), { recursive: true });
    writeFileSync(at(root, "lcov.info"), LCOV);

    const snapshot = rotateCoverageDirectory(root);
    assert.equal(existsSync(path.join(root, "coverage")), false);
    assert.ok(existsSync(path.join(snapshot, "coverage-summary.json", "blocker")));
    assert.equal(readFileSync(path.join(snapshot, "lcov.info"), "utf8"), LCOV);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed full preparation retains the complete rotated snapshot", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
  writeFileSync(at(root, "lcov.info"), LCOV);
  mkdirSync(at(root, "nested"), { recursive: true });
  writeFileSync(at(root, "nested/evidence"), "old-tree\n");
  try {
    const prepError = await runWith(root, rec, [], (_command, args) =>
      args.some((arg) => String(arg).endsWith("ensure-loop-built.mjs")) ? "tsc failed" : null
    );
    assert.match(prepError?.message ?? "", /tsc failed/);
    assert.equal(existsSync(at(root, "coverage-summary.json")), false);
    assert.equal(existsSync(at(root, "lcov.info")), false);
    assert.equal(existsSync(path.join(root, "coverage")), false);
    const [snapshot] = snapshots(root);
    assert.ok(snapshot, "the forensic snapshot should remain intact");
    assert.equal(readFileSync(path.join(root, snapshot, "coverage-summary.json"), "utf8"), SUMMARY);
    assert.equal(readFileSync(path.join(root, snapshot, "lcov.info"), "utf8"), LCOV);
    assert.equal(readFileSync(path.join(root, snapshot, "nested/evidence"), "utf8"), "old-tree\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing SHARD records a sentinel the merge can see", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const thrown = await runWithFailingSuite(root, rec, ["--shard", "2/3"]);
  try {
    assert.match(thrown?.message ?? "", /17 tests failed/, "the shard must still fail");
    assert.ok(
      existsSync(path.join(root, "coverage", "shard-2", "shard-failed.marker")),
      "the failure must be recorded where the merge will read it"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MERGE refuses to publish a number built from a failed shard", async () => {
  // Sharded mode splits "run the suite" from "produce the artifact" across two processes, so the
  // merge cannot observe the failure directly — a failed shard's raw V8 data is indistinguishable
  // from a passing one's. And because this mode does not wipe coverage/, a stale complete-looking
  // summary from an earlier run would otherwise stay behind as the answer.
  const root = makeRoot();
  const rec = recorder(root);
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    writeFileSync(at(root, "lcov.info"), LCOV);
    writeFileSync(
      path.join(root, "coverage", "shard-1", "shard-failed.marker"),
      "17 tests failed\n"
    );

    let thrown = null;
    const original = console.error;
    console.error = () => {};
    try {
      await main(["--merge", "1"], { root, exec: rec.exec });
    } catch (caught) {
      thrown = caught;
    } finally {
      console.error = original;
    }

    assert.match(thrown?.message ?? "", /refusing to merge/, "the merge must fail closed");
    for (const name of CANONICAL) {
      assert.equal(existsSync(at(root, name)), false, `stale ${name} must not survive`);
    }
    const marker = JSON.parse(readFileSync(at(root, "coverage-degraded.json"), "utf8"));
    assert.match(marker.reason, /shard suite run failed in: .*shard-1/);
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MERGE reads shards from the rotated snapshot and writes only to fresh coverage", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  let copiedShardInput = false;
  const watching = async (command, args, options) => {
    if (args.includes("report") && args.includes("--temp-directory")) {
      const tempDir = String(args[args.indexOf("--temp-directory") + 1]);
      copiedShardInput = readdirSync(tempDir).some((name) => name.startsWith("coverage-s1-"));
      assert.equal(existsSync(path.join(root, "coverage", "shard-1")), false);
      assert.equal(
        snapshots(root).length,
        1,
        "the retryable snapshot must survive until publication succeeds"
      );
    }
    return rec.exec(command, args, options);
  };
  try {
    await main(["--merge", "1"], { root, exec: watching });
    assert.equal(copiedShardInput, true, "c8 must receive the rotated shard's V8 JSON");
    for (const name of CANONICAL) assert.ok(existsSync(at(root, name)));
    assert.equal(existsSync(at(root, ".staged")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict prep failure poisons a fresh shard, and a later good shard plus merge recovers", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const staleRaw = path.join(root, "coverage", "shard-1", "coverage-1.json");
  try {
    const prepError = await runWith(root, rec, ["--shard", "1/1"], (_c, args) =>
      args.some((arg) => String(arg).endsWith("ensure-loop-built.mjs")) ? "tsc failed" : null
    );
    assert.match(prepError?.message ?? "", /tsc failed/);
    assert.equal(existsSync(staleRaw), false, "stale raw JSON must leave the expected shard path");
    assert.ok(existsSync(path.join(root, "coverage", "shard-1", "shard-failed.marker")));
    const staleShard = readdirSync(path.join(root, "coverage")).find((entry) =>
      entry.startsWith(".stale-shard-1-")
    );
    assert.ok(staleShard, "the old shard should remain under an ignored forensic name");
    assert.ok(existsSync(path.join(root, "coverage", staleShard, "coverage-1.json")));

    const mergeError = await runWith(root, rec, ["--merge", "1"], () => null);
    assert.match(mergeError?.message ?? "", /refusing to merge/);
    for (const name of CANONICAL) assert.equal(existsSync(at(root, name)), false);

    await main(["--shard", "1/1"], { root, exec: rec.exec });
    await main(["--merge", "1"], { root, exec: rec.exec });
    for (const name of CANONICAL) assert.ok(existsSync(at(root, name)));
    assert.equal(existsSync(at(root, ".staged")), false);
    assert.deepEqual(snapshots(root), [], "a later success removes obsolete forensic snapshots");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ORDERING: the outputs are staged, never canonical, until the run completes", async () => {
  // The load-bearing ordering. Promotion must be the LAST act of a successful run — if anything
  // creates the canonical names earlier, every failure after that point republishes a partial
  // measurement, which is the whole class of bug this design exists to remove. Asserted from
  // INSIDE the merge step, the last moment at which a premature canonical file could appear.
  const root = makeRoot();
  const rec = recorder(root);
  const observed = [];
  const watching = async (command, args, options) => {
    if (args.some((a) => String(a).endsWith("merge-coverage.mjs"))) {
      const flag = args.indexOf("--out-dir");
      observed.push({
        outDir: flag === -1 ? null : String(args[flag + 1]),
        canonicalPresent: CANONICAL.filter((name) => existsSync(at(root, name))),
      });
    }
    return rec.exec(command, args, options);
  };
  try {
    await main([], { root, exec: watching });
    assert.equal(observed.length, 1, "the merge must have run");
    assert.ok(
      observed[0].outDir && observed[0].outDir.includes(".staged"),
      `the merge must write to staging, got ${observed[0].outDir}`
    );
    assert.deepEqual(
      observed[0].canonicalPresent,
      [],
      "no canonical name may exist while the run is still in progress"
    );
    // ...and only afterwards do they appear.
    for (const name of CANONICAL) assert.ok(existsSync(at(root, name)), `${name} must be promoted`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a merge that writes its outputs and THEN fails publishes nothing", async () => {
  // Previously observed as `summary=true lcov=true marker=false report=80`: merge-coverage wrote
  // the canonical pair, something after it threw, and the scanner published 80 from a failed run.
  // Under promote-on-success the writes land in staging, so a merge that explodes afterwards
  // never had canonical names to leave behind. No cleanup involved — there is nothing to clean.
  const root = makeRoot();
  const rec = recorder(root);
  const thrown = await runWith(root, rec, [], (_c, a) =>
    a.some((x) => String(x).endsWith("merge-coverage.mjs")) ? "merge exploded after writing" : null
  );
  try {
    assert.ok(thrown, "the merge failure must propagate");
    for (const name of CANONICAL) {
      assert.equal(existsSync(at(root, name)), false, `${name} must never have been created`);
    }
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a PREP failure cannot leave the previous run's outputs published", async () => {
  // ensureLoopBuiltStrict used to run BEFORE coverage/ was invalidated, so a failed strict prep
  // aborted the run with last run's canonical pair still on disk — published as though it were
  // this run's, and arbitrarily stale. Invalidation is now the first thing either mode does.
  const root = makeRoot();
  const rec = recorder(root);
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    writeFileSync(at(root, "lcov.info"), LCOV);

    const thrown = await runWith(root, rec, [], (_c, a) =>
      a.some((x) => String(x).endsWith("ensure-loop-built.mjs")) ? "tsc failed" : null
    );
    assert.match(thrown?.message ?? "", /tsc failed/);
    for (const name of CANONICAL) {
      assert.equal(existsSync(at(root, name)), false, `stale ${name} must not survive`);
    }
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a filesystem failure DURING promotion publishes nothing and fails loudly", async () => {
  // The final step is several renames, because consumers need fixed filenames and no single
  // syscall creates them all. Make the second destination un-renameable (a directory) and the
  // promotion must roll back what it already published rather than leaving a half-published set.
  const root = makeRoot();
  const rec = recorder(root);
  let thrown = null;
  const original = console.error;
  console.error = () => {};
  try {
    // Block the SECOND destination after invalidation has run, so the obstruction is live at
    // promotion time: `lcov.info` as a non-empty directory makes renameSync fail with ENOTEMPTY.
    const blocking = async (command, args, options) => {
      await rec.exec(command, args, options);
      if (args.some((a) => String(a).endsWith("merge-coverage.mjs"))) {
        mkdirSync(path.join(root, "coverage", "lcov.info", "blocker"), { recursive: true });
      }
    };
    try {
      await main([], { root, exec: blocking });
    } catch (caught) {
      thrown = caught;
    }
  } finally {
    console.error = original;
    try {
      assert.match(thrown?.message ?? "", /failed to publish/, "the failure must be loud");
      assert.equal(
        existsSync(at(root, "coverage-summary.json")),
        false,
        "the summary promoted before the failure must be rolled back, not left half-published"
      );
      assert.equal(
        silenceErrors(() => readCoverageReport(root)),
        null
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a subsequent good full run clears every stale artifact and publishes", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  try {
    mkdirSync(path.join(root, ".coverage-stale-obsolete"), { recursive: true });
    writeFileSync(path.join(root, ".coverage-stale-obsolete", "evidence"), "old");
    mkdirSync(at(root, ".staged"), { recursive: true });
    writeFileSync(path.join(at(root, ".staged"), "partial"), "old");
    writeFileSync(at(root, "coverage-degraded.json"), JSON.stringify({ reason: "old" }));
    writeFileSync(at(root, "coverage-summary.degraded.json"), "old");
    writeFileSync(path.join(root, "coverage", "shard-1", "shard-failed.marker"), "old\n");

    await main([], { root, exec: rec.exec });

    for (const name of CANONICAL) {
      assert.ok(existsSync(at(root, name)), `${name} must be written by a clean run`);
    }
    for (const name of [...QUARANTINED, "coverage-degraded.json"]) {
      assert.equal(existsSync(at(root, name)), false, `${name} must not exist after a clean run`);
    }
    const report = readCoverageReport(root);
    assert.ok(report, "a clean run must publish a report");
    assert.equal(report.lines_pct, 80);
    assert.equal(existsSync(at(root, ".staged")), false);
    assert.deepEqual(snapshots(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean MERGE clears a stale marker and its quarantined copies, and publishes", async () => {
  // Merge mode is where staleness bites. runFull wipes the whole coverage/ directory on entry,
  // so nothing can survive it; merge mode deliberately does NOT, because it needs the shard data
  // — so without an explicit clear, one earlier failed full run would suppress every later
  // merged artifact. A guard that fails permanently closed is its own outage.
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(
      at(root, "coverage-degraded.json"),
      JSON.stringify({ reason: "left over from an earlier failed run" })
    );
    for (const name of QUARANTINED) writeFileSync(at(root, name), "stale");
    mkdirSync(at(root, ".staged"), { recursive: true });
    writeFileSync(path.join(at(root, ".staged"), "partial"), "stale");
    mkdirSync(path.join(root, ".coverage-stale-obsolete"), { recursive: true });

    await main(["--merge", "1"], { root, exec: rec.exec });

    assert.equal(
      existsSync(at(root, "coverage-degraded.json")),
      false,
      "a successful merge must clear the stale marker"
    );
    for (const name of QUARANTINED) {
      assert.equal(existsSync(at(root, name)), false, `stale ${name} must not survive a clean run`);
    }
    const report = readCoverageReport(root);
    assert.ok(report, "a clean run must publish a report");
    assert.equal(report.lines_pct, 80);
    assert.equal(existsSync(at(root, ".staged")), false);
    assert.deepEqual(snapshots(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
