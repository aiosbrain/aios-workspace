import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as loop from "../../dist/operator-loop/index.js";
import {
  archiveClaudeAsk,
  projectClaudeAskContext,
  readBoundTranscript,
  reconcileClaudeAsks,
  replyToClaudeAsk,
} from "../../gui/server/claude-asks.mjs";

const SESSION = "123e4567-e89b-12d3-a456-426614174000";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "claude-ask-"));
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions);
  const transcriptPath = path.join(sessions, `${SESSION}.jsonl`);
  return { root, sessions, transcriptPath };
}

function recordAsk(root, transcriptPath, extra = {}) {
  return loop.appendCreate(root, {
    id: "ask-1",
    kind: "idle",
    severity: "blocker",
    title: "Claude needs input",
    source: "hook:idle",
    sessionId: SESSION,
    transcriptPath,
    createdAt: "2026-07-16T01:00:00.000Z",
    ...extra,
  });
}

function writeTurns(file, turns) {
  writeFileSync(file, turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n");
}

test("Claude ask context is transcript-bound, bounded, and redacts secrets", () => {
  const f = fixture();
  try {
    const secret = `sk-${"a".repeat(44)}`;
    writeTurns(f.transcriptPath, [
      {
        type: "user",
        sessionId: SESSION,
        timestamp: "2026-07-16T00:59:00.000Z",
        message: { content: "Please prepare the release." },
      },
      {
        type: "assistant",
        sessionId: SESSION,
        timestamp: "2026-07-16T01:00:00.000Z",
        message: { content: [{ type: "text", text: `Which environment should I use? ${secret}` }] },
      },
    ]);
    const ask = recordAsk(f.root, f.transcriptPath);
    const context = projectClaudeAskContext(
      f.root,
      { ...ask, status: "open" },
      { allowedRoots: [f.sessions] }
    );
    assert.match(context.subject, /Which environment/);
    assert.doesNotMatch(JSON.stringify(context), new RegExp(secret));
    assert.match(context.summary, /\[REDACTED\]/);
    assert.equal(context.canReply, true);

    assert.throws(
      () =>
        readBoundTranscript(
          { ...ask, sessionId: "different-session" },
          { allowedRoots: [f.sessions] }
        ),
      /binding/
    );
    const outside = path.join(f.root, `${SESSION}.jsonl`);
    writeFileSync(outside, "");
    assert.throws(
      () =>
        readBoundTranscript({ ...ask, transcriptPath: outside }, { allowedRoots: [f.sessions] }),
      /outside/
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reply resumes only the canonical session and resolves only after an exact successful result", async () => {
  const f = fixture();
  try {
    writeTurns(f.transcriptPath, [
      {
        type: "assistant",
        sessionId: SESSION,
        timestamp: "2026-07-16T01:00:00.000Z",
        message: { content: "Which environment?" },
      },
    ]);
    recordAsk(f.root, f.transcriptPath);
    let captured;
    const query = (input) => {
      captured = input;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: SESSION };
        yield { type: "result", subtype: "success", session_id: SESSION };
      })();
    };
    const result = await replyToClaudeAsk(
      loop,
      f.root,
      "ask-1",
      { message: "Use staging", sessionId: "attacker-session" },
      { query, getSessionInfo: async () => ({ sessionId: SESSION }) },
      { allowedRoots: [f.sessions] }
    );
    assert.equal(result.accepted, true);
    assert.equal(captured.prompt, "Use staging");
    assert.equal(
      captured.options.resume,
      SESSION,
      "canonical store session wins over client claims"
    );
    assert.equal(loop.readAsks(f.root).asks[0].status, "resolved");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reply failure or session mismatch leaves the ask open", async () => {
  for (const events of [
    [
      { type: "system", subtype: "init", session_id: SESSION },
      { type: "result", subtype: "error_during_execution", session_id: SESSION },
    ],
    [
      { type: "system", subtype: "init", session_id: "different-session" },
      { type: "result", subtype: "success", session_id: "different-session" },
    ],
  ]) {
    const f = fixture();
    try {
      writeTurns(f.transcriptPath, [
        { type: "assistant", sessionId: SESSION, message: { content: "Need input" } },
      ]);
      recordAsk(f.root, f.transcriptPath);
      const query = () =>
        (async function* () {
          for (const event of events) yield event;
        })();
      await assert.rejects(
        replyToClaudeAsk(
          loop,
          f.root,
          "ask-1",
          { message: "Continue" },
          { query },
          { allowedRoots: [f.sessions] }
        ),
        /did not accept|different session/
      );
      assert.equal(loop.readAsks(f.root).asks[0].status, "open");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("archive is durable and removes the ask from the assembled inbox", () => {
  const f = fixture();
  try {
    writeFileSync(f.transcriptPath, "");
    recordAsk(f.root, f.transcriptPath);
    assert.deepEqual(archiveClaudeAsk(loop, f.root, "ask-1"), { ok: true, archived: true });
    const ask = loop.readAsks(f.root).asks[0];
    assert.equal(ask.status, "archived");
    assert.equal(
      loop.buildInbox(f.root).items.some((item) => item.id === ask.id),
      false
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("reconciliation resolves only on a later ordinary user turn from the bound session", () => {
  for (const [timestamp, expected] of [
    ["2026-07-16T01:01:00.000Z", "resolved"],
    ["2026-07-16T00:59:00.000Z", "open"],
    [null, "open"],
  ]) {
    const f = fixture();
    try {
      writeTurns(f.transcriptPath, [
        {
          type: "user",
          sessionId: SESSION,
          ...(timestamp ? { timestamp } : {}),
          message: { content: "I am back" },
        },
      ]);
      recordAsk(f.root, f.transcriptPath);
      reconcileClaudeAsks(loop, f.root, { allowedRoots: [f.sessions] });
      assert.equal(loop.readAsks(f.root).asks[0].status, expected);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
