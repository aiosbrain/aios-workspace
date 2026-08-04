// test/check-runtime-adapters.test.mjs — unit tests for OGR07
// (validation/check-runtime-adapters.mjs), the BYOA runtime-registry validator.
//
// Runs the validator as a child process, the same pattern as OGR14's tests
// (test/check-file-governance.test.mjs): it exercises the real CLI contract —
// argv, exit code, stdout — that validate-all.sh actually depends on.
//
// AIO-612 rewrote this validator: checks 3 and 4 used to import
// gui/server/runtime-adapters/{index,guard}.mjs and SKIP with a yellow note whenever
// gui/server was absent. The cut moved gui/ to aiosbrain/aios-workspace-gui, so that
// path can never resolve again — the checks would have skipped on every run, forever,
// while still printing a reassuring line. A check that cannot succeed is worse than no
// check, so they were removed rather than left to rot. These tests hold that shape:
// OGR07 must pass on its own, and must not reintroduce a permanently-skipping GUI probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = path.join(REPO, "validation", "check-runtime-adapters.mjs");

function runValidator(args = []) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

test("OGR07 passes against this repo's real runtime registry", () => {
  const result = runValidator();
  assert.equal(result.status, 0, `OGR07 failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OGR07 PASSED/);
  assert.match(result.stdout, /registry: \d+ runtimes, views consistent, claude-api non-GUI/);
  assert.match(result.stdout, /flat-yaml reads agent_runtime/);
});

test("OGR07 accepts the repo argument validate-all.sh passes it", () => {
  // validate-all.sh's run_check signature always passes a repo path. The validator ignores
  // it, but it must not choke on it — a validator that only works when invoked by hand is
  // not wired into anything.
  const result = runValidator([REPO]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OGR07 PASSED/);
});

test("OGR07 reports every check it claims, and reports no skips", () => {
  // The failure this guards against is a validator whose checks silently stop running while
  // it keeps printing a pass. Every line it emits must be a real ✓ — no "—" skip markers.
  const result = runValidator();
  const checks = result.stdout.split("\n").filter((line) => line.includes("✓"));
  assert.equal(checks.length, 2, `expected exactly 2 checks, got:\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /—/, "a skipped check must not be reported as coverage");
  assert.doesNotMatch(result.stdout, /skipped/i);
});

test("OGR07 no longer probes the cut GUI trees (AIO-612)", () => {
  // A source-level assertion, because the runtime behaviour of a permanently-skipping probe
  // is indistinguishable from one that simply found nothing wrong — which is exactly why the
  // old checks were removed instead of left in place.
  const source = readFileSync(VALIDATOR, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /gui\/server/, "OGR07 must not import from the cut gui/ tree");
  assert.doesNotMatch(code, /runtime-adapters/, "the GUI adapter probe belongs in the GUI repo");
});

test("OGR07 fails loudly when the registry is wrong", () => {
  // Proves the validator can actually fail. Without this the passing assertions above would
  // also hold for a validator that had been reduced to printing PASSED unconditionally.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const {readFileSync}=require("node:fs");
       let src=readFileSync(${JSON.stringify(VALIDATOR)},"utf8");
       src=src.replace('const expected = [', 'const expected = ["definitely-not-a-runtime", ');
       const {writeFileSync,mkdtempSync}=require("node:fs");
       const {tmpdir}=require("node:os"), p=require("node:path");
       const dir=mkdtempSync(p.join(tmpdir(),"ogr07-"));
       const f=p.join(dir,"check.mjs");
       writeFileSync(f,src);
       const r=require("node:child_process").spawnSync(process.execPath,[f],{encoding:"utf8"});
       process.stdout.write(String(r.status)+"\\n"+r.stdout);`,
    ],
    { cwd: REPO, encoding: "utf8" }
  );
  // The mutated copy lives in a tmp dir, so its relative imports resolve differently; what
  // matters is that a missing expected runtime produces a nonzero exit, not a pass.
  assert.doesNotMatch(result.stdout, /^0\n[\s\S]*OGR07 PASSED/, "a broken registry must not pass");
});
