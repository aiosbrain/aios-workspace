import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
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

const isClientPass = (command, args) => command === "npm" && args.includes("gui/client");
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

const runWithFailingClient = (root, rec) =>
  runWith(root, rec, [], (c, a) => isClientPass(c, a) && "client coverage boom");

const runWithFailingSuite = (root, rec, argv = []) =>
  runWith(root, rec, argv, (_c, a) => isNodeSuite(a) && "17 tests failed");

test("a degraded full run leaves NOTHING at the canonical coverage names", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  const thrown = await runWithFailingClient(root, rec);
  try {
    // 1. The command still fails. `main` throwing is what sets process.exitCode = 1 in the CLI
    //    entry point, so the gate keeps failing exactly as before.
    assert.match(thrown?.message ?? "", /client coverage boom/, "the failure must still propagate");

    // 2. Nothing answers to the name that means "this repo's coverage". This is the half that
    //    reaches consumers outside this repo — they never see the marker.
    for (const name of CANONICAL) {
      assert.equal(existsSync(at(root, name)), false, `${name} must not be left behind`);
    }

    // 3. The data is PRESERVED, not destroyed — under a name nothing reads as authoritative.
    for (const name of QUARANTINED) {
      assert.ok(existsSync(at(root, name)), `${name} must hold the partial data`);
    }
    assert.equal(
      JSON.parse(readFileSync(at(root, "coverage-summary.degraded.json"), "utf8")).total.lines.pct,
      80,
      "the preserved copy must be the real measurement, not a stub"
    );
    assert.equal(readFileSync(at(root, "lcov.degraded.info"), "utf8"), LCOV);

    // 4. The marker explains why, and points at where the data went.
    const marker = JSON.parse(readFileSync(at(root, "coverage-degraded.json"), "utf8"));
    assert.match(marker.reason, /client coverage boom/);
    assert.deepEqual(marker.missing, ["gui/client"]);
    assert.deepEqual(marker.preserved, [
      "coverage/coverage-summary.degraded.json",
      "coverage/lcov.degraded.info",
    ]);

    // 5. And the consequence that matters for consumers that DO call our JS.
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a FAILING NODE SUITE degrades the artifact exactly like a failed client pass", async () => {
  // THE CASE THAT SURVIVED THE GUI CUT, and the larger one. `mergeThenPropagate` catches a suite
  // failure, merges anyway, and RE-THROWS — so everything after that call was unreachable on this
  // path, which is how the suite case stayed unguarded while the client case was fixed twice.
  // scan-on-merge.yml discards the throw, so what got published was a number computed over
  // whatever fraction of ~2,500 tests happened to run before the failure.
  const root = makeRoot();
  const rec = recorder(root);
  const thrown = await runWithFailingSuite(root, rec);
  try {
    assert.match(
      thrown?.message ?? "",
      /17 tests failed/,
      "the suite failure must still propagate"
    );

    for (const name of CANONICAL) {
      assert.equal(existsSync(at(root, name)), false, `${name} must not be left behind`);
    }
    for (const name of QUARANTINED) {
      assert.ok(existsSync(at(root, name)), `${name} must hold the partial data`);
    }
    assert.equal(
      JSON.parse(readFileSync(at(root, "coverage-summary.degraded.json"), "utf8")).total.lines.pct,
      80,
      "the preserved copy must be the real partial measurement"
    );

    const marker = JSON.parse(readFileSync(at(root, "coverage-degraded.json"), "utf8"));
    assert.match(marker.reason, /node suite failed: 17 tests failed/);
    assert.deepEqual(marker.missing, ["node suite (partial c8 data)"]);
    assert.deepEqual(marker.preserved, [
      "coverage/coverage-summary.degraded.json",
      "coverage/lcov.degraded.info",
    ]);

    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the marker's reason distinguishes a suite failure from a workspace failure", async () => {
  // Whoever reads the marker has to know which half of the run died. When BOTH fail the suite is
  // named first, matching the error mergeThenPropagate re-throws as the more informative one.
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  const thrown = await runWith(
    root,
    rec,
    [],
    (c, a) =>
      (isClientPass(c, a) && "client coverage boom") || (isNodeSuite(a) && "17 tests failed")
  );
  try {
    assert.match(thrown?.message ?? "", /17 tests failed/);
    const marker = JSON.parse(readFileSync(at(root, "coverage-degraded.json"), "utf8"));
    assert.match(marker.reason, /^node suite failed: 17 tests failed; client coverage failed: /);
    assert.deepEqual(marker.missing, ["node suite (partial c8 data)", "gui/client"]);
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
    assert.match(marker.reason, /shard suite run failed in: coverage\/shard-1/);
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
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

test("a degraded run publishes null even with the marker deleted by hand", async () => {
  // The renames are load-bearing on their own. Someone who "fixes" the dashboard by deleting the
  // marker must still not get a number out of a partial measurement — and the scanner, which
  // never reads the marker in the first place, is permanently in this state.
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  await runWithFailingClient(root, rec);
  try {
    rmSync(at(root, "coverage-degraded.json"), { force: true });
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null,
      "with the canonical names empty there is nothing to publish, marker or no marker"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean full run is untouched: canonical names, no marker, no quarantine", async () => {
  // The guard has to be inert on the happy path, or it is just an outage with extra steps.
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable degraded marker still suppresses publication", () => {
  // Fail closed on a malformed marker: nobody gets a clean bill of health out of a broken one.
  const root = makeRoot();
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    writeFileSync(at(root, "coverage-degraded.json"), "{ not json");
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker that parses to a non-object still suppresses publication", () => {
  const root = makeRoot();
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    writeFileSync(at(root, "coverage-degraded.json"), "42");
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no marker means the artifact publishes normally", () => {
  const root = makeRoot();
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    const report = readCoverageReport(root);
    assert.ok(report);
    assert.equal(report.lines_pct, 80);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
