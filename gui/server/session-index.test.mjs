import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readSessionIndex,
  upsertSession,
  visibleSessionIndex,
  writeSessionIndex,
} from "./session-index.mjs";

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "sessions-"));
  const sessionsDir = path.join(dir, ".aios", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  return { sessionsDir, indexPath: path.join(sessionsDir, "index.json") };
}

function writeTranscript(sessionsDir, id, events) {
  writeFileSync(
    path.join(sessionsDir, `${id}.jsonl`),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n"
  );
}

test("visibleSessionIndex hides untitled sessions without user content", () => {
  const { sessionsDir } = workspace();
  const titled = "11111111-1111-4111-8111-111111111111";
  const blank = "22222222-2222-4222-8222-222222222222";
  const legacyWithUser = "33333333-3333-4333-8333-333333333333";
  const missingTranscript = "44444444-4444-4444-8444-444444444444";

  writeTranscript(sessionsDir, blank, [{ type: "hello", sessionId: blank }]);
  writeTranscript(sessionsDir, legacyWithUser, [
    { type: "hello", sessionId: legacyWithUser },
    { type: "echo_user", text: "Help me write a plan" },
  ]);

  const idx = {
    lastSelected: blank,
    sessions: [
      { id: blank, title: "", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: titled, title: "Saved chat", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: legacyWithUser, title: "", createdAt: "2026-01-04T00:00:00.000Z" },
      { id: missingTranscript, title: "", createdAt: "2026-01-05T00:00:00.000Z" },
    ],
  };

  const visible = visibleSessionIndex(sessionsDir, idx);

  assert.deepEqual(
    visible.sessions.map((session) => session.id),
    [legacyWithUser, titled]
  );
  assert.equal(visible.lastSelected, null);
});

test("visibleSessionIndex preserves lastSelected when it points at a visible session", () => {
  const { sessionsDir } = workspace();
  const selected = "55555555-5555-4555-8555-555555555555";
  const idx = {
    lastSelected: selected,
    sessions: [{ id: selected, title: "Current chat", createdAt: "2026-01-01T00:00:00.000Z" }],
  };

  const visible = visibleSessionIndex(sessionsDir, idx);

  assert.equal(visible.lastSelected, selected);
  assert.equal(visible.sessions.length, 1);
});

test("upsertSession creates, merges, and selects a session", () => {
  const { indexPath } = workspace();
  const id = "66666666-6666-4666-8666-666666666666";

  upsertSession(indexPath, id, { model: "claude-sonnet-4-6" });
  upsertSession(indexPath, id, { title: "First real message" });

  const idx = readSessionIndex(indexPath);
  assert.equal(idx.lastSelected, id);
  assert.equal(idx.sessions.length, 1);
  assert.equal(idx.sessions[0].model, "claude-sonnet-4-6");
  assert.equal(idx.sessions[0].title, "First real message");
  assert.ok(idx.sessions[0].createdAt);
  assert.ok(idx.sessions[0].updatedAt);

  const raw = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(raw.sessions[0].id, id);
});

test("writeSessionIndex round-trips an empty index", () => {
  const { indexPath } = workspace();

  writeSessionIndex(indexPath, { sessions: [], lastSelected: null });

  assert.deepEqual(readSessionIndex(indexPath), { sessions: [], lastSelected: null });
});
