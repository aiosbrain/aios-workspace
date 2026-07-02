// Decision capture hook (AIO-170 / EE4) — spawns hooks/decision-capture.mjs with realistic
// PostToolUse payloads (AskUserQuestion + ExitPlanMode) and folds the hook-written store through the
// COMPILED store (parity) to prove the dependency-free writer matches the TS schema exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  foldDecisionLines,
  readDecisions,
  DECISIONS_STORE_REL,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "decision-capture.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "decisions-hook-"));
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
// Fold the RAW hook-written file through the compiled store (parity) — proves the schema matches.
function foldStore(dir) {
  const raw = readFileSync(path.join(dir, DECISIONS_STORE_REL), "utf8");
  return foldDecisionLines(raw.split(/\r?\n/));
}
const list = (dir) => readDecisions(dir).decisions;

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/decision-capture.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("AskUserQuestion: two questions → two records; answered one carries choice + notes, folds cleanly", () => {
  const dir = ws();
  try {
    const code = runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-A",
      transcript_path: path.join(dir, "t.jsonl"),
      cwd: "/proj",
      tool_input: {
        questions: [
          {
            question: "Which database?",
            header: "Database",
            multiSelect: false,
            options: [
              { label: "Postgres", description: "relational" },
              { label: "Mongo", description: "document" },
            ],
          },
          {
            question: "Deploy region?",
            header: "Region",
            multiSelect: false,
            options: [{ label: "us-east", description: null }],
          },
        ],
      },
      tool_response: {
        answers: [
          {
            question: "Which database?",
            header: "Database",
            answer: "Postgres",
            notes: "cheaper for our load",
          },
        ],
      },
    });
    assert.equal(code, 0);
    const { decisions, warnings } = foldStore(dir);
    assert.equal(warnings.length, 0, "hook lines fold cleanly through the TS store");
    assert.equal(decisions.length, 2);
    const db = decisions.find((d) => d.header === "Database");
    assert.equal(db.kind, "ask-user-question");
    assert.equal(db.tier, "admin");
    assert.deepEqual(db.choice, ["Postgres"]);
    assert.equal(db.notes, "cheaper for our load");
    assert.equal(db.options.length, 2);
    assert.equal(db.context.sessionId, "sess-A");
    assert.equal(db.context.cwd, "/proj");
    // The unanswered question is still captured, with choice null.
    const region = decisions.find((d) => d.header === "Region");
    assert.equal(region.choice, null, "unanswered question captured with choice null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AskUserQuestion multiSelect → choice is the array of selected labels", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-multi",
      tool_input: {
        questions: [
          {
            question: "Which features?",
            header: "Features",
            multiSelect: true,
            options: [
              { label: "Auth", description: null },
              { label: "Billing", description: null },
              { label: "Search", description: null },
            ],
          },
        ],
      },
      tool_response: { answers: [{ header: "Features", answer: ["Auth", "Search"] }] },
    });
    const [d] = list(dir);
    assert.deepEqual(d.choice, ["Auth", "Search"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AskUserQuestion with no extractable answer → choice null, still captured", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-unk",
      tool_input: {
        questions: [
          { question: "Pick one?", header: "Pick", options: [{ label: "A" }, { label: "B" }] },
          { question: "And another?", header: "More", options: [{ label: "C" }] },
        ],
      },
      // A shape we don't understand — no per-question mapping possible with 2 questions.
      tool_response: "some opaque server string",
    });
    const decisions = list(dir);
    assert.equal(decisions.length, 2);
    for (const d of decisions) assert.equal(d.choice, null);
    assert.equal(decisions.find((d) => d.header === "Pick").options.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared header cannot steal answers: question-text match routes each answer", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-hdr",
      tool_input: {
        questions: [
          {
            question: "Deploy to staging?",
            header: "Deploy",
            options: [{ label: "Yes" }, { label: "No" }],
          },
          {
            question: "Deploy to prod?",
            header: "Deploy",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
      tool_response: {
        answers: [
          { question: "Deploy to staging?", answer: "Yes" },
          { question: "Deploy to prod?", answer: "No" },
        ],
      },
    });
    const ds = list(dir);
    const staging = ds.find((d) => /staging/.test(d.question));
    const prod = ds.find((d) => /prod/.test(d.question));
    assert.deepEqual(staging.choice, ["Yes"]);
    assert.deepEqual(
      prod.choice,
      ["No"],
      "second question with the shared header keeps its own answer"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("answer payloads echoing the options list do not inflate choice", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-echo",
      tool_input: {
        questions: [
          {
            question: "Pick a database",
            header: "DB",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      },
      tool_response: {
        answers: {
          "Pick a database": {
            answer: "Postgres",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        },
      },
    });
    const [d] = list(dir);
    assert.deepEqual(d.choice, ["Postgres"], "echoed options are not captured as choices");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("answers keyed by whitespace-collapsed question text still match", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-norm",
      tool_input: {
        questions: [
          { question: "  Which   region? ", header: "Region", options: [{ label: "EU" }] },
        ],
      },
      tool_response: { answers: { "Which region?": "EU" } },
    });
    const [d] = list(dir);
    assert.deepEqual(d.choice, ["EU"], "normalized-key lookup matches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ExitPlanMode approved → plan-approval record, choice=approved", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      session_id: "sess-plan",
      tool_input: { plan: "# Ship the billing module\n\nStep 1: ...\nStep 2: ..." },
      tool_response: "User has approved your plan. You can now start coding.",
    });
    const [d] = list(dir);
    assert.equal(d.kind, "plan-approval");
    assert.deepEqual(d.choice, ["approved"]);
    assert.match(d.question, /^Plan approval: Ship the billing module$/);
    assert.equal(d.notes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ExitPlanMode rejected with feedback → choice=rejected, feedback in notes", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      session_id: "sess-plan2",
      tool_input: { plan: "## Refactor auth\n\ndetails" },
      tool_response: "User rejected. Do not touch auth yet — focus on billing.",
    });
    const [d] = list(dir);
    assert.deepEqual(d.choice, ["rejected"]);
    assert.match(d.notes, /focus on billing/);
    assert.match(d.question, /Refactor auth$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ExitPlanMode rejection whose feedback contains 'approve' is NOT misread as approval", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      session_id: "sess-plan3",
      tool_input: { plan: "# Migrate the DB" },
      tool_response:
        "The user doesn't want to proceed. The user said: I would approve this if it included a rollback step.",
    });
    const [d] = list(dir);
    assert.deepEqual(d.choice, ["rejected"], "rejection markers win over the word 'approve'");
    assert.match(d.notes, /rollback step/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ExitPlanMode with unrecognized response phrasing → captured with choice=null, text kept as notes", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      session_id: "sess-plan4",
      tool_input: { plan: "# Something" },
      tool_response: "Some future harness phrasing we have never seen.",
    });
    const [d] = list(dir);
    assert.equal(d.choice, null, "unknown phrasing is not guessed");
    assert.match(d.notes, /future harness phrasing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-matching tool → nothing written", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "files",
    });
    assert.equal(existsSync(path.join(dir, DECISIONS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrong hook event (PreToolUse) → nothing", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "q", header: "h", options: [] }] },
    });
    assert.equal(existsSync(path.join(dir, DECISIONS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exits 0, writes nothing", () => {
  const dir = ws();
  try {
    assert.equal(runHook(dir, null, { rawInput: "not json at all {{{" }), 0);
    assert.equal(existsSync(path.join(dir, DECISIONS_STORE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedupe: re-firing the SAME AskUserQuestion payload does not double-write", () => {
  const dir = ws();
  try {
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-dupe",
      tool_input: {
        questions: [{ question: "Same question?", header: "H", options: [{ label: "A" }] }],
      },
      tool_response: { answers: [{ header: "H", answer: "A" }] },
    };
    runHook(dir, payload);
    runHook(dir, payload);
    assert.equal(list(dir).length, 1, "same session + question deduped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinct sessions asking the same question are NOT deduped (per-session key)", () => {
  const dir = ws();
  try {
    const mk = (sid) => ({
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: sid,
      tool_input: {
        questions: [{ question: "Deploy now?", header: "H", options: [{ label: "Y" }] }],
      },
      tool_response: { answers: [{ header: "H", answer: "Y" }] },
    });
    runHook(dir, mk("s1"));
    runHook(dir, mk("s2"));
    assert.equal(list(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parity: a long question is truncated to 500 chars by the hook (folds identically)", () => {
  const dir = ws();
  try {
    runHook(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "s-long",
      tool_input: {
        questions: [{ question: "x".repeat(600), header: "H", options: [{ label: "A" }] }],
      },
      tool_response: { answers: [{ header: "H", answer: "A" }] },
    });
    const { decisions, warnings } = foldStore(dir);
    assert.equal(warnings.length, 0);
    assert.equal(decisions[0].question.length, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
