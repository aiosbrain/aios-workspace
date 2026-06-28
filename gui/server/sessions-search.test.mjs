import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { searchSessions, plainText, SEARCH_LIMITS } from "./sessions-search.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "index.mjs");

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "search-"));
  const sessionsDir = path.join(dir, ".aios", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // Minimal marker so the GUI server recognizes this as an AIOS workspace on boot.
  writeFileSync(path.join(dir, "aios.yaml"), "owner: test\n");
  return { repo: dir, sessionsDir };
}

function writeTranscript(sessionsDir, id, events) {
  writeFileSync(
    path.join(sessionsDir, `${id}.jsonl`),
    events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n"
  );
}

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

/* ───────────────────────── pure helper ───────────────────────── */

test("searchSessions matches transcript body and returns a snippet", () => {
  const { sessionsDir } = workspace();
  writeTranscript(sessionsDir, ID_A, [
    { type: "echo_user", text: "help me draft the quarterly budget plan" },
    { type: "delta", text: "Sure, here is a budget outline" },
  ]);
  const sessions = [{ id: ID_A, title: "Budget chat" }];
  const { results } = searchSessions(sessionsDir, sessions, "quarterly budget");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, ID_A);
  assert.match(results[0].snippet, /quarterly budget/i);
});

test("searchSessions matches the title when the body does not", () => {
  const { sessionsDir } = workspace();
  writeTranscript(sessionsDir, ID_A, [{ type: "echo_user", text: "unrelated content" }]);
  const sessions = [{ id: ID_A, title: "Onboarding notes" }];
  const { results } = searchSessions(sessionsDir, sessions, "onboarding");
  assert.equal(results.length, 1);
  assert.match(results[0].snippet, /Onboarding/);
});

test("empty / whitespace query returns no results", () => {
  const { sessionsDir } = workspace();
  writeTranscript(sessionsDir, ID_A, [{ type: "echo_user", text: "anything" }]);
  for (const q of ["", "   ", null, undefined]) {
    assert.deepEqual(searchSessions(sessionsDir, [{ id: ID_A, title: "x" }], q).results, []);
  }
});

test("query is clamped to maxQueryLen (no crash on huge input)", () => {
  const { sessionsDir } = workspace();
  writeTranscript(sessionsDir, ID_A, [{ type: "echo_user", text: "needle here" }]);
  const huge = "needle" + "x".repeat(5000);
  const { results } = searchSessions(sessionsDir, [{ id: ID_A, title: "" }], huge);
  // The clamped query won't match the short body — assert it simply doesn't throw / overmatch.
  assert.equal(results.length, 0);
});

test("malformed JSONL lines are skipped, not fatal", () => {
  const { sessionsDir } = workspace();
  writeTranscript(sessionsDir, ID_A, [
    "{not valid json",
    { type: "echo_user", text: "valid needle line" },
    "}}}",
  ]);
  const { results } = searchSessions(sessionsDir, [{ id: ID_A, title: "" }], "needle");
  assert.equal(results.length, 1);
});

test("snippet is HTML-stripped (no markup injection)", () => {
  const { sessionsDir } = workspace();
  writeTranscript(sessionsDir, ID_A, [
    { type: "echo_user", text: "before <script>alert(1)</script> SECRETWORD after" },
  ]);
  const { results } = searchSessions(sessionsDir, [{ id: ID_A, title: "" }], "secretword");
  assert.equal(results.length, 1);
  assert.doesNotMatch(results[0].snippet, /<[^>]+>/);
});

test("snippet length respects the cap", () => {
  const { sessionsDir } = workspace();
  const long = "needle " + "word ".repeat(500);
  writeTranscript(sessionsDir, ID_A, [{ type: "echo_user", text: long }]);
  const { results } = searchSessions(sessionsDir, [{ id: ID_A, title: "" }], "needle", {
    snippetLen: 80,
  });
  // snippet is the excerpt plus possible "… " / " …" affixes — allow a small margin.
  assert.ok(results[0].snippet.length <= 80 + 8, `snippet too long: ${results[0].snippet.length}`);
});

test("maxResults caps the number of hits", () => {
  const { sessionsDir } = workspace();
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const id = `0000000${i}-0000-4000-8000-000000000000`;
    writeTranscript(sessionsDir, id, [{ type: "echo_user", text: "common needle term" }]);
    sessions.push({ id, title: "" });
  }
  const { results } = searchSessions(sessionsDir, sessions, "needle", { maxResults: 2 });
  assert.equal(results.length, 2);
});

test("plainText collapses whitespace and removes tags", () => {
  assert.equal(plainText("a <b>bold</b>\n\n  word"), "a bold word");
});

test("SEARCH_LIMITS exposes the documented ceilings", () => {
  assert.ok(SEARCH_LIMITS.maxBytes > 0 && SEARCH_LIMITS.maxSessions > 0);
});

/* ──────────────────── route ordering + token gating (real server) ──────────────────── */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, token, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/sessions?token=${token}`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("GET /api/sessions/search: route ordering + token gating (live server)", async (t) => {
  const { repo, sessionsDir } = workspace();
  // A titled session with searchable content so it is "visible" in the index.
  writeFileSync(
    path.join(sessionsDir, "index.json"),
    JSON.stringify({
      sessions: [
        { id: ID_A, title: "Budget chat", createdAt: "2026-01-01", updatedAt: "2026-01-02" },
        { id: ID_B, title: "Other", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      ],
      lastSelected: ID_A,
    })
  );
  writeTranscript(sessionsDir, ID_A, [
    { type: "echo_user", text: "draft the quarterly budget" },
  ]);
  writeTranscript(sessionsDir, ID_B, [{ type: "echo_user", text: "hello there" }]);

  const port = await freePort();
  const token = "devtoken";
  const child = spawn(process.execPath, [SERVER, "--repo", repo, "--port", String(port)], {
    env: { ...process.env, AIOS_GUI_TOKEN: token },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));

  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitForServer(base, token), "server did not start in time");

  // 1. Route ordering: "search" must NOT be parsed as a session id (no 400 "bad session id").
  const ok = await fetch(`${base}/api/sessions/search?q=budget&token=${token}`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(Array.isArray(body.results), "expected results array");
  assert.ok(
    body.results.some((r) => r.id === ID_A),
    "expected the budget chat in results"
  );

  // 2. Token gating: missing/wrong token → 401.
  const noTok = await fetch(`${base}/api/sessions/search?q=budget`);
  assert.equal(noTok.status, 401);

  // 3. The :id route still works for a real UUID (contract unchanged).
  const byId = await fetch(`${base}/api/sessions/${ID_A}?token=${token}`);
  assert.equal(byId.status, 200);
});
