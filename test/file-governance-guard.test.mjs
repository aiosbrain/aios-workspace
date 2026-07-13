// test/file-governance-guard.test.mjs — unit tests for the AIO-352 layer-1 hook's
// pure decision logic (path classification + frontmatter structural detection). The
// PreToolUse stdin/stdout wiring is exercised separately as a child-process smoke test
// below; the bulk of the coverage targets the exported pure functions directly since
// that's the logic the layer-2 validator (OGR14) also imports and must never drift
// from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPath,
  checkFrontmatter,
  isContentFile,
  isFrontmatterExempt,
} from "../hooks/file-governance-guard.mjs";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "file-governance-guard.mjs"
);

// ── classifyPath ────────────────────────────────────────────────────────────

test("classifyPath: allows every numbered spine dir (new + legacy)", () => {
  for (const p of [
    "0-context/scope.md",
    "1-inbox/note.md",
    "2-work/report.md",
    "3-log/decision-log.md",
    "4-shared/deck.md",
    "5-personal/scratch.md",
    "6-business/plan.md",
    "00-engagement/x.md",
    "01-intake/x.md",
    "02-deliverables/x.md",
    "03-status/x.md",
    "04-client-surface/x.md",
    "05-personal/alex/x.md",
  ]) {
    assert.equal(classifyPath(p).allowed, true, `expected ${p} to be allowed`);
  }
});

test("classifyPath: allows the toolkit dirs and .claude/", () => {
  for (const p of [
    ".claude/skills/foo/SKILL.md",
    "scripts/aios.mjs",
    "hooks/team-ops-guard.sh",
    "validation/check-structure.sh",
    "bin/aios",
  ]) {
    assert.equal(classifyPath(p).allowed, true, `expected ${p} to be allowed`);
  }
});

test("classifyPath: allows dotfiles and known root files at the top level", () => {
  for (const p of [
    ".env",
    ".envrc",
    ".gitignore",
    "README.md",
    "AGENTS.md",
    "aios.yaml",
    "package.json",
  ]) {
    assert.equal(classifyPath(p).allowed, true, `expected ${p} to be allowed`);
  }
});

test("classifyPath: rejects a new ad-hoc top-level directory", () => {
  const result = classifyPath("scratch-notes/idea.md");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not a sanctioned top-level directory/);
});

test("classifyPath: rejects a new ad-hoc top-level file", () => {
  const result = classifyPath("random-notes.md");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not a recognized root file/);
});

test("classifyPath: nested files inside a sanctioned dir are allowed regardless of depth", () => {
  assert.equal(classifyPath("2-work/sprint-1/deep/nested/report.md").allowed, true);
});

// ── checkFrontmatter ─────────────────────────────────────────────────────────

test("checkFrontmatter: detects a well-formed block with a tier field", () => {
  const content = "---\nstatus: draft\nowner: alex\n---\n# Title\n";
  const result = checkFrontmatter(content);
  assert.deepEqual(result, { hasBlock: true, hasTierField: true });
});

test("checkFrontmatter: detects a block with only access:", () => {
  const content = "---\naccess: team\n---\nbody\n";
  assert.deepEqual(checkFrontmatter(content), { hasBlock: true, hasTierField: true });
});

test("checkFrontmatter: block present but no tier field", () => {
  const content = "---\ntype: index\n---\nbody\n";
  assert.deepEqual(checkFrontmatter(content), { hasBlock: true, hasTierField: false });
});

test("checkFrontmatter: no frontmatter at all", () => {
  assert.deepEqual(checkFrontmatter("# Just a heading\nsome text"), {
    hasBlock: false,
    hasTierField: false,
  });
});

test("checkFrontmatter: unclosed frontmatter block does not count", () => {
  const content = "---\nstatus: draft\n# no closing fence\nmore text";
  assert.deepEqual(checkFrontmatter(content), { hasBlock: false, hasTierField: false });
});

test("checkFrontmatter: tolerates leading blank lines before the opening fence", () => {
  const content = "\n\n---\nstatus: draft\n---\nbody";
  assert.deepEqual(checkFrontmatter(content), { hasBlock: true, hasTierField: true });
});

test("checkFrontmatter: empty content", () => {
  assert.deepEqual(checkFrontmatter(""), { hasBlock: false, hasTierField: false });
});

// ── isContentFile / isFrontmatterExempt ──────────────────────────────────────

test("isContentFile: matches .md and .mdx, not other extensions", () => {
  assert.equal(isContentFile("a/b.md"), true);
  assert.equal(isContentFile("a/b.mdx"), true);
  assert.equal(isContentFile("a/b.txt"), false);
  assert.equal(isContentFile("a/b"), false);
});

test("isFrontmatterExempt: known living docs are exempt", () => {
  for (const name of [
    "README.md",
    "CLAUDE.md",
    "decision-log.md",
    "tasks.md",
    "index.md",
    "hours-log-2026.md",
  ]) {
    assert.equal(isFrontmatterExempt(name), true, `expected ${name} exempt`);
  }
  assert.equal(isFrontmatterExempt("report.md"), false);
});

// ── PreToolUse wiring smoke test (child process, real stdin/stdout contract) ────

function runHook(payload, cwd) {
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("hook: warns (exit 0) on a new file outside the spine with no frontmatter", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-hook-"));
  try {
    const result = runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: "random-notes.md", content: "no frontmatter here" },
      },
      dir
    );
    assert.equal(result.code, 0);
    assert.match(result.stderr, /WARN: random-notes\.md/);
    assert.match(result.stderr, /not a recognized root file/);
    assert.match(result.stderr, /missing YAML frontmatter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: silent allow for a well-formed new file inside the spine", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-hook-"));
  try {
    const result = runHook(
      {
        tool_name: "Write",
        tool_input: {
          file_path: "2-work/report.md",
          content: "---\nstatus: draft\nowner: alex\n---\n# Report\n",
        },
      },
      dir
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: escalates to BLOCK (exit 2) when .aios/file-governance.json sets mode: block", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-hook-"));
  try {
    const aiosDir = path.join(dir, ".aios");
    mkdirSync(aiosDir, { recursive: true });
    writeFileSync(path.join(aiosDir, "file-governance.json"), JSON.stringify({ mode: "block" }));
    const result = runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: "random-notes.md", content: "no frontmatter" },
      },
      dir
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /BLOCKED: random-notes\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: Edit on an existing file is never treated as a new-file creation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-hook-"));
  try {
    writeFileSync(path.join(dir, "random-notes.md"), "pre-existing content");
    const result = runHook(
      {
        tool_name: "Edit",
        tool_input: { file_path: "random-notes.md", old_string: "a", new_string: "b" },
      },
      dir
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: Write overwriting an existing file is not new-file governance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-hook-"));
  try {
    writeFileSync(path.join(dir, "random-notes.md"), "pre-existing content");
    const result = runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: "random-notes.md", content: "replaced, still no frontmatter" },
      },
      dir
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: fails open on garbage stdin", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-hook-"));
  try {
    const res = spawnSync("node", [HOOK], { input: "not json{{{", cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
