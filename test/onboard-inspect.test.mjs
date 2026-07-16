import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { inspectOnboarding } from "../scripts/onboard-inspect.mjs";

function makeWorkspace(root, { url = "", key = "", partial = false } = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "aios.yaml"),
    `version: 1\nbrain_url: "${url}"\napi_key_env: AIOS_API_KEY\ncontext: employee\n`
  );
  if (key) writeFileSync(path.join(root, ".env"), `AIOS_API_KEY=${key}\n`);
  if (!partial) {
    for (const marker of ["0-context", "1-inbox", "2-work"]) mkdirSync(path.join(root, marker));
    writeFileSync(path.join(root, "AGENTS.md"), "# Agent\n");
    writeFileSync(path.join(root, ".aios-toolkit-version"), "unknown\ntoolkit-version 0.0.0\n");
  }
  execFileSync("git", ["init", "-q", root]);
  return root;
}

test("fresh state recommends scaffold and performs no writes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-inspect-empty-"));
  try {
    const report = inspectOnboarding({ startDir: root, roots: [root], toolkitDir: "/nonexistent" });
    assert.equal(report.recommended_action, "scaffold");
    assert.deepEqual(report.workspace_candidates, []);
    assert.equal(report.live_state, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("join configuration is complete without team_id and copied UI URLs normalize", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-inspect-join-"));
  const ws = makeWorkspace(path.join(root, "alex"), {
    url: "https://brain.example.com/t/aios",
    key: "aios_k_secret",
  });
  try {
    const report = inspectOnboarding({ repo: ws, roots: [ws] });
    const candidate = report.workspace_candidates[0];
    assert.equal(candidate.brain.completeness, "configured");
    assert.equal(candidate.brain.team_id_configured, false);
    assert.equal(candidate.brain.normalization.origin, "https://brain.example.com");
    assert.notEqual(report.recommended_action, "repair-configuration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial and unsafe configurations recommend repair", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-inspect-repair-"));
  const ws = makeWorkspace(path.join(root, "alex"), {
    url: "http://brain.example.com/admin",
    key: "aios_k_secret",
    partial: true,
  });
  try {
    const report = inspectOnboarding({ repo: ws, roots: [ws] });
    assert.equal(report.recommended_action, "repair-configuration");
    assert.equal(report.workspace_candidates[0].brain.normalization.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty workspace is reported but never changed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-inspect-dirty-"));
  const ws = makeWorkspace(path.join(root, "alex"));
  writeFileSync(path.join(ws, "personal-note.txt"), "keep me\n");
  try {
    const before = readFileSync(path.join(ws, "personal-note.txt"), "utf8");
    const report = inspectOnboarding({ repo: ws, roots: [ws] });
    assert.equal(report.workspace_candidates[0].git.dirty, true);
    assert.equal(readFileSync(path.join(ws, "personal-note.txt"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
