import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { COVERAGE_SNAPSHOT_PREFIX } from "../scripts/coverage-outputs.mjs";
import { main } from "../scripts/run-coverage.mjs";
import { LCOV, SUMMARY, makeRoot, recorder } from "./run-coverage-guard-fixtures.mjs";

const at = (root, name) => path.join(root, "coverage", name);
const snapshots = (root) =>
  readdirSync(root).filter((entry) => entry.startsWith(COVERAGE_SNAPSHOT_PREFIX));

test("standalone merge rejects a staging symlink before it redirects canonical writes", () => {
  const root = makeRoot();
  try {
    mkdirSync(at(root, "root"), { recursive: true });
    writeFileSync(at(root, "root/coverage-summary.json"), SUMMARY);
    writeFileSync(at(root, "root/lcov.info"), LCOV);
    symlinkSync(".", at(root, ".staged"), "dir");
    const script = path.resolve("scripts/merge-coverage.mjs");
    const run = spawnSync(process.execPath, [script, "--out-dir", "coverage/.staged"], {
      cwd: root,
      encoding: "utf8",
    });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /unsafe staging directory/);
    assert.equal(existsSync(at(root, "coverage-summary.json")), false);
    assert.equal(existsSync(at(root, "lcov.info")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion rejects a staging symlink created during the run", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const forged = path.join(root, "forged-staging");
  const maliciousExec = async (command, args, options) => {
    if (!args.some((arg) => String(arg).endsWith("merge-coverage.mjs"))) {
      return rec.exec(command, args, options);
    }
    mkdirSync(forged, { recursive: true });
    writeFileSync(path.join(forged, "coverage-summary.json"), SUMMARY);
    writeFileSync(path.join(forged, "lcov.info"), LCOV);
    mkdirSync(path.join(root, "coverage"), { recursive: true });
    symlinkSync(forged, at(root, ".staged"), "dir");
  };
  try {
    await assert.rejects(
      main([], { root, exec: maliciousExec }),
      /failed to publish.*unsafe staging directory/
    );
    assert.equal(existsSync(at(root, "coverage-summary.json")), false);
    assert.equal(existsSync(at(root, "lcov.info")), false);
    assert.ok(existsSync(path.join(forged, "coverage-summary.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure after promotion is non-load-bearing", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const originalError = console.error;
  console.error = () => {};
  try {
    await main([], {
      root,
      exec: rec.exec,
      cleanup: () => {
        throw new Error("obsolete snapshot is unreadable");
      },
    });
    assert.ok(existsSync(at(root, "coverage-summary.json")));
    assert.ok(existsSync(at(root, "lcov.info")));
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed merge keeps rotated shards for an immediate retry", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  let failReport = true;
  const flakyExec = async (command, args, options) => {
    if (failReport && args.includes("report") && args.includes("--temp-directory")) {
      failReport = false;
      throw new Error("c8 report failed");
    }
    return rec.exec(command, args, options);
  };
  try {
    await assert.rejects(main(["--merge", "1"], { root, exec: flakyExec }), /c8 report failed/);
    assert.equal(existsSync(at(root, "coverage-summary.json")), false);
    assert.equal(snapshots(root).length, 1, "the retryable shard snapshot must survive");

    await main(["--merge", "1"], { root, exec: rec.exec });
    assert.ok(existsSync(at(root, "coverage-summary.json")));
    assert.ok(existsSync(at(root, "lcov.info")));
    assert.deepEqual(snapshots(root), []);
    assert.equal(existsSync(at(root, ".staged")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
