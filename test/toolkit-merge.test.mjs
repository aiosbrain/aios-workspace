import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { MANAGED_PATHS } from "../scripts/toolkit-manifest.mjs";
import { decideMerge, threeWayMerge } from "../scripts/toolkit-merge.mjs";
import { mergeManaged } from "../scripts/update.mjs";

// ---- pure decision table -------------------------------------------------

test("decideMerge covers every case", () => {
  assert.equal(decideMerge({ base: "a", mine: "a", theirs: "a" }), "noop");
  assert.equal(decideMerge({ base: "a", mine: "x", theirs: "x" }), "noop"); // both match
  assert.equal(decideMerge({ base: undefined, mine: undefined, theirs: "t" }), "create");
  assert.equal(decideMerge({ base: undefined, mine: "m", theirs: "t" }), "fallback");
  assert.equal(decideMerge({ base: "a", mine: "a", theirs: "t" }), "take-theirs"); // clean update
  assert.equal(decideMerge({ base: "a", mine: "m", theirs: "a" }), "keep-mine"); // local-only edit
  assert.equal(decideMerge({ base: "a", mine: "m", theirs: "t" }), "merge"); // both changed
});

// ---- git merge-file wrapper ---------------------------------------------

test("threeWayMerge combines non-overlapping edits cleanly", () => {
  const base = "line1\nline2\nline3\n";
  const mine = "line1-mine\nline2\nline3\n";
  const theirs = "line1\nline2\nline3\nline4-theirs\n";
  const { clean, content } = threeWayMerge(base, mine, theirs);
  assert.equal(clean, true);
  assert.equal(content, "line1-mine\nline2\nline3\nline4-theirs\n");
});

test("threeWayMerge reports a conflict on the same line (with markers)", () => {
  const base = "value = 1\n";
  const mine = "value = MINE\n";
  const theirs = "value = THEIRS\n";
  const { clean, content } = threeWayMerge(base, mine, theirs);
  assert.equal(clean, false);
  assert.match(content, /<<<<<<</);
  assert.match(content, /MINE/);
  assert.match(content, /THEIRS/);
});

// ---- mergeManaged end-to-end over a real git toolkit --------------------

/** Build a git toolkit covering every managed src; return its base sha. */
function gitToolkit(root) {
  for (const e of MANAGED_PATHS) {
    const src = path.join(root, e.src);
    if (e.kind === "dir") {
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, "toolkit-file.md"), "V1\n");
    } else {
      mkdirSync(path.dirname(src), { recursive: true });
      writeFileSync(src, "V1\n");
    }
  }
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");
  return git("rev-parse", "HEAD").trim();
}

