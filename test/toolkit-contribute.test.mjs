import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  contributeTarget,
  contributeBranch,
  cmdContribute,
} from "../scripts/toolkit-contribute.mjs";

test("contributeTarget maps a managed file entry to its toolkit src", () => {
  const t = contributeTarget("validation/secret-patterns.txt");
  assert.equal(t.srcRel, "validation/secret-patterns.txt");
  assert.equal(t.destRel, "validation/secret-patterns.txt");
});

test("contributeTarget maps a file inside a managed dir entry", () => {
  const t = contributeTarget(".claude/descriptors/granola.json");
  assert.equal(t.destRel, ".claude/descriptors/granola.json");
  assert.equal(t.srcRel, "scaffold/.claude/descriptors/granola.json");
});

test("contributeTarget strips .aios-incoming / .aios-merge sidecar suffixes", () => {
  assert.equal(
    contributeTarget(".claude/rules/git-workflow.md.aios-incoming").destRel,
    ".claude/rules/git-workflow.md"
  );
  assert.equal(
    contributeTarget(".claude/rules/git-workflow.md.aios-merge").srcRel,
    "scaffold/.claude/rules/git-workflow.md"
  );
});

test("contributeTarget returns null for a non-managed (personal) path", () => {
  assert.equal(contributeTarget("2-work/report.md"), null);
  assert.equal(contributeTarget(".claude/memory/USER.md"), null);
});

test("contributeBranch is a safe, deterministic, content-disambiguated slug", () => {
  const b1 = contributeBranch(".claude/descriptors/granola.json", "A");
  const b2 = contributeBranch(".claude/descriptors/granola.json", "B");
  assert.match(b1, /^contribute\/[a-z0-9-]+-[0-9a-f]{1,8}$/);
  assert.notEqual(b1, b2); // different content → different branch
  assert.equal(b1, contributeBranch(".claude/descriptors/granola.json", "A")); // deterministic
});

test("cmdContribute --dry-run prints the plan and writes nothing", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aios-contrib-"));
  try {
    mkdirSync(path.join(ws, "validation"), { recursive: true });
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "my tightened patterns\n");
    const plan = await cmdContribute(
      ws,
      { dir: "/tmp/whatever-toolkit", ephemeral: true },
      ["--contribute", "validation/secret-patterns.txt", "--dry-run"],
      "validation/secret-patterns.txt"
    );
    assert.equal(plan.file, "validation/secret-patterns.txt");
    assert.equal(plan.toolkitPath, "validation/secret-patterns.txt");
    assert.match(plan.branch, /^contribute\//);
    assert.equal(plan.url, undefined); // dry-run: no PR
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
