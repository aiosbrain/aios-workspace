// Contract test (Codex #3): feed canned ACP session/update notifications through
// the ACP adapter's mapping and assert it emits the EXACT WS field shapes the
// React client consumes (delta | tool_use | tool_result), so the adapter can't
// drift from the client contract without this failing.
//
// Run: node --test gui/server/runtime-adapters/acp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapSessionUpdate, postTurnSweep } from "./acp.mjs";

test("agent_message_chunk (text) → delta{text}", () => {
  const out = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } });
  assert.deepEqual(out, [{ type: "delta", text: "hello " }]);
});

test("non-text agent_message_chunk → nothing", () => {
  const out = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "..." } });
  assert.deepEqual(out, []);
});

test("agent_thought_chunk → nothing (no UI channel)", () => {
  const out = mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  assert.deepEqual(out, []);
});

test("tool_call → assistant_done then tool_use{name,input,id}", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc_1",
    title: "Write file",
    kind: "edit",
    rawInput: { path: "a.md", content: "x" },
  });
  assert.deepEqual(out, [
    { type: "assistant_done" },
    { type: "tool_use", name: "Write file", input: { path: "a.md", content: "x" }, id: "tc_1" },
  ]);
});

test("tool_call without title/rawInput falls back to kind + {}", () => {
  const out = mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "tc_2", kind: "read" });
  assert.equal(out[1].name, "read");
  assert.deepEqual(out[1].input, {});
  assert.equal(out[1].id, "tc_2");
});

test("tool_call_update completed → tool_result with extracted text, is_error false", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "done" } }],
  });
  assert.equal(out.length, 1);
  const ev = out[0];
  assert.equal(ev.type, "tool_result");
  assert.equal(ev.id, "tc_1");
  assert.equal(ev.text, "done");
  assert.equal(ev.is_error, false);
  assert.equal(typeof ev.is_error, "boolean"); // client contract: is_error is a boolean
});

test("tool_call_update failed → tool_result is_error true", () => {
  const out = mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc_3", status: "failed", content: [] });
  assert.equal(out[0].is_error, true);
});

test("tool_call_update in_progress → nothing (not terminal)", () => {
  const out = mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "in_progress" });
  assert.deepEqual(out, []);
});

test("tool_call_update extracts diff content", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_4",
    status: "completed",
    content: [{ type: "diff", path: "a.md", newText: "new body" }],
  });
  assert.equal(out[0].text, "new body");
});

test("unknown / unhandled updates → nothing", () => {
  for (const u of ["plan", "current_mode_update", "usage_update", "available_commands_update"]) {
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: u }), []);
  }
  assert.deepEqual(mapSessionUpdate(null), []);
  assert.deepEqual(mapSessionUpdate("nope"), []);
});

// ── post-turn sweep (catches in-process / shell-driven writes) ────────────────

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
  const { mkdirSync } = await import("node:fs");
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
