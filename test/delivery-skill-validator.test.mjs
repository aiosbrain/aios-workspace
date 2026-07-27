import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const VALIDATOR = path.join(REPO, "validation", "check-delivery-skill-suite.mjs");

test("focused delivery validator accepts the canonical first-party suite", () => {
  const output = execFileSync(process.execPath, [VALIDATOR, REPO], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.match(output, /PASS delivery skill suite: 14 skills/);
});

test("focused delivery validator skips workspaces where the optional suite is absent", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "delivery-suite-absent-"));
  try {
    const output = execFileSync(process.execPath, [VALIDATOR, workspace], {
      cwd: REPO,
      encoding: "utf8",
    });
    assert.match(output, /SKIP delivery skill suite: manifest not installed/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
