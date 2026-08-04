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
 * red, and coverage under-reports indefinitely. `coverage/coverage-degraded.json` is what makes
 * that state loud.
 */

function silenceErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

test("a failed client pass is published as NO report, not as a plausible lower one", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  const failing = async (command, args, options) => {
    if (command === "npm" && args.includes("gui/client")) throw new Error("client coverage boom");
    return rec.exec(command, args, options);
  };
  const originalError = console.error;
  console.error = () => {};
  let thrown = null;
  try {
    await main([], { root, exec: failing });
  } catch (caught) {
    thrown = caught;
  } finally {
    console.error = originalError;
  }
  try {
    assert.match(thrown?.message ?? "", /client coverage boom/, "the failure must still propagate");

    // The artifact is on disk and looks entirely ordinary — that is precisely the problem.
    const summaryPath = path.join(root, "coverage", "coverage-summary.json");
    assert.ok(existsSync(summaryPath), "root coverage must still be produced");
    assert.equal(JSON.parse(readFileSync(summaryPath, "utf8")).total.lines.pct, 80);

    const marker = JSON.parse(
      readFileSync(path.join(root, "coverage", "coverage-degraded.json"), "utf8")
    );
    assert.match(marker.reason, /client coverage boom/);
    assert.deepEqual(marker.missing, ["gui/client"]);

    // The consequence that actually matters: nothing publishable comes out of it.
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean MERGE clears a stale degraded marker and publishes", async () => {
  // Merge mode is where the stale-marker problem actually bites. runFull wipes the whole
  // coverage/ directory on entry, so a marker cannot survive it; merge mode deliberately does
  // NOT, because it needs the shard data — so without an explicit clear, one earlier failed full
  // run would suppress every later merged artifact. A guard that fails permanently closed is its
  // own outage.
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(
      path.join(root, "coverage", "coverage-degraded.json"),
      JSON.stringify({ reason: "left over from an earlier failed run" })
    );

    await main(["--merge", "1"], { root, exec: rec.exec });

    assert.equal(
      existsSync(path.join(root, "coverage", "coverage-degraded.json")),
      false,
      "a successful merge must clear the stale marker"
    );
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
    writeFileSync(path.join(root, "coverage", "coverage-summary.json"), SUMMARY);
    writeFileSync(path.join(root, "coverage", "coverage-degraded.json"), "{ not json");
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
    writeFileSync(path.join(root, "coverage", "coverage-summary.json"), SUMMARY);
    writeFileSync(path.join(root, "coverage", "coverage-degraded.json"), "42");
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no marker means the artifact publishes normally", () => {
  // The guard has to be inert on the happy path, or it is just an outage with extra steps.
  const root = makeRoot();
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(path.join(root, "coverage", "coverage-summary.json"), SUMMARY);
    const report = readCoverageReport(root);
    assert.ok(report);
    assert.equal(report.lines_pct, 80);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
