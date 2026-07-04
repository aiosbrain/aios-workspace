// Maturity nudge hook (AIO-233 / AM3) — spawns hooks/maturity-nudge.mjs with synthetic
// UserPromptSubmit payloads over synthetic transcripts, and asserts the context-bloat detector
// fires the documented hookSpecificOutput exactly once per session plus a global cooldown floor.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "maturity-nudge.mjs");
const NUDGE_TEXT =
  "[maturity-nudge] This session is 40+ user turns long. If you're on a new task, a fresh " +
  "session (/clear) will be faster, cheaper, and less error-prone — long stale context is the " +
  "#1 drag on your Context-hygiene axis.";
const STATE_REL = path.join(".aios", "loop", "maturity", "nudge-state.json");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "maturity-nudge-"));
}

function userTextLine(sessionId) {
  return JSON.stringify({
    type: "user",
    sessionId,
    message: { role: "user", content: "do the thing" },
  });
}

function toolResultLine(sessionId) {
  return JSON.stringify({
    type: "user",
    sessionId,
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  });
}

function assistantLine(sessionId) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  });
}

// Build a transcript with `userTurns` genuine user prompts, each padded with a tool_result +
// assistant turn (the classification-parity fixture: tool_result records must NOT count).
function writeTranscript(dir, sessionId, userTurns) {
  const p = path.join(dir, "transcript.jsonl");
  const lines = [];
  for (let i = 0; i < userTurns; i++) {
    lines.push(userTextLine(sessionId));
    lines.push(assistantLine(sessionId));
    lines.push(toolResultLine(sessionId));
  }
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function defaultPayload(dir, overrides = {}) {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: "s-1",
    cwd: dir,
    transcript_path: path.join(dir, "transcript.jsonl"),
    prompt: "hello",
    ...overrides,
  };
}

function runHook(dir, payload, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  try {
    const out = execFileSync("node", [HOOK], {
      input,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout: out.toString() };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout || "").toString() };
  }
}

function parseNudge(stdout) {
  const obj = JSON.parse(stdout);
  assert.equal(obj.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return obj.hookSpecificOutput.additionalContext;
}

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/maturity-nudge.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("45-user-turn transcript → exactly the documented nudge", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 45);
    const { code, stdout } = runHook(dir, defaultPayload(dir));
    assert.equal(code, 0);
    assert.equal(parseNudge(stdout), NUDGE_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("20-user-turn transcript → silence", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 20);
    const { code, stdout } = runHook(dir, defaultPayload(dir));
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second fire in the same session → silence (per-session cooldown)", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 45);
    const first = runHook(dir, defaultPayload(dir));
    assert.equal(first.code, 0);
    assert.notEqual(first.stdout, "");

    const second = runHook(dir, defaultPayload(dir));
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "", "same session_id never nudges twice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a different session inside the global 60-min window → silence", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 45);
    const first = runHook(dir, defaultPayload(dir));
    assert.notEqual(first.stdout, "");

    writeTranscript(dir, "s-2", 45);
    const second = runHook(dir, defaultPayload(dir, { session_id: "s-2" }));
    assert.equal(second.code, 0);
    assert.equal(second.stdout, "", "global cooldown suppresses a different session's nudge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after the global cooldown window → a different session nudges", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 45);
    const first = runHook(dir, defaultPayload(dir));
    assert.notEqual(first.stdout, "");

    // Inject the clock: push lastGlobalNudge back past the 60-min window.
    const statePath = path.join(dir, STATE_REL);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.lastGlobalNudge = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify(state));

    writeTranscript(dir, "s-2", 45);
    const second = runHook(dir, defaultPayload(dir, { session_id: "s-2" }));
    assert.equal(second.code, 0);
    assert.equal(parseNudge(second.stdout), NUDGE_TEXT, "window elapsed → nudges again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_result-bearing user records are NOT counted as user turns", () => {
  const dir = ws();
  try {
    const p = path.join(dir, "transcript.jsonl");
    const lines = [];
    // 45 tool_result-only user records + 20 genuine prompts: below the 40 threshold if
    // tool_results were wrongly excluded from being miscounted... construct so that only
    // counting real prompts matters: 20 genuine prompts + 45 tool_result records → must stay
    // silent (20 < 40), proving tool_results are not inflating the count.
    for (let i = 0; i < 20; i++) {
      lines.push(userTextLine("s-1"));
      lines.push(assistantLine("s-1"));
    }
    for (let i = 0; i < 45; i++) {
      lines.push(toolResultLine("s-1"));
    }
    writeFileSync(p, lines.join("\n") + "\n");

    const { code, stdout } = runHook(dir, defaultPayload(dir));
    assert.equal(code, 0);
    assert.equal(stdout, "", "45 tool_result records must not count toward the 40-turn threshold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AIOS_MATURITY_NUDGE=0 kill switch → silence on a bloated session", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 45);
    const { code, stdout } = runHook(dir, defaultPayload(dir), {
      env: { AIOS_MATURITY_NUDGE: "0" },
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exits 0, no output", () => {
  const dir = ws();
  try {
    const { code, stdout } = runHook(dir, null, { rawInput: "not json at all {{{" });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript_path → silence, exit 0", () => {
  const dir = ws();
  try {
    const { code, stdout } = runHook(dir, defaultPayload(dir, { transcript_path: undefined }));
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-UserPromptSubmit event → no output", () => {
  const dir = ws();
  try {
    writeTranscript(dir, "s-1", 45);
    for (const ev of ["SessionStart", "SessionEnd", "Stop", "Notification"]) {
      const { code, stdout } = runHook(dir, defaultPayload(dir, { hook_event_name: ev }));
      assert.equal(code, 0);
      assert.equal(stdout, "", `${ev} produces no nudge`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
