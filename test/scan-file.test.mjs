import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultScanFile as scanFileDirect } from "../scripts/scan-file.mjs";
import { defaultScanFile as scanFileFromPromote } from "../scripts/promote.mjs";

function withCandidate(content, run) {
  const root = mkdtempSync(path.join(tmpdir(), "aios-scan-file-"));
  const candidate = path.join(root, "candidate.md");
  writeFileSync(candidate, content);
  try {
    return run(candidate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("defaultScanFile reports a clean temporary file as clean", () => {
  withCandidate("# Synthetic release note\n\nNo credentials or private identifiers.\n", (candidate) => {
    assert.deepEqual(scanFileDirect(candidate), { clean: true, findings: [] });
  });
});

test("defaultScanFile rejects a synthetic secret without echoing its value or path", () => {
  const syntheticSecret = "AKIA" + "Q".repeat(16);
  withCandidate(`credential: ${syntheticSecret}\n`, (candidate) => {
    const result = scanFileDirect(candidate);
    assert.equal(result.clean, false);
    assert.ok(result.findings.some((finding) => finding.startsWith("secret pattern matched:")));
    assert.ok(result.findings.every((finding) => !finding.includes(syntheticSecret)));
    assert.ok(result.findings.every((finding) => !finding.includes(candidate)));
  });
});

test("promote preserves the historical defaultScanFile export identity", () => {
  assert.equal(scanFileFromPromote, scanFileDirect);
});
