import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  askCiWorkflow,
  checkGhCli,
  ciWorkflowState,
  ghExecutable,
  persistCiWorkflow,
} from "../scripts/ci-workflow.mjs";

test("CI workflow preference distinguishes unset, explicit no, and explicit yes", () => {
  assert.equal(ciWorkflowState({}), null);
  assert.equal(ciWorkflowState({ ci_workflow: false }), false);
  assert.equal(ciWorkflowState({ ci_workflow: "false" }), false);
  assert.equal(ciWorkflowState({ ci_workflow: true }), true);
  assert.equal(ciWorkflowState({ ci_workflow: "true" }), true);
  assert.equal(ciWorkflowState({ ci_workflow: "maybe" }), null);
});

test("persistCiWorkflow adds, replaces, and then preserves the selected preference", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-ci-preference-"));
  const file = path.join(repo, "aios.yaml");
  try {
    writeFileSync(file, "owner: tester\n");
    assert.deepEqual(persistCiWorkflow(repo, true), { enabled: true, changed: true });
    assert.match(readFileSync(file, "utf8"), /^ci_workflow: true$/m);
    assert.deepEqual(persistCiWorkflow(repo, true), { enabled: true, changed: false });
    assert.deepEqual(persistCiWorkflow(repo, false), { enabled: false, changed: true });
    assert.match(readFileSync(file, "utf8"), /^ci_workflow: false$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("askCiWorkflow explains the gate and accepts only yes answers", async () => {
  const logs = [];
  const answer = async () => "yes";
  const close = () => logs.push("closed");
  const createInterface = (options) => {
    assert.equal(options.input, process.stdin);
    assert.equal(options.output, process.stdout);
    return { question: answer, close };
  };
  assert.equal(await askCiWorkflow({ log: (line) => logs.push(line), createInterface }), true);
  assert.match(logs[0], /optional GitHub Actions workflow/);
  assert.deepEqual(logs.slice(1), ["closed"]);

  assert.equal(
    await askCiWorkflow({
      log: () => {},
      createInterface: () => ({ question: async () => "no", close: () => {} }),
    }),
    false
  );
});

test("gh resolution accepts only explicit absolute paths or fixed install locations", () => {
  const exists = (value) => value === "/trusted/gh" || value === "/usr/bin/gh";
  assert.equal(
    ghExecutable({ platform: "darwin", env: { AIOS_GH_PATH: "gh" }, exists }),
    "/usr/bin/gh"
  );
  assert.equal(
    ghExecutable({ platform: "darwin", env: { AIOS_GH_PATH: "/trusted/gh" }, exists }),
    "/trusted/gh"
  );
  assert.equal(
    ghExecutable({ platform: "win32", env: {}, exists: (value) => value.endsWith("gh.exe") }),
    "C:\\Program Files\\GitHub CLI\\gh.exe"
  );
});

test("checkGhCli distinguishes missing, unusable, and unauthenticated GitHub CLI", () => {
  assert.equal(checkGhCli({ exists: () => false }).ok, false);

  assert.match(
    checkGhCli({
      platform: "darwin",
      exists: (value) => value === "/usr/bin/gh",
      execFile: () => {
        throw new Error("not executable");
      },
    }).reason,
    /not installed/
  );

  const calls = [];
  assert.match(
    checkGhCli({
      platform: "darwin",
      exists: (value) => value === "/usr/bin/gh",
      execFile: (command, args) => {
        calls.push([command, args]);
        if (args[0] === "auth") throw new Error("not logged in");
      },
    }).reason,
    /not authenticated/
  );
  assert.deepEqual(calls, [
    ["/usr/bin/gh", ["--version"]],
    ["/usr/bin/gh", ["auth", "status"]],
  ]);

  assert.deepEqual(
    checkGhCli({
      platform: "darwin",
      exists: (value) => value === "/usr/bin/gh",
      execFile: () => {},
    }),
    { ok: true }
  );
});
