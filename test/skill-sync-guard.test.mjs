// test/skill-sync-guard.test.mjs — OGR17: skills present in BOTH trees must not drift.
//
// The overlap between `.claude/skills/` (dev-facing) and `scaffold/.claude/skills/` (shipped) is
// small and mostly disjoint BY DESIGN. When this guard was written the overlap was two skills and
// one was already drifted — the clean one clean only because someone hand-copied it while working
// on something else. AIO-942 records three drifted copies accumulating the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = path.join(ROOT, "validation", "check-skill-sync.mjs");

function run(repo) {
  try {
    return { code: 0, out: execFileSync("node", [CHECK, repo], { encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

/** A throwaway repo with both trees and one skill in each, so we control the overlap exactly. */
function fixture({ devBody, shipBody, extra }) {
  const repo = mkdtempSync(path.join(tmpdir(), "skill-sync-"));
  const dev = path.join(repo, ".claude", "skills", "shared");
  const ship = path.join(repo, "scaffold", ".claude", "skills", "shared");
  mkdirSync(dev, { recursive: true });
  mkdirSync(ship, { recursive: true });
  writeFileSync(path.join(dev, "SKILL.md"), devBody);
  writeFileSync(path.join(ship, "SKILL.md"), shipBody);
  // A dev-only skill that must be ignored — the trees are deliberately not identical.
  mkdirSync(path.join(repo, ".claude", "skills", "dev-only"), { recursive: true });
  writeFileSync(path.join(repo, ".claude", "skills", "dev-only", "SKILL.md"), "# dev only\n");
  if (extra) extra(dev, ship);
  return repo;
}

test("identical shared skills pass, and non-shared skills are ignored", () => {
  const repo = fixture({ devBody: "# same\n", shipBody: "# same\n" });
  try {
    const { code, out } = run(repo);
    assert.equal(code, 0, out);
    assert.match(out, /OGR17 PASSED/);
    assert.doesNotMatch(out, /dev-only/, "a skill in only one tree must never be reported");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a drifted shared skill fails and names the file", () => {
  const repo = fixture({ devBody: "# one\nalpha\n", shipBody: "# one\nbeta\n" });
  try {
    const { code, out } = run(repo);
    assert.equal(code, 1);
    assert.match(out, /shared\/SKILL\.md/, "the guard must name the differing file, not just report drift");
    assert.match(out, /changed line/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("generated artifacts never decide the verdict", () => {
  const repo = fixture({
    devBody: "# same\n",
    shipBody: "# same\n",
    extra: (dev) => {
      mkdirSync(path.join(dev, "scripts", "__pycache__"), { recursive: true });
      writeFileSync(path.join(dev, "scripts", "__pycache__", "x.pyc"), "junk");
    },
  });
  try {
    const { code, out } = run(repo);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /__pycache__/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("this repo's own shared skills are in sync", () => {
  const { code, out } = run(ROOT);
  assert.equal(code, 0, out);
});
