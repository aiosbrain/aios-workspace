// Decisions store (AIO-170 / EE4) — unit tests on the compiled store: fold create/outcome ops,
// unknown-id outcome warning, truncation/validation, duplicate-create-id first-wins, and the lock
// stale-reclaim path.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DECISIONS_STORE_REL,
  DECISIONS_HARD_LINE_CAP,
  appendDecision,
  appendDecisionsDeduped,
  decisionDedupeKey,
  appendOutcome,
  buildDecisionRecord,
  foldDecisionLines,
  readDecisions,
} from "../../dist/operator-loop/index.js";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "decisions-store-"));
}
function storeFile(root) {
  return path.join(root, DECISIONS_STORE_REL);
}
function writeRaw(root, lines) {
  const abs = storeFile(root);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, lines.join("\n") + "\n");
}
function baseDecision(over = {}) {
  return {
    id: "id",
    kind: "ask-user-question",
    question: "q?",
    header: null,
    options: [],
    choice: null,
    notes: null,
    context: { sessionId: null, project: null, transcriptPath: null, cwd: null },
    tier: "admin",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

test("fold: create → decision (outcome null); outcome op annotates it (last wins)", () => {
  const root = ws();
  try {
    const a = appendDecision(root, {
      kind: "ask-user-question",
      question: "Which db?",
      options: [{ label: "PG", description: "relational" }],
      choice: ["PG"],
    });
    appendOutcome(root, a.id, "first outcome", "2026-07-02T00:00:00.000Z");
    appendOutcome(root, a.id, "second outcome", "2026-07-03T00:00:00.000Z");
    const { decisions, warnings } = readDecisions(root);
    assert.equal(warnings.length, 0);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, "second outcome", "last outcome wins");
    assert.equal(decisions[0].outcomeAt, "2026-07-03T00:00:00.000Z");
    assert.deepEqual(decisions[0].choice, ["PG"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fold: creation order preserved; open decision has null outcome", () => {
  const root = ws();
  try {
    const a = appendDecision(root, { kind: "plan-approval", question: "A" });
    const b = appendDecision(root, { kind: "ask-user-question", question: "B" });
    const { decisions } = readDecisions(root);
    assert.deepEqual(
      decisions.map((d) => [d.id, d.outcome]),
      [
        [a.id, null],
        [b.id, null],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fold: duplicate create id — FIRST wins, second is a warning", () => {
  const root = ws();
  try {
    const rec = { v: 1, op: "create", decision: baseDecision({ id: "dup", question: "first" }) };
    const rec2 = { v: 1, op: "create", decision: baseDecision({ id: "dup", question: "second" }) };
    writeRaw(root, [JSON.stringify(rec), JSON.stringify(rec2)]);
    const { decisions, warnings } = readDecisions(root);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].question, "first");
    assert.ok(warnings.some((w) => w.reason === "duplicate-create-id"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fold: malformed / unknown-version / unknown-id outcome / unknown-op are warnings, never dropped", () => {
  const root = ws();
  try {
    const good = { v: 1, op: "create", decision: baseDecision({ id: "x1" }) };
    writeRaw(root, [
      "{not json",
      JSON.stringify({ v: 2, op: "create", decision: baseDecision({ id: "x2" }) }),
      JSON.stringify({
        v: 1,
        op: "outcome",
        id: "nope",
        outcome: "x",
        at: "2026-07-02T00:00:00.000Z",
      }),
      JSON.stringify({ v: 1, op: "frobnicate" }),
      JSON.stringify(good),
    ]);
    const { decisions, warnings } = readDecisions(root);
    assert.equal(decisions.length, 1);
    const reasons = warnings.map((w) => w.reason).sort();
    assert.deepEqual(reasons, [
      "malformed-json",
      "unknown-id-outcome",
      "unknown-op",
      "unknown-version",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fold: an outcome op for an unknown id is a counted warning (not silently dropped)", () => {
  const { decisions, warnings } = foldDecisionLines([
    JSON.stringify({ v: 1, op: "create", decision: baseDecision({ id: "known" }) }),
    JSON.stringify({
      v: 1,
      op: "outcome",
      id: "ghost",
      outcome: "?",
      at: "2026-07-02T00:00:00.000Z",
    }),
  ]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, null);
  assert.deepEqual(
    warnings.map((w) => w.reason),
    ["unknown-id-outcome"]
  );
});

test("write: tier validated; question/notes/option-labels normalized + truncated; newline-safe", () => {
  assert.throws(
    () => buildDecisionRecord({ kind: "k", question: "q", tier: "public" }),
    /invalid tier/
  );
  const rec = buildDecisionRecord({
    kind: "  Ask User Question!! ",
    question: "line one\nline two\t" + "x".repeat(600),
    header: "H\ndr" + "y".repeat(400),
    notes: "n".repeat(3000),
    options: [
      { label: "L".repeat(400), description: "d".repeat(2000) },
      { label: "", description: "skipme" }, // empty label dropped
    ],
    choice: ["  Postgres  ", "z".repeat(400)],
  });
  assert.equal(rec.kind, "ask-user-question");
  assert.equal(rec.question.length, 500);
  assert.ok(!/[\n\t]/.test(rec.question), "question has no control chars");
  assert.equal(rec.header.length, 200);
  assert.equal(rec.notes.length, 2000);
  assert.equal(rec.options.length, 1, "empty-label option dropped");
  assert.equal(rec.options[0].label.length, 200);
  assert.equal(rec.options[0].description.length, 1000);
  assert.equal(rec.choice[0], "Postgres");
  assert.equal(rec.choice[1].length, 200);
  assert.equal(rec.tier, "admin"); // default
  // A create line round-trips through NDJSON with an embedded newline in notes, still one line.
  const root = ws();
  try {
    appendDecision(root, { kind: "k", question: "hi", notes: "a\nb" });
    const raw = readFileSync(storeFile(root), "utf8").trimEnd();
    assert.equal(raw.split("\n").length, 1, "one physical line despite an embedded newline");
    const { decisions, warnings } = readDecisions(root);
    assert.equal(warnings.length, 0);
    assert.equal(decisions[0].notes, "a\nb");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write: choice defaults to null when not extractable; a bare string choice becomes one label", () => {
  const noChoice = buildDecisionRecord({ kind: "k", question: "q" });
  assert.equal(noChoice.choice, null);
  const emptyChoice = buildDecisionRecord({ kind: "k", question: "q", choice: [] });
  assert.equal(emptyChoice.choice, null, "empty choice array → null");
  const strChoice = buildDecisionRecord({ kind: "k", question: "q", choice: "Postgres" });
  assert.deepEqual(strChoice.choice, ["Postgres"]);
});

test("appendOutcome truncates the outcome text to 2000 chars", () => {
  const root = ws();
  try {
    const d = appendDecision(root, { kind: "k", question: "q" });
    appendOutcome(root, d.id, "o".repeat(3000));
    const { decisions } = readDecisions(root);
    assert.equal(decisions[0].outcome.length, 2000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readDecisions: missing store → empty, no warnings", () => {
  const root = ws();
  try {
    const { decisions, warnings } = readDecisions(root);
    assert.deepEqual(decisions, []);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock: a stale lockfile (mtime > 30s) is reclaimed, and the append still lands", () => {
  const root = ws();
  try {
    const abs = storeFile(root);
    mkdirSync(path.dirname(abs), { recursive: true });
    const lock = abs + ".lock";
    writeFileSync(lock, "99999 stale\n");
    const old = Date.now() / 1000 - 120;
    utimesSync(lock, old, old);
    const rec = appendDecision(root, { kind: "k", question: "after stale" });
    assert.ok(rec.id);
    assert.equal(existsSync(lock), false, "lock released");
    assert.equal(readDecisions(root).decisions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foldDecisionLines is pure over a line array (blanks ignored)", () => {
  const line = JSON.stringify({ v: 1, op: "create", decision: baseDecision({ id: "p1" }) });
  const { decisions, warnings } = foldDecisionLines([line, "", "  "]);
  assert.equal(decisions.length, 1);
  assert.equal(warnings.length, 0);
});

// ── AIO-192: additive fields (contextTag/source) + deduped batch writer ──────────────────────────

test("forward-compat: an old v1 create line without contextTag/source folds cleanly with both null", () => {
  const root = ws();
  try {
    // baseDecision() has no contextTag/source — exactly an AIO-170-era line.
    writeRaw(root, [JSON.stringify({ v: 1, op: "create", decision: baseDecision({ id: "old" }) })]);
    const { decisions, warnings } = readDecisions(root);
    assert.equal(warnings.length, 0);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].contextTag, null);
    assert.equal(decisions[0].source, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildDecisionRecord carries contextTag/source; non-string → null", () => {
  const a = buildDecisionRecord({
    kind: "k",
    question: "q",
    contextTag: "aios",
    source: "backfill",
  });
  assert.equal(a.contextTag, "aios");
  assert.equal(a.source, "backfill");
  const b = buildDecisionRecord({ kind: "k", question: "q", contextTag: 42, source: {} });
  assert.equal(b.contextTag, null);
  assert.equal(b.source, null);
});

test("appendDecisionsDeduped: dedups within a batch and against existing lines", () => {
  const root = ws();
  try {
    const inputs = [
      { kind: "ask-user-question", question: "Deploy now?", context: { sessionId: "s1" } },
      { kind: "ask-user-question", question: "Deploy now?", context: { sessionId: "s1" } }, // dup in-batch
      { kind: "ask-user-question", question: "Deploy now?", context: { sessionId: "s2" } }, // diff session
    ];
    const r1 = appendDecisionsDeduped(root, inputs);
    assert.deepEqual(r1, { appended: 2, skipped: 1, capped: 0 });
    // Re-running the same batch appends nothing (all keys now exist).
    const r2 = appendDecisionsDeduped(root, inputs);
    assert.deepEqual(r2, { appended: 0, skipped: 3, capped: 0 });
    assert.equal(readDecisions(root).decisions.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendDecisionsDeduped: a pre-existing hook-style create line suppresses an equivalent backfill input", () => {
  const root = ws();
  try {
    // A hook-written create line (no contextTag/source) for sess-x / "Same question?".
    const hookLine = JSON.stringify({
      v: 1,
      op: "create",
      decision: baseDecision({
        id: "hook-1",
        question: "Same question?",
        context: { sessionId: "sess-x", project: null, transcriptPath: null, cwd: null },
      }),
    });
    writeRaw(root, [hookLine]);
    // A backfill input for the SAME session + question must dedupe against the hook line.
    const res = appendDecisionsDeduped(root, [
      {
        kind: "ask-user-question",
        question: "Same question?",
        context: { sessionId: "sess-x" },
        source: "backfill",
      },
    ]);
    assert.deepEqual(
      res,
      { appended: 0, skipped: 1, capped: 0 },
      "cross-source dedupe under the shared key"
    );
    assert.equal(readDecisions(root).decisions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decisionDedupeKey matches the hook key shape (sessionId|sha256(question))", () => {
  const rec = buildDecisionRecord({
    kind: "k",
    question: "  Which   region? ",
    context: { sessionId: "s9" },
  });
  const key = decisionDedupeKey(rec);
  assert.match(key, /^s9\|[0-9a-f]{64}$/);
});

// Bugbot r1 (Medium): the batch writer must honor the hook's HARD_LINE_CAP — a backfill that
// pushed the store past it would silently disable live capture (the hook skips when over cap).
test("appendDecisionsDeduped: refuses inputs once the store is at DECISIONS_HARD_LINE_CAP", () => {
  const root = ws();
  try {
    // Seed the store to one line UNDER the cap (physical non-blank lines are what the cap counts).
    writeRaw(
      root,
      Array.from({ length: DECISIONS_HARD_LINE_CAP - 1 }, (_, i) => `{"pad":${i}}`)
    );
    const res = appendDecisionsDeduped(root, [
      { kind: "ask-user-question", question: "Fits under the cap?", context: { sessionId: "c1" } },
      { kind: "ask-user-question", question: "Over the cap?", context: { sessionId: "c2" } },
      { kind: "ask-user-question", question: "Also over?", context: { sessionId: "c3" } },
    ]);
    assert.deepEqual(res, { appended: 1, skipped: 0, capped: 2 }, "one slot left → 1 in, 2 capped");
    // At the cap now: nothing further lands.
    const res2 = appendDecisionsDeduped(root, [
      { kind: "ask-user-question", question: "Definitely over?", context: { sessionId: "c4" } },
    ]);
    assert.deepEqual(res2, { appended: 0, skipped: 0, capped: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
