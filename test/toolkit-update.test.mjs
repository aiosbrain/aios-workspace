import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { MANAGED_PATHS, PERSONAL_PATHS, SEED_IF_ABSENT } from "../scripts/toolkit-manifest.mjs";
import { dirtyManagedPaths, mergeManaged, missingSeedPaths } from "../scripts/update.mjs";

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

test("mergeManaged creates a SEED_IF_ABSENT file when the personal destination is absent", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-seed-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-seed-"));
  const seed = SEED_IF_ABSENT.find((e) => e.dest === ".aios/comms-config.json");
  assert.ok(seed, "comms config seed is declared");
  try {
    const starter = '{"channels":{},"sender":{"channel":null}}\n';
    mkdirSync(path.dirname(path.join(tk, seed.src)), { recursive: true });
    writeFileSync(path.join(tk, seed.src), starter);

    assert.deepEqual(missingSeedPaths(tk, ws), [seed.dest]);
    const result = mergeManaged(tk, tk, ws, undefined, {});

    assert.deepEqual(result.seeded, [seed.dest]);
    assert.equal(readFileSync(path.join(ws, seed.dest), "utf8"), starter);
    assert.deepEqual(missingSeedPaths(tk, ws), []);
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged never reads, merges, or overwrites an existing seed destination, even with --force", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-seed-existing-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-seed-existing-"));
  const seed = SEED_IF_ABSENT.find((e) => e.dest === ".aios/comms-config.json");
  assert.ok(seed, "comms config seed is declared");
  try {
    mkdirSync(path.dirname(path.join(tk, seed.src)), { recursive: true });
    mkdirSync(path.dirname(path.join(ws, seed.dest)), { recursive: true });
    writeFileSync(path.join(tk, seed.src), '{"channels":{}}\n');
    const personal = '{"channels":{"#private":"admin"}}\n';
    writeFileSync(path.join(ws, seed.dest), personal);

    const result = mergeManaged(tk, tk, ws, undefined, { force: true });

    assert.deepEqual(result.seeded, []);
    assert.equal(readFileSync(path.join(ws, seed.dest), "utf8"), personal);
    assert.ok(!existsSync(path.join(ws, `${seed.dest}.aios-incoming`)));
    assert.ok(!existsSync(path.join(ws, `${seed.dest}.aios-merge`)));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- dir-entry `exclude` (AIO-351 dogfood: .claude/rules/access-control.md) ----

test("mergeManaged: an excluded dir-entry file is never overlaid and never conflicts", () => {
  const rulesEntry = MANAGED_PATHS.find((e) => e.dest === ".claude/rules");
  assert.ok(rulesEntry?.exclude?.includes("access-control.md"), "sanity: exclude is configured");

  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-excl-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-excl-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  try {
    // Toolkit at base: a synced file + the excluded, stamp-templated one.
    mkdirSync(path.join(tk, "scaffold/.claude/rules"), { recursive: true });
    writeFileSync(path.join(tk, "scaffold/.claude/rules/synced.md"), "V1\n");
    writeFileSync(path.join(tk, "scaffold/.claude/rules/access-control.md"), "TEMPLATE v1\n");
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // Workspace: synced.md as-shipped; access-control.md personalized at scaffold time
    // (never came from a sync, so there's no matching baseline in the workspace copy).
    mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
    writeFileSync(path.join(ws, ".claude/rules/synced.md"), "V1\n");
    writeFileSync(path.join(ws, ".claude/rules/access-control.md"), "PERSONALIZED tier table\n");

    // Toolkit evolves both files upstream.
    writeFileSync(path.join(tk, "scaffold/.claude/rules/synced.md"), "V2\n");
    writeFileSync(path.join(tk, "scaffold/.claude/rules/access-control.md"), "TEMPLATE v2\n");
    git("add", "-A");
    git("commit", "-qm", "head");

    const r = mergeManaged(tk, tk, ws, baseSha, {});

    // The excluded file is untouched — no overlay, no conflict, no sidecar files.
    assert.equal(
      readFileSync(path.join(ws, ".claude/rules/access-control.md"), "utf8"),
      "PERSONALIZED tier table\n"
    );
    assert.ok(!r.conflicts.some((c) => c.path === ".claude/rules/access-control.md"));
    assert.ok(!r.updated.includes(".claude/rules/access-control.md"));
    assert.ok(!r.created.includes(".claude/rules/access-control.md"));
    assert.ok(!r.deleted.includes(".claude/rules/access-control.md"));
    assert.ok(!existsSync(path.join(ws, ".claude/rules/access-control.md.aios-incoming")));
    assert.ok(!existsSync(path.join(ws, ".claude/rules/access-control.md.aios-merge")));

    // Meanwhile the non-excluded sibling in the same dir entry syncs normally.
    assert.ok(r.updated.includes(".claude/rules/synced.md"));
    assert.equal(readFileSync(path.join(ws, ".claude/rules/synced.md"), "utf8"), "V2\n");
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged: an excluded file present at the base sha is not propagated as deleted", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-excl-del-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-excl-del-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  try {
    mkdirSync(path.join(tk, "scaffold/.claude/rules"), { recursive: true });
    writeFileSync(path.join(tk, "scaffold/.claude/rules/access-control.md"), "TEMPLATE v1\n");
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
    writeFileSync(path.join(ws, ".claude/rules/access-control.md"), "PERSONALIZED\n");

    // Toolkit later removes its own template copy — should still never delete the
    // workspace's personalized file, because it was never synced in the first place.
    rmSync(path.join(tk, "scaffold/.claude/rules/access-control.md"));
    git("add", "-A");
    git("commit", "-qm", "head");

    const r = mergeManaged(tk, tk, ws, baseSha, {});
    assert.ok(existsSync(path.join(ws, ".claude/rules/access-control.md")));
    assert.ok(!r.deleted.includes(".claude/rules/access-control.md"));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
