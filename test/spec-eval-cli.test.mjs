// test/spec-eval-cli.test.mjs — end-to-end through `aios spec` in a child process: the exit-code
// contract (0/1/3/4), the --json shape (incl. exitCode), and fix's file I/O (default writes
// <name>.improved.md, --write overwrites, the original is untouched unless --write). The LLM layer
// is driven by the AIOS_SPEC_EVAL_STUB / AIOS_SPEC_FIX_STUB seams — no API key, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");
const STRONG = path.join(FIXTURES, "strong-spec.md");
const DEMO = path.join(FIXTURES, "acceptance-demo-weak.md");

function runSpec(args, env = {}) {
  const r = spawnSync(process.execPath, [AIOS, "spec", ...args, "--repo", REPO], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("eval --no-llm on a clean spec → exit 3 (NOT_EVALUATED)", () => {
  assert.equal(runSpec(["eval", STRONG, "--no-llm"]).code, 3);
});

test("eval --no-llm on a spec with a deterministic blocker → exit 1", () => {
  assert.equal(runSpec(["eval", DEMO, "--no-llm"]).code, 1);
});

test("eval with a SPEC_READY stub on a clean spec → exit 0", () => {
  const env = { AIOS_SPEC_EVAL_STUB: '{"verdict":"SPEC_READY","score":92,"findings":[]}' };
  assert.equal(runSpec(["eval", STRONG], env).code, 0);
});

test("eval with an adversarial-blocker stub on a clean spec → exit 2", () => {
  const env = {
    AIOS_SPEC_EVAL_STUB:
      '{"verdict":"NOT_READY","score":30,"findings":[{"ruleId":"SR15","severity":"blocker","why":"x"}]}',
  };
  assert.equal(runSpec(["eval", STRONG], env).code, 2);
});

test("eval with junk from the evaluator → exit 2 (synthetic blocker, fail closed)", () => {
  assert.equal(runSpec(["eval", STRONG], { AIOS_SPEC_EVAL_STUB: "totally not json" }).code, 2);
});

test("missing spec file → exit 4", () => {
  assert.equal(runSpec(["eval", "/no/such/spec.md", "--no-llm"]).code, 4);
});

test("unknown subcommand → exit 4", () => {
  assert.equal(runSpec(["frobnicate", STRONG]).code, 4);
});

test("--json output carries verdict + exitCode + findings", () => {
  const r = runSpec(["eval", DEMO, "--no-llm", "--json"]);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verdict, "NOT_READY");
  assert.equal(j.exitCode, 1);
  assert.ok(Array.isArray(j.findings) && j.findings.length > 0);
});

test("fix default writes <name>.improved.md, leaves the original untouched", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-fix-"));
  const target = path.join(d, "s.md");
  const original = readFileSync(DEMO, "utf8");
  writeFileSync(target, original);
  const r = runSpec(["fix", target, "--no-llm"], { AIOS_SPEC_FIX_STUB: STRONG });
  assert.equal(r.code, 0); // reviser returns a clean spec → converges
  const improved = path.join(d, "s.improved.md");
  assert.ok(existsSync(improved), "expected <name>.improved.md");
  assert.equal(readFileSync(improved, "utf8"), readFileSync(STRONG, "utf8"));
  assert.equal(readFileSync(target, "utf8"), original, "original must be untouched");
  rmSync(d, { recursive: true, force: true });
});

test("fix --write overwrites in place", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-fix-w-"));
  const target = path.join(d, "s.md");
  writeFileSync(target, readFileSync(DEMO, "utf8"));
  const r = runSpec(["fix", target, "--no-llm", "--write"], { AIOS_SPEC_FIX_STUB: STRONG });
  assert.equal(r.code, 0);
  assert.ok(!existsSync(path.join(d, "s.improved.md")), "no sidecar file when --write");
  assert.equal(readFileSync(target, "utf8"), readFileSync(STRONG, "utf8"));
  rmSync(d, { recursive: true, force: true });
});

test("fix --json carries exitCode and the output path", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-fix-j-"));
  const target = path.join(d, "s.md");
  writeFileSync(target, readFileSync(DEMO, "utf8"));
  const r = runSpec(["fix", target, "--no-llm", "--json"], { AIOS_SPEC_FIX_STUB: STRONG });
  const j = JSON.parse(r.stdout);
  assert.equal(j.exitCode, 0);
  assert.equal(j.outputPath, path.join(d, "s.improved.md"));
  rmSync(d, { recursive: true, force: true });
});
