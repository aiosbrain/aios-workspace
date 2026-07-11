import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { MANAGED_PATHS, PERSONAL_PATHS } from "../scripts/toolkit-manifest.mjs";
import { syncManaged, dirtyManagedPaths } from "../scripts/update.mjs";

/** Build a minimal fake toolkit checkout covering every managed source path. */
function fakeToolkit() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-tk-"));
  for (const e of MANAGED_PATHS) {
    const src = path.join(root, e.src);
    if (e.kind === "dir") {
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, "toolkit-file.md"), "TOOLKIT v2");
    } else {
      mkdirSync(path.dirname(src), { recursive: true });
      writeFileSync(src, "TOOLKIT v2");
    }
  }
  return root;
}

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

test("syncManaged is an OVERLAY — updates toolkit files, never deletes personal ones", () => {
  const src = fakeToolkit();
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-"));
  try {
    // A personal skill + an OLD toolkit file already in the workspace.
    const skillsDest = path.join(ws, ".claude/skills");
    mkdirSync(path.join(skillsDest, "my-personal-skill"), { recursive: true });
    writeFileSync(path.join(skillsDest, "my-personal-skill", "SKILL.md"), "MINE");
    writeFileSync(path.join(skillsDest, "toolkit-file.md"), "TOOLKIT v1"); // will be overwritten

    const { results, skipped } = syncManaged(src, ws);
    assert.ok(results.every((r) => r.status === "synced"));
    assert.equal(skipped.length, 0);

    // Personal skill survives.
    assert.ok(existsSync(path.join(skillsDest, "my-personal-skill", "SKILL.md")));
    assert.equal(
      readFileSync(path.join(skillsDest, "my-personal-skill", "SKILL.md"), "utf8"),
      "MINE"
    );
    // Toolkit file was updated in place.
    assert.equal(readFileSync(path.join(skillsDest, "toolkit-file.md"), "utf8"), "TOOLKIT v2");
    // The shim + a guardrail hook landed.
    assert.equal(readFileSync(path.join(ws, "scripts/aios.mjs"), "utf8"), "TOOLKIT v2");
    assert.ok(existsSync(path.join(ws, "hooks/team-ops-guard.sh")));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("syncManaged reports missing-in-source instead of throwing", () => {
  const src = mkdtempSync(path.join(tmpdir(), "aios-empty-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws2-"));
  try {
    const { results } = syncManaged(src, ws);
    assert.ok(results.every((r) => r.status === "missing-in-source"));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
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

test("syncManaged skips dirty files (uncommitted local edits are never clobbered)", () => {
  const src = fakeToolkit();
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws3-"));
  try {
    // A locally-edited managed file in a dir entry, plus a dirty top-level file entry.
    const skillFile = ".claude/skills/toolkit-file.md";
    mkdirSync(path.join(ws, ".claude/skills"), { recursive: true });
    writeFileSync(path.join(ws, skillFile), "MY LOCAL EDIT");
    mkdirSync(path.join(ws, "validation"), { recursive: true });
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "MY TIGHTENED PATTERNS");

    const dirty = new Set([skillFile, "validation/secret-patterns.txt"]);
    const { results, skipped } = syncManaged(src, ws, { dirty });

    // Both dirty files preserved verbatim, and reported as skipped.
    assert.equal(readFileSync(path.join(ws, skillFile), "utf8"), "MY LOCAL EDIT");
    assert.equal(
      readFileSync(path.join(ws, "validation/secret-patterns.txt"), "utf8"),
      "MY TIGHTENED PATTERNS"
    );
    assert.ok(skipped.includes(skillFile));
    assert.ok(skipped.includes("validation/secret-patterns.txt"));
    // The file entry reports skipped-dirty; a clean sibling toolkit file still landed.
    const secretEntry = results.find((r) => r.path === "validation/secret-patterns.txt");
    assert.equal(secretEntry.status, "skipped-dirty");
    assert.equal(readFileSync(path.join(ws, "scripts/aios.mjs"), "utf8"), "TOOLKIT v2");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
