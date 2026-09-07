// AIO-1068 — the negative import fixture: a BROKEN Slack adapter must be quarantined to
// its own command surface. The broken-slack-loader module hook rewrites every module under
// scripts/connectors/slack/ to `throw`, then proves:
//
//   - `aios help` / `version` / `doctor` / `provenance` still exit 0 and never load it;
//   - the Linear surface (canonical AND compat bin) never touches it;
//   - `aios slack` and the compat `slack` bin DO hit the sabotage (positive controls) and
//     fail as contained CLI errors, not unhandled stack dumps.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");
const SLACK_BIN = path.join(ROOT, "scripts", "slack.mjs");
const LINEAR_BIN = path.join(ROOT, "scripts", "linear.mjs");
const BROKEN = path.join(ROOT, "test", "helpers", "broken-slack-loader.mjs");
const PROBE = pathToFileURL(path.join(ROOT, "test", "helpers", "import-probe.mjs")).href;

const run = (bin, args, extraEnv = {}) =>
  spawnSync(process.execPath, ["--import", BROKEN, bin, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });

test("help/version/doctor/provenance survive a broken Slack adapter", () => {
  for (const args of [["help"], ["--version"], ["doctor", "--json"], ["provenance", "--json"]]) {
    const result = run(AIOS, args);
    assert.equal(
      result.status,
      0,
      `aios ${args.join(" ")} exited ${result.status}: ${result.stderr}`
    );
    assert.doesNotMatch(result.stdout + result.stderr, /broken slack adapter fixture/);
  }
});

test("the Linear surface survives a broken Slack adapter (canonical and compat bin)", () => {
  for (const [bin, args] of [
    [AIOS, ["linear", "template", "aios"]],
    [LINEAR_BIN, ["template", "aios"]],
  ]) {
    const result = run(bin, args);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /broken slack adapter fixture/);
  }
  // Static: the Linear surface never references the Slack adapter directory.
  for (const file of ["scripts/linear.mjs", "scripts/connectors/linear/index.mjs"]) {
    assert.doesNotMatch(readFileSync(path.join(ROOT, file), "utf8"), /connectors\/slack/);
  }
});

test("an unrelated workspace command survives a broken Slack adapter", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aio-1068-quarantine-ws-"));
  try {
    writeFileSync(path.join(ws, "project.yaml"), "project: sample\n");
    const result = spawnSync(process.execPath, ["--import", BROKEN, AIOS, "graph"], {
      cwd: ws,
      encoding: "utf8",
    });
    assert.doesNotMatch(result.stdout + result.stderr, /broken slack adapter fixture/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("positive controls: both Slack routes hit the sabotage as contained CLI errors", () => {
  for (const [bin, args] of [
    [AIOS, ["slack", "whoami"]],
    [SLACK_BIN, ["whoami"]],
  ]) {
    const result = run(bin, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /broken slack adapter fixture/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|at ModuleJob/);
  }
});

test("diagnostics never import the adapter even when it is healthy (import trace)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio-1068-trace-"));
  try {
    for (const args of [
      ["--help"],
      ["--version"],
      ["doctor", "--json"],
      ["provenance", "--json"],
    ]) {
      const out = path.join(dir, "trace.txt");
      writeFileSync(out, "");
      const result = spawnSync(process.execPath, [AIOS, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, AIOS_IMPORT_TRACE: out, NODE_OPTIONS: `--import ${PROBE}` },
      });
      assert.equal(result.status, 0, `aios ${args.join(" ")} exited ${result.status}`);
      const trace = readFileSync(out, "utf8");
      assert.match(trace, /scripts\/aios\.mjs/, "probe captured the startup graph");
      assert.ok(
        !trace.includes("scripts/connectors/slack/"),
        `aios ${args.join(" ")} imported the Slack adapter:\n${trace}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
