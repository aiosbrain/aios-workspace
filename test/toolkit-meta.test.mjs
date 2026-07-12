import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toolkitVersion, brainApiVersion, toolkitMeta } from "../scripts/toolkit-meta.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reads this toolkit's real version + brain-api from the repo", () => {
  const m = toolkitMeta(repoRoot);
  assert.match(m.version, /^\d+\.\d+\.\d+$/); // real semver from package.json
  assert.match(m.brainApi, /^\d+\.\d+$/); // real contract version from docs/brain-api.md
  assert.equal(m.label, `v${m.version} (brain-api ${m.brainApi})`);
});

test("falls back gracefully when files are missing", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "aios-meta-"));
  try {
    assert.equal(toolkitVersion(empty), "0.0.0");
    assert.equal(brainApiVersion(empty), undefined);
    assert.equal(toolkitMeta(empty).label, "v0.0.0"); // no brain-api → version-only label
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("parses version + brain-api from a synthetic toolkit", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-meta2-"));
  try {
    writeFileSync(path.join(tk, "package.json"), JSON.stringify({ version: "1.2.3" }));
    mkdirSync(path.join(tk, "docs"), { recursive: true });
    writeFileSync(
      path.join(tk, "docs", "brain-api.md"),
      "# API\n\n**Version: 2.5** (`/api/v1`).\n"
    );
    assert.equal(toolkitVersion(tk), "1.2.3");
    assert.equal(brainApiVersion(tk), "2.5");
    assert.equal(toolkitMeta(tk).label, "v1.2.3 (brain-api 2.5)");
  } finally {
    rmSync(tk, { recursive: true, force: true });
  }
});
