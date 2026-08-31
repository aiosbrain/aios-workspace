// AIO-1067 — the negative import fixture: a BROKEN Linear adapter must be quarantined to
// its own command surface. The broken-linear-loader module hook rewrites every module under
// scripts/connectors/linear/ to `throw new Error("broken adapter fixture")`, then proves:
//
//   - `aios help` / `version` / `doctor` / `provenance` still exit 0 and never load it;
//   - the Slack surface never touches it;
//   - `aios linear` itself DOES hit the sabotage (the positive control) and fails as a
//     contained CLI error, not an unhandled stack dump.
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
const BROKEN = path.join(ROOT, "test", "helpers", "broken-linear-loader.mjs");
const PROBE = pathToFileURL(path.join(ROOT, "test", "helpers", "import-probe.mjs")).href;

const run = (bin, args, extraEnv = {}) =>
  spawnSync(process.execPath, ["--import", BROKEN, bin, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });

test("help/version/doctor/provenance survive a broken Linear adapter", () => {
  for (const args of [["help"], ["--version"], ["doctor", "--json"], ["provenance", "--json"]]) {
    const result = run(AIOS, args);
    assert.equal(
      result.status,
      0,
      `aios ${args.join(" ")} exited ${result.status}: ${result.stderr}`
    );
    assert.doesNotMatch(result.stdout + result.stderr, /broken adapter fixture/);
  }
});

test("an unrelated workspace command survives a broken Linear adapter", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aio-1067-quarantine-ws-"));
  try {
    writeFileSync(path.join(ws, "project.yaml"), "project: sample\n");
    const result = spawnSync(process.execPath, ["--import", BROKEN, AIOS, "graph"], {
      cwd: ws,
      encoding: "utf8",
    });
    assert.doesNotMatch(result.stdout + result.stderr, /broken adapter fixture/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the Slack surface never imports the Linear adapter", () => {
  // Static: neither the slack bin nor its shared runtime references the adapter seam.
  for (const file of ["scripts/slack.mjs", "scripts/global-connector-runtime.mjs"]) {
    assert.doesNotMatch(
      readFileSync(path.join(ROOT, file), "utf8"),
      /connectors\/linear|connectors\.mjs/
    );
  }
  // Dynamic: the slack entrypoint under the sabotage hook never trips the fixture (its own
  // exit status depends on a python3 runtime, which is not what this test asserts).
  const result = run(SLACK_BIN, ["dm", "--help"]);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /broken adapter fixture/);
});

test("positive control: `aios linear` does hit the sabotage, as a contained CLI error", () => {
  const result = run(AIOS, ["linear", "template", "aios"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken adapter fixture/);
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|at ModuleJob/);
});

test("diagnostics never import the adapter even when it is healthy (import trace)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio-1067-trace-"));
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
        !trace.includes("scripts/connectors/linear/"),
        `aios ${args.join(" ")} imported the Linear adapter:\n${trace}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
