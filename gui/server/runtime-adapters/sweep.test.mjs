// Tests for the shared post-turn guard sweep (used by every native runtime:
// ACP in-process writes, Codex apply_patch/shell, OpenCode).
//
// Run: node --test gui/server/runtime-adapters/sweep.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { postTurnSweep } from "./sweep.mjs";

// Stub guard: flags any content containing SECRET (stands in for team-ops-guard.sh).
const stubGuard = ({ path: p, content }) =>
  /SECRET/.test(content) ? { ok: false, reason: "secret detected" } : { ok: true, path: p };

test("post-turn sweep flags a secret written this turn, ignores clean + pre-existing", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sweep-"));
  const old = Date.now() - 60_000;
  const sinceMs = Date.now() - 5_000; // turn started 5s ago

  // pre-existing file with a secret but an OLD mtime → must be ignored
  writeFileSync(path.join(repo, "pre-existing.md"), "AKIA-ish SECRET here");
  utimesSync(path.join(repo, "pre-existing.md"), new Date(old), new Date(old));

  // changed-this-turn: one clean, one with a secret
  writeFileSync(path.join(repo, "clean.md"), "nothing to see");
  writeFileSync(path.join(repo, "leak.md"), "oops a SECRET landed via shell");

  const { violations, truncated } = await postTurnSweep(repo, stubGuard, sinceMs);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "leak.md");
  assert.match(violations[0].reason, /secret/);
  assert.equal(truncated, false);
});

test("post-turn sweep skips node_modules/.git and non-text files", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sweep-skip-"));
  mkdirSync(path.join(repo, "node_modules"));
  writeFileSync(path.join(repo, "node_modules", "x.js"), "SECRET in a dep");
  writeFileSync(path.join(repo, "image.png"), "SECRET-but-binary-ext");
  const { violations } = await postTurnSweep(repo, stubGuard, Date.now() - 5_000);
  assert.deepEqual(violations, []);
});

test("post-turn sweep FAILS LOUD (truncated=true) when the file cap is hit", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sweep-cap-"));
  // more guard-relevant files than the cap → walk must report truncation
  for (let i = 0; i < 5; i++) writeFileSync(path.join(repo, `f${i}.md`), "clean");
  const { truncated } = await postTurnSweep(repo, stubGuard, Date.now() - 5_000, 2);
  assert.equal(truncated, true);
});
