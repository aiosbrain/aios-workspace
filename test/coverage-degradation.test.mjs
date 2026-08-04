import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readCoverageReport } from "../scripts/coverage-report.mjs";
import { main } from "../scripts/run-coverage.mjs";
import { LCOV, SUMMARY, makeRoot, recorder } from "./run-coverage-guard-fixtures.mjs";

const CANONICAL = ["coverage-summary.json", "lcov.info"];
const QUARANTINED = ["coverage-summary.degraded.json", "lcov.degraded.info"];
const at = (root, name) => path.join(root, "coverage", name);
const isClientPass = (command, args) => command === "npm" && args.includes("gui/client");
const isNodeSuite = (args) => args.some((arg) => String(arg).endsWith("test-suite.mjs"));

function silenceErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

async function runWith(root, rec, shouldFail) {
  const failing = async (command, args, options) => {
    const reason = shouldFail(command, args);
    if (reason) throw new Error(reason);
    return rec.exec(command, args, options);
  };
  const original = console.error;
  console.error = () => {};
  try {
    await main([], { root, exec: failing });
    return null;
  } catch (error) {
    return error;
  } finally {
    console.error = original;
  }
}

test("a degraded full run leaves nothing at the canonical coverage names", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  const thrown = await runWith(root, rec, (command, args) =>
    isClientPass(command, args) ? "client coverage boom" : null
  );
  try {
    assert.match(thrown?.message ?? "", /client coverage boom/);
    for (const name of CANONICAL) assert.equal(existsSync(at(root, name)), false);
    for (const name of QUARANTINED) assert.ok(existsSync(at(root, name)));
    assert.equal(
      JSON.parse(readFileSync(at(root, "coverage-summary.degraded.json"), "utf8")).total.lines.pct,
      80
    );
    assert.equal(readFileSync(at(root, "lcov.degraded.info"), "utf8"), LCOV);
    const marker = JSON.parse(readFileSync(at(root, "coverage-degraded.json"), "utf8"));
    assert.match(marker.reason, /client coverage boom/);
    assert.deepEqual(marker.missing, ["gui/client"]);
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

test("a failing Node suite degrades the artifact and still propagates", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const thrown = await runWith(root, rec, (_command, args) =>
    isNodeSuite(args) ? "17 tests failed" : null
  );
  try {
    assert.match(thrown?.message ?? "", /17 tests failed/);
    for (const name of CANONICAL) assert.equal(existsSync(at(root, name)), false);
    for (const name of QUARANTINED) assert.ok(existsSync(at(root, name)));
    const marker = JSON.parse(readFileSync(at(root, "coverage-degraded.json"), "utf8"));
    assert.match(marker.reason, /node suite failed: 17 tests failed/);
    assert.deepEqual(marker.missing, ["node suite (partial c8 data)"]);
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the marker distinguishes simultaneous suite and client failures", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  const thrown = await runWith(
    root,
    rec,
    (command, args) =>
      (isClientPass(command, args) && "client coverage boom") ||
      (isNodeSuite(args) && "17 tests failed")
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

test("degraded output stays unpublished even if its marker is deleted", async () => {
  const root = makeRoot({ manifest: true, registered: true });
  const rec = recorder(root);
  await runWith(root, rec, (command, args) =>
    isClientPass(command, args) ? "client coverage boom" : null
  );
  try {
    rmSync(at(root, "coverage-degraded.json"), { force: true });
    assert.equal(
      silenceErrors(() => readCoverageReport(root)),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, marker] of [
  ["unreadable", "{ not json"],
  ["non-object", "42"],
]) {
  test(`${name} degraded marker suppresses publication`, () => {
    const root = makeRoot();
    try {
      writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
      writeFileSync(at(root, "coverage-degraded.json"), marker);
      assert.equal(
        silenceErrors(() => readCoverageReport(root)),
        null
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("no marker means the artifact publishes normally", () => {
  const root = makeRoot();
  try {
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    assert.equal(readCoverageReport(root)?.lines_pct, 80);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
