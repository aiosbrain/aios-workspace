// The old post-scaffold output ended on a 7-line "Next:" wall no matter what state the
// workspace was actually in — the audit's explicit "ONE STEP. THAT'S IT" complaint. This
// asserts scaffold-project.sh now prints exactly one dynamic next-action line, and the
// 3-branch state machine behind it (aios.mjs's nextAction, exposed via cmdOnboard's
// --print-next-only) responds to real repo state: no brain key -> connect the brain; key
// but nothing pushed -> aios status/push; something pushed -> start the GUI.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vaultSet } from "../scripts/connector.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");
const AIOS_CLI = path.join(ROOT, "scripts", "aios.mjs");

function scaffold(output) {
  return execFileSync(
    "bash",
    [
      SCAFFOLD_SCRIPT,
      "--context",
      "employee",
      "--slug",
      "test-ws",
      "--owner",
      "tester",
      "--output",
      output,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  ).toString();
}

function nextActionFor(repo) {
  return execFileSync("node", [AIOS_CLI, "onboard", "--print-next-only", "--repo", repo], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

test("a real (non-interactive) scaffold run prints exactly one Next: line, not a 7-item wall", () => {
  const output = mkdtempSync(path.join(tmpdir(), "next-action-scaffold-"));
  rmSync(output, { recursive: true, force: true });
  try {
    const stdout = scaffold(output);
    const nextLines = stdout.split("\n").filter((l) => l.trim().startsWith("Next:"));
    assert.equal(
      nextLines.length,
      1,
      `expected exactly one "Next:" line, got: ${JSON.stringify(nextLines)}`
    );
    // The old wall had 6 bulleted "•" items — none should remain.
    assert.equal(stdout.includes("•"), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("nextAction: no brain key yet -> connect the brain", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "next-action-state-"));
  try {
    assert.match(nextActionFor(repo), /Connect the Team Brain/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("nextAction: brain key set, nothing pushed yet -> aios status/push", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "next-action-state-"));
  try {
    vaultSet(repo, "AIOS_API_KEY", "aios_test_fakevalue");
    assert.match(nextActionFor(repo), /aios status/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("nextAction: something already pushed -> start the GUI", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "next-action-state-"));
  try {
    vaultSet(repo, "AIOS_API_KEY", "aios_test_fakevalue");
    mkdirSync(path.join(repo, ".aios"), { recursive: true });
    writeFileSync(
      path.join(repo, ".aios", "state.json"),
      JSON.stringify({ items: { "2-work/foo.md": { sha: "abc", pushed_at: "2026-01-01" } } })
    );
    assert.match(nextActionFor(repo), /npm run gui/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
