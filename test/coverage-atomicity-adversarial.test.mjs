import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { COVERAGE_SNAPSHOT_PREFIX } from "../scripts/coverage-outputs.mjs";
import { readCoverageReport } from "../scripts/coverage-report.mjs";
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

test("SIGKILL during promotion cannot expose a partial canonical set", async () => {
  const root = makeRoot();
  mkdirSync(at(root, ".staged"), { recursive: true });
  writeFileSync(at(root, ".staged/coverage-summary.json"), SUMMARY);
  writeFileSync(at(root, ".staged/lcov.info"), LCOV);
  const moduleUrl = new URL("../scripts/coverage-outputs.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { promoteCoverageOutputs } from ${JSON.stringify(moduleUrl)};\n` +
        `promoteCoverageOutputs(${JSON.stringify(root)}, { afterStagedRename: ({ promoted }) => {\n` +
        `  if (promoted.length !== 1) return;\n` +
        `  process.stdout.write("renamed-one\\n");\n` +
        `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n` +
        `} });`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("promotion acknowledgement timed out")),
        5000
      );
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("renamed-one\n")) return;
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill("SIGKILL");
    await once(child, "exit");

    assert.equal(existsSync(path.join(root, "coverage")), false);
    const [unpublished] = readdirSync(root).filter((entry) =>
      entry.startsWith(".coverage-publish-")
    );
    assert.ok(unpublished);
    assert.equal(
      readFileSync(path.join(root, unpublished, "coverage-summary.json"), "utf8"),
      SUMMARY
    );
    assert.equal(readFileSync(path.join(root, unpublished, ".staged/lcov.info"), "utf8"), LCOV);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

test("shard prep failure atomically hides canonical outputs from an earlier run", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const prepFail = async (command, args, options) => {
    if (args.some((arg) => String(arg).endsWith("ensure-loop-built.mjs"))) {
      throw new Error("tsc failed");
    }
    return rec.exec(command, args, options);
  };
  try {
    writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
    writeFileSync(at(root, "lcov.info"), LCOV);

    await assert.rejects(main(["--shard", "1/1"], { root, exec: prepFail }), /tsc failed/);
    assert.equal(existsSync(at(root, "coverage-summary.json")), false);
    assert.equal(existsSync(at(root, "lcov.info")), false);
    assert.ok(existsSync(at(root, "shard-1/shard-failed.marker")));
    const [snapshot] = snapshots(root);
    assert.ok(snapshot, "the complete previous measurement should remain forensic");
    assert.equal(readFileSync(path.join(root, snapshot, "coverage-summary.json"), "utf8"), SUMMARY);
    assert.equal(readFileSync(path.join(root, snapshot, "lcov.info"), "utf8"), LCOV);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shard prep failure also hides a pre-normalized canonical report", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  const report = `${JSON.stringify({ lines_pct: 91, branches_pct: 90 })}\n`;
  const prepFail = async (command, args, options) => {
    if (args.some((arg) => String(arg).endsWith("ensure-loop-built.mjs"))) {
      throw new Error("tsc failed");
    }
    return rec.exec(command, args, options);
  };
  try {
    writeFileSync(at(root, "coverage-report.json"), report);

    await assert.rejects(main(["--shard", "1/1"], { root, exec: prepFail }), /tsc failed/);
    assert.equal(existsSync(at(root, "coverage-report.json")), false);
    assert.equal(readCoverageReport(root), null);
    const [snapshot] = snapshots(root);
    assert.ok(snapshot);
    assert.equal(readFileSync(path.join(root, snapshot, "coverage-report.json"), "utf8"), report);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful shard keeps the prior whole-tree snapshot until merge publishes", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  writeFileSync(at(root, "coverage-summary.json"), SUMMARY);
  writeFileSync(at(root, "lcov.info"), LCOV);
  try {
    await main(["--shard", "1/1"], {
      root,
      exec: rec.exec,
      removeSnapshot: (snapshot) => {
        rmSync(path.join(snapshot, "coverage-summary.json"));
        throw new Error("whole-tree cleanup ran before merge");
      },
    });

    const [snapshot] = snapshots(root);
    assert.ok(snapshot);
    assert.equal(readFileSync(path.join(root, snapshot, "coverage-summary.json"), "utf8"), SUMMARY);
    assert.equal(readFileSync(path.join(root, snapshot, "lcov.info"), "utf8"), LCOV);
    assert.ok(existsSync(at(root, "shard-1/coverage-fixture.json")));

    await main(["--merge", "1"], { root, exec: rec.exec });
    assert.ok(existsSync(at(root, "coverage-summary.json")));
    assert.ok(existsSync(at(root, "lcov.info")));
    assert.deepEqual(snapshots(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
