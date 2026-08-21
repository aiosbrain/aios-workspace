// AIO-927 — thin parity gate for the two canonical aios-linear skill copies
// (scripts/check-linear-skill-parity.mjs). The file-for-file comparison itself is
// OGR17 (validation/check-skill-sync.mjs), whose behavior is already pinned by
// test/skill-sync-guard.test.mjs — those cases are deliberately NOT re-tested here.
// This test pins what the thin gate ADDS:
//   (a) whole-dir deletion of either copy fails naming the path — the one case
//       OGR17's intersection-only design is blind to;
//   (b) drift found by OGR17 actually propagates through the gate (delegation is
//       wired, exit code surfaces);
//   (c) a clean synthetic tree passes; and
//   (d) THIS repo's actual tree passes, where parity is a live invariant.
// Runs the real script against synthetic trees via its argv[2] root override
// (mirrors test/check-boundaries.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-linear-skill-parity.mjs");

const COPY_SCAFFOLD = path.join("scaffold", ".claude", "skills", "aios-linear");
const COPY_DEV = path.join(".claude", "skills", "aios-linear");

function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "linear-skill-parity-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// run(repoRoot) → { status, output } from the real script (argv[2] = root override).
function run(repoRoot) {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, repoRoot], { encoding: "utf8" });
    return { status: 0, output };
  } catch (err) {
    return { status: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const IDENTICAL = {
  [path.join(COPY_SCAFFOLD, "SKILL.md")]: "# skill\n",
  [path.join(COPY_SCAFFOLD, "linear.mjs")]: "console.log('cli');\n",
  [path.join(COPY_DEV, "SKILL.md")]: "# skill\n",
  [path.join(COPY_DEV, "linear.mjs")]: "console.log('cli');\n",
};

test("passes on a clean synthetic tree with both copies identical", () => {
  const root = makeTree(IDENTICAL);
  try {
    const { status, output } = run(root);
    assert.equal(status, 0, output);
    assert.match(output, /byte-identical/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const gone of [COPY_SCAFFOLD, COPY_DEV]) {
  test(`fails naming the path when ${gone} is deleted entirely (OGR17's intersection blind spot)`, () => {
    const root = makeTree(IDENTICAL);
    try {
      rmSync(path.join(root, gone), { recursive: true, force: true });
      const { status, output } = run(root);
      assert.equal(status, 1);
      assert.ok(output.includes(`${gone}/ is missing entirely`), `names the path, got:\n${output}`);
      assert.match(output, /must stay byte-identical/);
      assert.match(output, /trust the scaffold\/ side/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("drift detected by OGR17 propagates through the gate (delegation wired)", () => {
  const root = makeTree({
    ...IDENTICAL,
    [path.join(COPY_DEV, "linear.mjs")]: "console.log('cli'); // drifted\n",
  });
  try {
    const { status, output } = run(root);
    assert.equal(status, 1);
    assert.match(output, /aios-linear\/linear\.mjs/); // OGR17 names the file
    assert.match(output, /OGR17 reported drift/); // the gate surfaced it, not swallowed it
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes on this repo's actual tree", () => {
  const { status, output } = run(ROOT);
  assert.equal(status, 0, `parity gate should be green on the real repo:\n${output}`);
});
