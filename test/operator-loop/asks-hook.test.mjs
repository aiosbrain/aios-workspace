// Asks capture hook (AIO-167) — spawns hooks/asks-capture.mjs with realistic Notification/Stop
// payloads and realistic transcript JSONL fixtures, then folds the hook-written store through the
// COMPILED store (parity) to prove the dependency-free writer matches the TS schema exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASKS_STORE_REL,
  claimReply,
  foldLines,
  readAsks,
  releaseReply,
  sha256,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "asks-capture.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "asks-hook-"));
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
const open = (dir) => readAsks(dir).asks;
// A transcript fixture with tool_use / thinking blocks, string content, user + progress lines.
function transcript(dir, assistantTail, { asString = false } = {}) {
  const p = path.join(dir, "transcript.jsonl");
  const assistant = asString
    ? { type: "assistant", message: { content: assistantTail } }
    : {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: assistantTail },
          ],
        },
      };
  const lines = [
    { type: "user", message: { content: "please do the thing" } },
    { type: "progress", data: {} },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "earlier reply, ignore me" }] },
    },
    { type: "tool_result", content: "ok" },
    assistant,
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/asks-capture.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("Notification (idle) → one blocker ask; parity-folds with tier=admin + idle dedupeKey", () => {
  const dir = ws();
  try {
    const code = runHook(dir, {
      hook_event_name: "Notification",
      session_id: "sess-A",
      transcript_path: path.join(dir, "t.jsonl"),
      message: "Claude is waiting for your input on the next step",
    });
    assert.equal(code, 0);
    // Fold the RAW hook-written file through the compiled store (parity).
    const raw = readFileSync(path.join(dir, ASKS_STORE_REL), "utf8");
    const { asks, warnings } = foldLines(raw.split(/\r?\n/));
    assert.equal(warnings.length, 0, "hook lines fold cleanly through the TS store");
    assert.equal(asks.length, 1);
    assert.equal(asks[0].kind, "idle");
    assert.equal(asks[0].severity, "blocker");
    assert.equal(asks[0].tier, "admin"); // default tier
    assert.equal(asks[0].source, "hook:idle");
    assert.equal(asks[0].dedupeKey, sha256("sess-A|idle"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Notification (non-idle) → nothing", () => {
  const dir = ws();
  try {
    runHook(dir, { hook_event_name: "Notification", session_id: "s", message: "Build finished." });
    assert.equal(existsSync(path.join(dir, ASKS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Notification idle repeated → deduped to a single open ask", () => {
  const dir = ws();
  try {
    const payload = {
      hook_event_name: "Notification",
      session_id: "sess-B",
      message: "waiting for your response",
    };
    runHook(dir, payload);
    runHook(dir, payload);
    assert.equal(open(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit resolves only the matching session's idle ask", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "Notification",
      session_id: "a",
      message: "waiting for your input",
    });
    runHook(dir, {
      hook_event_name: "Notification",
      session_id: "b",
      message: "waiting for your input",
    });
    runHook(dir, { hook_event_name: "UserPromptSubmit", session_id: "a" });
    const asks = readAsks(dir).asks;
    assert.equal(asks.find((a) => a.sessionId === "a").status, "resolved");
    assert.equal(asks.find((a) => a.sessionId === "b").status, "open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (interrogative tail, array content w/ tool_use) → decision ask", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "Do you want me to deploy to production?");
    runHook(dir, { hook_event_name: "Stop", session_id: "s1", transcript_path: tp });
    const asks = open(dir);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].kind, "stop");
    assert.equal(asks[0].severity, "decision");
    assert.match(asks[0].title, /deploy to production\?$/);
    assert.ok(asks[0].tailHash, "stop ask records a tailHash");
    assert.equal(asks[0].dedupeKey, sha256(`s1|${asks[0].tailHash}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (completion tail, STRING content) → fyi ask", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "All done, tests passing and PR is up.", { asString: true });
    runHook(dir, { hook_event_name: "Stop", session_id: "s2", transcript_path: tp });
    const asks = open(dir);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].severity, "fyi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (plain prose tail) → nothing", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "Here is a summary of the files I read.");
    runHook(dir, { hook_event_name: "Stop", session_id: "s3", transcript_path: tp });
    assert.equal(existsSync(path.join(dir, ASKS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop with stop_hook_active → nothing (no recursion)", () => {
  const dir = ws();
  try {
    const tp = transcript(dir, "Should I continue?");
    runHook(dir, {
      hook_event_name: "Stop",
      session_id: "s4",
      transcript_path: tp,
      stop_hook_active: true,
    });
    assert.equal(existsSync(path.join(dir, ASKS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exits 0, writes nothing", () => {
  const dir = ws();
  try {
    assert.equal(runHook(dir, null, { rawInput: "not json at all {{{" }), 0);
    assert.equal(existsSync(path.join(dir, ASKS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parity: a long idle message is truncated to 200 chars by the hook (folds identically)", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "Notification",
      session_id: "s5",
      message: "waiting for your input " + "x".repeat(500),
    });
    const raw = readFileSync(path.join(dir, ASKS_STORE_REL), "utf8");
    const { asks } = foldLines(raw.split(/\r?\n/));
    assert.equal(asks[0].title.length, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop (last assistant message is tool_use-only) → nothing, even if an earlier message asked", () => {
  const dir = ws();
  try {
    const tp = path.join(dir, "transcript.jsonl");
    const lines = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Should I merge the PR now?" }] },
      },
      { type: "tool_result", content: "ok" },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
      },
    ];
    writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const code = runHook(dir, {
      hook_event_name: "Stop",
      session_id: "sess-tool-tail",
      transcript_path: tp,
    });
    assert.equal(code, 0);
    assert.ok(
      !existsSync(path.join(dir, ASKS_STORE_REL)),
      "stale earlier text must not be captured as the turn's tail"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracked root and scaffold settings wire UserPromptSubmit lifecycle reconciliation", () => {
  for (const settingsPath of [
    path.join(ROOT, ".claude", "settings.json"),
    path.join(ROOT, "scaffold", ".claude", "settings.json"),
  ]) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const commands = (settings.hooks?.UserPromptSubmit || []).flatMap((group) =>
      (group.hooks || []).map((hook) => hook.command)
    );
    assert.ok(
      commands.includes("${CLAUDE_PROJECT_DIR}/hooks/asks-capture.mjs"),
      `${settingsPath} resolves matching idle asks when the user returns`
    );
  }
});

test("UserPromptSubmit does not resolve an idle ask claimed by an in-flight GUI reply", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      session_id: "session-claimed",
      message: "Waiting for your input",
    });
    const ask = open(dir)[0];
    assert.equal(claimReply(dir, ask.id, "claim-token", "2026-07-16T01:00:00.000Z"), "claimed");
    runHook(dir, { hook_event_name: "UserPromptSubmit", session_id: "session-claimed" });
    assert.equal(open(dir)[0].status, "open");
    assert.equal(open(dir)[0].replyClaim?.token, "claim-token");
    assert.equal(releaseReply(dir, ask.id, "claim-token", "2026-07-16T01:01:00.000Z"), true);
    runHook(dir, { hook_event_name: "UserPromptSubmit", session_id: "session-claimed" });
    assert.equal(
      open(dir)[0].status,
      "resolved",
      "ordinary later prompt still closes the idle ask"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
