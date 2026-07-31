// Unit tests for scripts/toolkit-locate.mjs — the devtools-set toolkit-location seam
// (AIO-594; docs/devtools-toolkit-contract.md). Mirrors the GUI locator's contract: marker
// triad, explicit-source-never-falls-back, actionable errors.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOLKIT_MARKERS,
  looksLikeToolkit,
  locateToolkit,
  loadToolkitModule,
} from "../scripts/toolkit-locate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeToolkitFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-toolkit-locate-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "scaffold"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "aios.mjs"), "// stub CLI\n");
  writeFileSync(path.join(dir, "package.json"), "{}\n");
  return dir;
}

test("marker triad: a dir with all three markers looks like a toolkit; missing any → not", () => {
  const dir = makeToolkitFixture();
  try {
    assert.equal(TOOLKIT_MARKERS.length, 3);
    assert.equal(looksLikeToolkit(dir), true);
    rmSync(path.join(dir, "scaffold"), { recursive: true });
    assert.equal(looksLikeToolkit(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves via AIOS_TOOLKIT_DIR env", () => {
  const dir = makeToolkitFixture();
  try {
    const r = locateToolkit({ argv: [], env: { AIOS_TOOLKIT_DIR: dir } });
    assert.equal(r.source, "AIOS_TOOLKIT_DIR");
    assert.equal(r.dir, realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--toolkit-dir flag wins over env", () => {
  const flagDir = makeToolkitFixture();
  const envDir = makeToolkitFixture();
  try {
    const r = locateToolkit({
      argv: ["--toolkit-dir", flagDir],
      env: { AIOS_TOOLKIT_DIR: envDir },
    });
    assert.equal(r.source, "--toolkit-dir");
    assert.equal(r.dir, realpathSync(flagDir));
  } finally {
    rmSync(flagDir, { recursive: true, force: true });
    rmSync(envDir, { recursive: true, force: true });
  }
});

test("containing repo root is the in-monorepo fallback (this repo IS a toolkit)", () => {
  const r = locateToolkit({ argv: [], env: {} });
  assert.equal(r.source, "containing-repo");
  assert.equal(r.dir, realpathSync(repoRoot));
});

test("explicit env pointing at a non-toolkit is a hard error, never a silent fallback", () => {
  const notToolkit = mkdtempSync(path.join(tmpdir(), "aios-not-toolkit-"));
  try {
    assert.throws(
      () => locateToolkit({ argv: [], env: { AIOS_TOOLKIT_DIR: notToolkit } }),
      /via AIOS_TOOLKIT_DIR.*missing.*scripts\/aios\.mjs/s
    );
  } finally {
    rmSync(notToolkit, { recursive: true, force: true });
  }
});

test("--toolkit-dir with a missing value is a hard, actionable error", () => {
  assert.throws(
    () => locateToolkit({ argv: ["--toolkit-dir"], env: {} }),
    /--toolkit-dir requires a path argument/
  );
  assert.throws(
    () => locateToolkit({ argv: ["--toolkit-dir", "--json"], env: {} }),
    /--toolkit-dir requires a path argument/
  );
});

test("no source at all → actionable error naming AIOS_TOOLKIT_DIR", () => {
  const notToolkit = mkdtempSync(path.join(tmpdir(), "aios-not-toolkit-"));
  try {
    assert.throws(
      () => locateToolkit({ argv: [], env: {}, containingRoot: notToolkit }),
      /Set AIOS_TOOLKIT_DIR/
    );
  } finally {
    rmSync(notToolkit, { recursive: true, force: true });
  }
});

test("loadToolkitModule loads the same core module instance as a static import", async () => {
  const viaSeam = await loadToolkitModule("severity.mjs");
  const viaStatic = await import("../scripts/severity.mjs");
  assert.equal(typeof viaSeam.hasCriticalOrHighFindings, "function");
  // Same resolved URL → same ESM cache entry → identical module namespace.
  assert.equal(viaSeam.SEVERITY_RANK, viaStatic.SEVERITY_RANK);
  assert.equal(viaSeam.hasFindingsAtOrAbove, viaStatic.hasFindingsAtOrAbove);
});
