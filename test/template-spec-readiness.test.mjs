// test/template-spec-readiness.test.mjs — aios-issue-template ↔ spec-eval contract

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runDeterministicChecks,
  renderAiosIssueTemplate,
  resolveAiosIssueTemplate,
  AIOS_ISSUE_TEMPLATE_REL,
} from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const TEMPLATE = path.join(REPO, AIOS_ISSUE_TEMPLATE_REL);
const FILLED = path.join(REPO, "test/fixtures/spec-eval/aios-issue-filled.md");

function runSpec(args, env = {}) {
  const r = spawnSync(process.execPath, [AIOS, "spec", ...args, "--repo", REPO], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("canonical aios-issue-template path resolves", () => {
  assert.equal(resolveAiosIssueTemplate(REPO), TEMPLATE);
  assert.ok(existsSync(TEMPLATE));
});

test("unfilled template fails deterministic SR3 (placeholder integration path)", () => {
  const text = readFileSync(TEMPLATE, "utf8");
  const findings = runDeterministicChecks(text, { repo: REPO });
  const blockers = findings.filter((f) => f.severity === "blocker");
  assert.ok(blockers.some((f) => f.ruleId === "SR3"), blockers.map((f) => f.detail).join("; "));
});

test("filled aios-issue fixture is deterministic-clean (--no-llm → exit 3)", () => {
  const r = runSpec(["eval", FILLED, "--no-llm", "--json"]);
  assert.equal(r.code, 3, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verdict, "NOT_EVALUATED");
  const blockers = (j.findings || []).filter((f) => f.severity === "blocker");
  assert.equal(blockers.length, 0, blockers.map((f) => f.detail).join("; "));
});

test("aios spec init writes scaffold with optional title", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-init-"));
  try {
    const target = path.join(d, "nested", "issue.md");
    const r = runSpec(["init", target, "--title", "My slice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(target));
    const text = readFileSync(target, "utf8");
    assert.match(text, /^# My slice/m);
    assert.match(text, /## What \/ why/);
    assert.match(text, /## Outcomes/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("renderAiosIssueTemplate substitutes title", () => {
  const text = renderAiosIssueTemplate(REPO, { title: "Agentic Linear factory" });
  assert.match(text, /^# Agentic Linear factory/m);
});