test("mergeManaged: merges local edits, surfaces conflicts, propagates clean deletions", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-git-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-git-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  try {
    gitToolkit(tk); // generic V1 everywhere

    // Set intended BASE content, then capture that as the merge base.
    const secret = path.join(tk, "validation/secret-patterns.txt");
    const rulesFile = path.join(tk, "scaffold/.claude/rules/toolkit-file.md");
    writeFileSync(secret, "L1\nL2\nL3\n");
    writeFileSync(rulesFile, "shared line = BASE\n");
    git("add", "-A");
    git("commit", "-qm", "base-content");
    const baseSha = git("rev-parse", "HEAD").trim();

    // Workspace starts as an exact copy of the toolkit at base (so nothing is "created").
    for (const e of MANAGED_PATHS) {
      cpSync(path.join(tk, e.src), path.join(ws, e.dest), { recursive: true });
    }

    // --- toolkit evolves (head) ---
    writeFileSync(secret, "L1\nL2\nL3\nL4-theirs\n"); // (1) append — non-overlap with the ws edit
    writeFileSync(rulesFile, "shared line = TOOLKIT\n"); // (2) same line the ws edits → CONFLICT
    writeFileSync(path.join(tk, "scaffold/.claude/rules/new-rule.md"), "NEW\n"); // (3) CREATE
    rmSync(path.join(tk, "scaffold/.claude/skills/toolkit-file.md")); // (4) DELETE propagation
    git("add", "-A");
    git("commit", "-qm", "head");

    // Workspace-side local edits (working tree; empty dirty set = treated as committed).
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "L1-mine\nL2\nL3\n"); // top edit
    writeFileSync(path.join(ws, ".claude/rules/toolkit-file.md"), "shared line = MINE\n"); // same line

    const r = mergeManaged(tk, tk, ws, baseSha, {});

    // (1) clean 3-way merge: ws top edit + toolkit appended line, both preserved.
    assert.ok(r.merged.includes("validation/secret-patterns.txt"));
    assert.equal(
      readFileSync(path.join(ws, "validation/secret-patterns.txt"), "utf8"),
      "L1-mine\nL2\nL3\nL4-theirs\n"
    );
    // (2) conflict: live file untouched, sidecars written.
    assert.ok(
      r.conflicts.some((c) => c.path === ".claude/rules/toolkit-file.md" && c.kind === "merge")
    );
    assert.equal(
      readFileSync(path.join(ws, ".claude/rules/toolkit-file.md"), "utf8"),
      "shared line = MINE\n"
    );
    assert.ok(existsSync(path.join(ws, ".claude/rules/toolkit-file.md.aios-incoming")));
    assert.ok(existsSync(path.join(ws, ".claude/rules/toolkit-file.md.aios-merge")));
    // (3) created.
    assert.ok(r.created.includes(".claude/rules/new-rule.md"));
    assert.ok(existsSync(path.join(ws, ".claude/rules/new-rule.md")));
    // (4) deletion propagated (workspace copy was untouched).
    assert.ok(r.deleted.includes(".claude/skills/toolkit-file.md"));
    assert.ok(!existsSync(path.join(ws, ".claude/skills/toolkit-file.md")));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged: --force overwrites and does not conflict", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-f-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-f-"));
  try {
    const baseSha = gitToolkit(tk);
    for (const e of MANAGED_PATHS) {
      cpSync(path.join(tk, e.src), path.join(ws, e.dest), { recursive: true });
    }
    // Local edit that would normally conflict.
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "LOCAL\n");
    const r = mergeManaged(tk, tk, ws, baseSha, { force: true });
    assert.equal(r.conflicts.length, 0);
    assert.equal(readFileSync(path.join(ws, "validation/secret-patterns.txt"), "utf8"), "V1\n");
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged: uncommitted (dirty) files are skipped, never merged", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-d-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-d-"));
  try {
    const baseSha = gitToolkit(tk);
    for (const e of MANAGED_PATHS) {
      cpSync(path.join(tk, e.src), path.join(ws, e.dest), { recursive: true });
    }
    // Toolkit moves on; the workspace has an UNCOMMITTED local edit to the same file.
    writeFileSync(path.join(tk, "validation/secret-patterns.txt"), "V2\n");
    execFileSync("git", ["-C", tk, "add", "-A"]);
    execFileSync("git", ["-C", tk, "commit", "-qm", "head"]);
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "MY UNCOMMITTED\n");

    const r = mergeManaged(tk, tk, ws, baseSha, {
      dirty: new Set(["validation/secret-patterns.txt"]),
    });
    assert.ok(r.skippedDirty.includes("validation/secret-patterns.txt"));
    assert.equal(
      readFileSync(path.join(ws, "validation/secret-patterns.txt"), "utf8"),
      "MY UNCOMMITTED\n"
    );
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged: preview classifies changes without writing live files or sidecars", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-preview-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-preview-"));
  try {
    const baseSha = gitToolkit(tk);
    for (const e of MANAGED_PATHS) {
      cpSync(path.join(tk, e.src), path.join(ws, e.dest), { recursive: true });
    }
    const target = path.join(ws, "validation/secret-patterns.txt");
    writeFileSync(target, "LOCAL\n");
    writeFileSync(path.join(tk, "validation/secret-patterns.txt"), "TOOLKIT\n");
    execFileSync("git", ["-C", tk, "add", "-A"]);
    execFileSync("git", ["-C", tk, "commit", "-qm", "head"]);

    const before = readFileSync(target, "utf8");
    const r = mergeManaged(tk, tk, ws, baseSha, { dryRun: true });

    assert.ok(r.conflicts.some((item) => item.path === "validation/secret-patterns.txt"));
    assert.equal(readFileSync(target, "utf8"), before);
    assert.equal(existsSync(`${target}.aios-incoming`), false);
    assert.equal(existsSync(`${target}.aios-merge`), false);
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
