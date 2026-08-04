import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../scripts/run-coverage.mjs";
import { readCoverageReport } from "../scripts/coverage-report.mjs";
import { SUMMARY, makeRoot, recorder } from "./run-coverage-guard-fixtures.mjs";

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
const LCOV = "TN:\nSF:scripts/a.mjs\nLF:10\nLH:8\nend_of_record\n";

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

/**
 * The shared fixture recorder only writes the summary. The real merge-coverage.mjs writes the
 * lcov too, and the lcov is a coverage source in its own right (`readCoverageReport` precedence
 * 3, and scan-on-merge.yml names it alongside the summary) — so a quarantine that missed it
 * would leave the same root-only number readable. Produce both here.
 */
function recorderWithLcov(root) {
  const rec = recorder(root);
  const inner = rec.exec;
  rec.exec = async (command, args, options) => {
    await inner(command, args, options);
    if (args.some((a) => String(a).endsWith("merge-coverage.mjs"))) {
      writeFileSync(at(root, "lcov.info"), LCOV);
    }
  };
  return rec;
}

/** Drive the full mode with a client pass that fails, and return whatever it threw. */
async function runWithFailingClient(root, rec) {
  const failing = async (command, args, options) => {
    if (command === "npm" && args.includes("gui/client")) throw new Error("client coverage boom");
    return rec.exec(command, args, options);
  };
  const original = console.error;
  console.error = () => {};
  try {
    await main([], { root, exec: failing });
    return null;
  } catch (caught) {
    return caught;
  } finally {
    console.error = original;
  }
}

test("a degraded full run leaves NOTHING at the canonical coverage names", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorderWithLcov(root);
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

test("a degraded run publishes null even with the marker deleted by hand", async () => {
  // The renames are load-bearing on their own. Someone who "fixes" the dashboard by deleting the
  // marker must still not get a number out of a partial measurement — and the scanner, which
  // never reads the marker in the first place, is permanently in this state.
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorderWithLcov(root);
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
  const rec = recorderWithLcov(root);
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
