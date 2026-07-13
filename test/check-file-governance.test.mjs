// test/check-file-governance.test.mjs — unit tests for OGR14
// (validation/check-file-governance.mjs), the layer-2 anti-sprawl ratchet (AIO-352).
// Runs the validator script as a child process against synthetic tmp workspaces so
// the test exercises the real CLI contract (argv, exit code, stdout) validate-all.sh
// depends on — same pattern as check-scaffold-guard.mjs's own coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALIDATOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "validation",
  "check-file-governance.mjs"
);

function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "aio352-ogr14-"));
  for (const d of [
    "0-context",
    "1-inbox",
    "2-work",
    "3-log",
    "4-shared",
    "5-personal",
    ".claude",
  ]) {
    mkdirSync(path.join(dir, d), { recursive: true });
  }
  return dir;
}

function runValidator(repo) {
  const res = spawnSync("node", [VALIDATOR, repo], { encoding: "utf8" });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("OGR14: exits 0 and clean on a well-formed workspace", () => {
  const dir = makeWorkspace();
  try {
    writeFileSync(
      path.join(dir, "2-work", "report.md"),
      "---\nstatus: draft\nowner: alex\n---\n# Report\nbody text\nmore body\n"
    );
    const result = runValidator(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /OGR14 PASSED — no sprawl detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR14: warns (still exits 0 — advisory ratchet) on a rogue top-level dir", () => {
  const dir = makeWorkspace();
  try {
    mkdirSync(path.join(dir, "random-scratch"));
    writeFileSync(path.join(dir, "random-scratch", "notes.md"), "# hi\nno frontmatter\nmore\n");
    const result = runValidator(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /random-scratch.*not a sanctioned top-level directory/s);
    assert.match(result.stdout, /PASSED with \d+ warning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR14: warns on a content file missing frontmatter", () => {
  const dir = makeWorkspace();
  try {
    writeFileSync(path.join(dir, "2-work", "no-fm.md"), "# Just a heading\nsome text\nmore text\n");
    const result = runValidator(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no-fm\.md — no frontmatter block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR14: warns on frontmatter present but missing a tier field", () => {
  const dir = makeWorkspace();
  try {
    writeFileSync(
      path.join(dir, "2-work", "partial-fm.md"),
      "---\ntype: note\n---\n# Title\nbody\nmore\n"
    );
    const result = runValidator(dir);
    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /partial-fm\.md — frontmatter present but missing status\/access field/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR14: does not flag .claude/ content (own frontmatter conventions)", () => {
  const dir = makeWorkspace();
  try {
    mkdirSync(path.join(dir, ".claude", "skills", "foo"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude", "skills", "foo", "SKILL.md"),
      "---\nname: foo\ndescription: does a thing\n---\n# Foo\nbody\nmore\n"
    );
    const result = runValidator(dir);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /SKILL\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR14: exempts known living docs (README, index.md, decision-log.md) from the frontmatter check", () => {
  const dir = makeWorkspace();
  try {
    writeFileSync(path.join(dir, "README.md"), "# Readme\nno frontmatter needed here\nmore text\n");
    writeFileSync(
      path.join(dir, "3-log", "decision-log.md"),
      "# Decisions\n\n| # | Date |\n|---|---|\n"
    );
    const result = runValidator(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Checked: 0 files \| Skipped: 2 files/);
    assert.doesNotMatch(result.stdout, /README\.md —/);
    assert.doesNotMatch(result.stdout, /decision-log\.md —/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR14: errors with usage when no repo arg is given", () => {
  const res = spawnSync("node", [VALIDATOR], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: check-file-governance\.mjs/);
});
