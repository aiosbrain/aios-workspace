// AIO-927 — byte-parity gate for the two canonical aios-linear skill copies
// (scripts/check-linear-skill-parity.mjs). Runs the real gate against a synthetic
// tree in a temp cwd (mirrors test/check-boundaries.test.mjs), proving it
// (a) passes when the copies are byte-identical, (b) fails naming the path when
// file CONTENT differs, (c) fails naming the path when a file is PRESENT in one
// copy and MISSING from the other (both directions, including a newly added
// file — the mode the old hardcoded 3-file check could not see), and
// (d) passes on THIS repo's actual tree, where parity is a live invariant.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-linear-skill-parity.mjs");

const COPY_A = path.join(".claude", "skills", "aios-linear");
const COPY_B = path.join("scaffold", ".claude", "skills", "aios-linear");

function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "linear-skill-parity-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// run(cwd) → { status, stdout, stderr } from the real script.
function run(cwd) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const IDENTICAL = {
  [path.join(COPY_A, "SKILL.md")]: "# skill\n",
  [path.join(COPY_A, "linear.mjs")]: "console.log('cli');\n",
  [path.join(COPY_B, "SKILL.md")]: "# skill\n",
  [path.join(COPY_B, "linear.mjs")]: "console.log('cli');\n",
};

test("passes when the two copies are byte-identical", () => {
  const root = makeTree(IDENTICAL);
  try {
    const { status, stdout } = run(root);
    assert.equal(status, 0);
    assert.match(stdout, /byte-identical \(2 files\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails naming the path when file content differs", () => {
  const root = makeTree({
    ...IDENTICAL,
    [path.join(COPY_B, "linear.mjs")]: "console.log('cli'); // drifted\n",
  });
  try {
    const { status, stderr } = run(root);
    assert.equal(status, 1);
    assert.match(stderr, /content differs: .*linear\.mjs/);
    assert.ok(stderr.includes(path.join(COPY_B, "linear.mjs")), "names the offending path");
    assert.match(stderr, /must stay byte-identical/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails naming the path when a file is missing from one copy", () => {
  const root = makeTree(IDENTICAL);
  try {
    unlinkSync(path.join(root, COPY_A, "linear.mjs"));
    const { status, stderr } = run(root);
    assert.equal(status, 1);
    assert.ok(
      stderr.includes(`${path.join(COPY_A, "linear.mjs")} is missing`),
      `names the missing path, got:\n${stderr}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a file is added to only one copy (new-file drift)", () => {
  const root = makeTree({
    ...IDENTICAL,
    [path.join(COPY_B, "linear-new-helper.mjs")]: "export {};\n",
  });
  try {
    const { status, stderr } = run(root);
    assert.equal(status, 1);
    assert.ok(
      stderr.includes(`${path.join(COPY_A, "linear-new-helper.mjs")} is missing`),
      `names the missing counterpart, got:\n${stderr}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes on this repo's actual tree", () => {
  const { status, stdout } = run(ROOT);
  assert.equal(status, 0, `parity gate should be green on the real repo:\n${stdout}`);
});
