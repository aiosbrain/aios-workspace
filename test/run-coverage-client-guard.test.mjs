import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { clientWorkspaceStatus, hasClientWorkspace, main } from "../scripts/run-coverage.mjs";
import { makeRoot, recorder } from "./run-coverage-guard-fixtures.mjs";

/**
 * AIO-742. Coverage ownership follows the source tree, not root npm workspace metadata. During
 * the GUI split, `gui/client/package.json` can still be present after `workspaces` is changed.
 * That mixed state must run client coverage directly; otherwise about 1,900 live lines disappear
 * from the denominator while root-only coverage can still clear the ratchet.
 */

test("a present client manifest remains coverage-owned after workspace deregistration (AIO-742)", () => {
  const deregistered = makeRoot({ manifest: true, registered: false });
  const registered = makeRoot({ manifest: true, registered: true });
  const gone = makeRoot();
  const bareDirectory = makeRoot();
  mkdirSync(path.join(bareDirectory, "gui", "client", "coverage"), { recursive: true });
  try {
    assert.equal(clientWorkspaceStatus(deregistered), "present");
    assert.equal(hasClientWorkspace(deregistered), true);
    assert.equal(clientWorkspaceStatus(registered), "present");
    assert.equal(hasClientWorkspace(registered), true);
    assert.equal(clientWorkspaceStatus(gone), "no-manifest");
    assert.equal(hasClientWorkspace(gone), false);
    assert.equal(clientWorkspaceStatus(bareDirectory), "no-manifest");
    assert.equal(hasClientWorkspace(bareDirectory), false);
  } finally {
    for (const root of [deregistered, registered, gone, bareDirectory]) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("npm --prefix executes a deregistered client without root workspace metadata", (t) => {
  const root = makeRoot({ manifest: true, registered: false });
  try {
    try {
      execFileSync("npm", ["--prefix", "gui/client", "run", "test:coverage"], {
        cwd: root,
        stdio: "pipe",
      });
    } catch (error) {
      if (error.code === "ENOENT") return t.skip("npm is not runnable in this environment");
      throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [mode, argv] of [
  ["full", []],
  ["merge", ["--merge", "1"]],
]) {
  test(`run-coverage ${mode} skips only after the client manifest is removed`, async () => {
    const root = makeRoot();
    const rec = recorder(root);
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await main(argv, { root, exec: rec.exec });
    } finally {
      console.log = originalLog;
    }
    try {
      assert.equal(rec.clientRuns(), 0);
      assert.ok(logs.some((line) => /root only .* no gui\/client manifest/.test(line)));
      assert.ok(
        rec.calls.some((call) =>
          call.args.some((arg) => String(arg).endsWith("merge-coverage.mjs"))
        ),
        "root coverage must still be merged"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const registered of [true, false]) {
    test(`run-coverage ${mode} runs the present client when root registration is ${registered}`, async () => {
      const root = makeRoot({ manifest: true, registered });
      const rec = recorder(root);
      try {
        await main(argv, { root, exec: rec.exec });
        const clientCalls = rec.calls.filter(
          (call) => call.command === "npm" && call.args.includes("gui/client")
        );
        assert.equal(clientCalls.length, 1);
        assert.deepEqual(clientCalls[0].args, ["--prefix", "gui/client", "run", "test:coverage"]);
        assert.equal(clientCalls[0].options.cwd, root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("merge mode still writes the baseline candidate after the GUI cut", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  try {
    await main(["--merge", "1"], { root, exec: rec.exec });
    const summary = JSON.parse(
      readFileSync(path.join(root, "coverage", "coverage-summary.json"), "utf8")
    );
    assert.equal(summary.total.lines.pct, 80);
    const candidate = JSON.parse(
      readFileSync(path.join(root, "coverage", "coverage-baseline-candidate.json"), "utf8")
    );
    assert.ok(candidate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full mode writes root coverage before propagating a present-client failure", async () => {
  const root = makeRoot({ manifest: true, registered: false });
  const rec = recorder(root);
  const failing = async (command, args, options) => {
    if (command === "npm" && args.includes("gui/client")) throw new Error("client coverage boom");
    return rec.exec(command, args, options);
  };
  const originalError = console.error;
  console.error = () => {};
  let thrown;
  try {
    await main([], { root, exec: failing });
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalError;
  }
  try {
    assert.match(thrown?.message ?? "", /client coverage boom/);
    assert.ok(
      rec.calls.some((call) => call.args.some((arg) => String(arg).endsWith("merge-coverage.mjs"))),
      "root artifact must be produced before the client failure propagates"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an injected root drives every spawned command cwd", async () => {
  const root = makeRoot({ manifest: true, registered: false });
  const rec = recorder(root);
  try {
    await main([], { root, exec: rec.exec });
    assert.deepEqual(
      rec.calls.filter((call) => call.options?.cwd !== root),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
