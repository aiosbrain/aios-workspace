// Maturity capture hook (AIO-227 / AM1) — spawns hooks/maturity-capture.mjs with realistic
// SessionEnd payloads + synthetic Claude transcript JSONL, then folds the hook-written store
// through foldSessions (plain source — no dist needed) to prove one folded record per session.
// Also unit-checks computeSessionRecord's per-session formulas directly.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldSessions, STORE_REL } from "../scripts/analyze/maturity-store.mjs";
import { computeSessionRecord } from "../scripts/analyze/metrics.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "maturity-capture.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "maturity-hook-"));
}

function runHook(dir, payload, { rawInput } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  try {
    execFileSync("node", [HOOK], {
      input,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

// Build a realistic Claude transcript: two human turns, each followed by an assistant turn that
// carries usage + tool_use blocks (Bash = verify tool, Read = diversity), plus tool_result turns
// including one error. `turns` controls how many prompt/assistant pairs (grows event_count).
function transcript(dir, { turns = 2 } = {}) {
  const p = path.join(dir, "transcript.jsonl");
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push({ type: "user", message: { role: "user", content: `do the thing ${i}` } });
    lines.push({
      type: "assistant",
      message: {
        role: "assistant",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 30,
        },
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", name: "Bash", input: {} },
          { type: "tool_use", name: "Read", input: {} },
        ],
      },
    });
    lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } });
    lines.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", is_error: true }] },
    });
  }
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const rawLineCount = (dir) => {
  const abs = path.join(dir, STORE_REL);
  if (!existsSync(abs)) return 0;
  return readFileSync(abs, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim()).length;
};
const fold = (dir) => foldSessions(readFileSync(path.join(dir, STORE_REL), "utf8"));

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/maturity-capture.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("SessionEnd over a synthetic transcript → exactly one folded admin-tier record", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, { turns: 2 });
    const code = runHook(dir, {
      hook_event_name: "SessionEnd",
      session_id: "sess-A",
      cwd: "/tmp/My Project",
      transcript_path: tp,
      reason: "clear",
    });
    assert.equal(code, 0);

    const { sessions, warnings } = fold(dir);
    assert.equal(warnings, 0, "hook lines fold cleanly with no warnings");
    assert.equal(sessions.size, 1);
    const s = sessions.get("sess-A");
    assert.ok(s, "record is keyed by session_id");
    assert.equal(s.tool, "claude");
    assert.equal(s.tier, "admin");
    assert.equal(s.project, "my-project"); // slugified cwd basename
    assert.equal(s.event_count, 12); // 2 turns × (user + assistant text + 2 tool_use + 2 tool_result)
    // signals present + bounded
    assert.equal(s.signals.tasks, 2);
    assert.equal(s.signals.tool_diversity, 2); // Bash + Read
    assert.ok(s.signals.verify_tool_rate >= 0 && s.signals.verify_tool_rate <= 1);
    assert.ok(s.signals.cache_hit_rate >= 0 && s.signals.cache_hit_rate <= 1);
    assert.ok(s.signals.total_tokens > 0);
    // counts carry raw numerators/denominators for downstream re-aggregation
    assert.equal(s.counts.tasks, 2);
    assert.equal(s.counts.tool_use_total, 4); // 2 Bash + 2 Read
    assert.equal(s.counts.verify_tool_uses, 2); // 2 Bash
    assert.equal(s.counts.tool_results, 4);
    assert.equal(s.counts.tool_result_errors, 2);
    assert.deepEqual([...s.counts.distinct_tools].sort(), ["Bash", "Read"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second SessionEnd, same session_id + more events → appends, folds to one (newer wins)", () => {
  const dir = ws();
  try {
    const tp1 = transcript(dir, { turns: 2 });
    runHook(dir, { hook_event_name: "SessionEnd", session_id: "sess-B", transcript_path: tp1 });
    const firstCount = fold(dir).sessions.get("sess-B").event_count;
    assert.equal(rawLineCount(dir), 1);

    // A longer transcript (more turns) → higher event_count → a new snapshot line.
    const tp2 = transcript(dir, { turns: 3 });
    runHook(dir, { hook_event_name: "SessionEnd", session_id: "sess-B", transcript_path: tp2 });
    assert.equal(rawLineCount(dir), 2, "a superseding snapshot appends a new line");

    const { sessions } = fold(dir);
    assert.equal(sessions.size, 1, "still one record per session_id");
    assert.ok(sessions.get("sess-B").event_count > firstCount, "newer snapshot wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("byte-identical re-fire (same session_id + same event_count) → no append", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, { turns: 2 });
    const payload = { hook_event_name: "SessionEnd", session_id: "sess-C", transcript_path: tp };
    runHook(dir, payload);
    runHook(dir, payload);
    assert.equal(rawLineCount(dir), 1, "idempotent re-fire writes nothing");
    assert.equal(fold(dir).sessions.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exits 0, writes nothing", () => {
  const dir = ws();
  try {
    assert.equal(runHook(dir, null, { rawInput: "not json at all {{{" }), 0);
    assert.equal(existsSync(path.join(dir, STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript → exits 0, writes nothing", () => {
  const dir = ws();
  try {
    const code = runHook(dir, {
      hook_event_name: "SessionEnd",
      session_id: "sess-D",
      transcript_path: path.join(dir, "does-not-exist.jsonl"),
    });
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(dir, STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-SessionEnd event → nothing", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, { turns: 1 });
    runHook(dir, { hook_event_name: "Stop", session_id: "sess-E", transcript_path: tp });
    assert.equal(existsSync(path.join(dir, STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-held STALE lock (mtime > 30s) → hook reclaims and writes", () => {
  const dir = ws();
  try {
    const abs = path.join(dir, STORE_REL);
    mkdirSync(path.dirname(abs), { recursive: true });
    const lockPath = abs + ".lock";
    writeFileSync(lockPath, "9999 stale-token 2000-01-01T00:00:00.000Z\n");
    const old = new Date(Date.now() - 60_000) / 1000; // 60s ago, in seconds
    utimesSync(lockPath, old, old);

    const tp = transcript(dir, { turns: 1 });
    const code = runHook(dir, {
      hook_event_name: "SessionEnd",
      session_id: "sess-F",
      transcript_path: tp,
    });
    assert.equal(code, 0);
    assert.equal(fold(dir).sessions.size, 1, "stale lock reclaimed; record written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeSessionRecord: per-session formulas + counts", () => {
  const tok = (o) => ({ in: 0, out: 0, cache_read: 0, cache_create: 0, ...o });
  const events = [
    { actor: "user", block_type: "text" }, // task 1
    {
      actor: "assistant",
      block_type: "text",
      tokens: tok({ in: 100, out: 50, cache_read: 200, cache_create: 30 }),
    },
    { actor: "assistant", block_type: "tool_use", tool_name: "Bash" }, // verify
    { actor: "assistant", block_type: "tool_use", tool_name: "Read" }, // diversity
    { actor: "user", block_type: "tool_result", is_error: false },
    { actor: "user", block_type: "tool_result", is_error: true },
    {
      actor: "subagent",
      block_type: "text",
      tokens: tok({ in: 10, out: 5, cache_read: 0, cache_create: 0 }),
    },
    { actor: "user", block_type: "mode" },
    { actor: "user", block_type: "permission" },
  ];
  const { signals, counts } = computeSessionRecord(events);

  // counts (raw)
  assert.equal(counts.tasks, 1);
  assert.equal(counts.in_tok, 110);
  assert.equal(counts.out_tok, 55);
  assert.equal(counts.cache_read_tok, 200);
  assert.equal(counts.cache_create_tok, 30);
  assert.equal(counts.subagent_tok, 15); // 10 + 5
  assert.equal(counts.tool_use_total, 2);
  assert.equal(counts.verify_tool_uses, 1);
  assert.equal(counts.tool_results, 2);
  assert.equal(counts.tool_result_errors, 1);
  assert.equal(counts.permission_events, 2); // mode + permission
  assert.deepEqual([...counts.distinct_tools].sort(), ["Bash", "Read"]);

  // signals (ratios) — verified against computeSignals formulas
  assert.equal(signals.tasks, 1);
  assert.equal(signals.total_tokens, 110 + 55 + 200 + 30);
  assert.equal(signals.verify_tool_rate, 1 / 2);
  assert.equal(signals.error_rate, 1 / 2);
  assert.equal(signals.cache_hit_rate, 200 / (200 + 110 + 30));
  assert.equal(signals.tool_diversity, 2);
  assert.equal(signals.subagent_usage, 1); // subagent tokens present
  assert.equal(signals.correction_loop_avg, 2 / 1);
  assert.equal(signals.tokens_per_task, (110 + 55 + 30) / 1); // work_tok = in+out+cache_create
  assert.equal(signals.permission_events, 2);
});

test("computeSessionRecord: empty events → zero-safe ratios", () => {
  const { signals, counts } = computeSessionRecord([]);
  assert.equal(counts.tasks, 0);
  assert.equal(signals.verify_tool_rate, 0);
  assert.equal(signals.cache_hit_rate, 0);
  assert.equal(signals.tokens_per_task, 0);
  assert.equal(signals.subagent_usage, 0);
  assert.deepEqual(counts.distinct_tools, []);
});
