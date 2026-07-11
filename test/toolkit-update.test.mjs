import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { MANAGED_PATHS, PERSONAL_PATHS } from "../scripts/toolkit-manifest.mjs";
import { dirtyManagedPaths } from "../scripts/update.mjs";

// The overlay/merge mechanics live in toolkit-merge.test.mjs; this file covers the
// manifest invariants and the uncommitted-edit guard.

test("MANAGED_PATHS never overlaps PERSONAL_PATHS (no managed path is personal)", () => {
  const personal = new Set(PERSONAL_PATHS);
  for (const e of MANAGED_PATHS) {
    const top = e.dest.split("/")[0];
    // .claude is shared: managed .claude/* subpaths are fine, but never .claude/memory.
    assert.notEqual(e.dest, ".claude/memory");
    if (top !== ".claude" && top !== "scripts" && top !== "bin") {
      assert.ok(!personal.has(e.dest), `${e.dest} must not be a personal path`);
    }
  }
  // The CLI must be synced as the SHIM file, never the whole scripts/ dir.
  assert.ok(MANAGED_PATHS.some((e) => e.dest === "scripts/aios.mjs" && e.kind === "file"));
  assert.ok(!MANAGED_PATHS.some((e) => e.dest === "scripts" && e.kind === "dir"));
});

test("dirtyManagedPaths detects an uncommitted edit to a managed file", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aios-git-"));
  const git = (...a) => execFileSync("git", ["-C", ws, ...a], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    mkdirSync(path.join(ws, "validation"), { recursive: true });
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "v1");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Clean tree → nothing dirty.
    assert.equal(dirtyManagedPaths(ws).size, 0);
    // Local uncommitted edit → flagged.
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "v1 + my edit");
    assert.ok(dirtyManagedPaths(ws).has("validation/secret-patterns.txt"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dirtyManagedPaths returns empty set outside a git repo (no guard, no throw)", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aios-nogit-"));
  try {
    assert.equal(dirtyManagedPaths(ws).size, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
