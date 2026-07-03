// Pure decision extractor (AIO-192) — contextTagFor table + extractDecisions pairing over
// transcript record sequences (no I/O, no store). Imports the script module directly.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDecisions, contextTagFor } from "../../scripts/decision-extract.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
void ROOT;

const HOME = "/home/dev";
const P = (...seg) => path.join(HOME, "Projects", ...seg);

test("contextTagFor: full table incl. anchor renames + unknown", () => {
  assert.equal(contextTagFor(P("aios", "aios-workspace"), HOME), "aios");
  assert.equal(contextTagFor(P("hermes", "core"), HOME), "hermes");
  assert.equal(contextTagFor(P("products", "vibrana"), HOME), "products");
  assert.equal(contextTagFor(P("sites", "john-ellison.com"), HOME), "sites");
  assert.equal(contextTagFor(P("labs", "experiment"), HOME), "labs");
  assert.equal(contextTagFor(P("games", "g"), HOME), "games");
  assert.equal(contextTagFor(P("clients", "acme"), HOME), "clients");
  // anchor renames
  assert.equal(contextTagFor(P("john-workspace"), HOME), "workspace");
  assert.equal(contextTagFor(P("personal-life"), HOME), "personal");
  // outside $HOME/Projects → unknown
  assert.equal(contextTagFor("/etc/passwd", HOME), "unknown");
  assert.equal(contextTagFor(path.join(HOME, "Downloads", "x"), HOME), "unknown");
  // the Projects base itself is not a repo → unknown
  assert.equal(contextTagFor(path.join(HOME, "Projects"), HOME), "unknown");
});

function askUse(id, questions) {
  return { type: "tool_use", id, name: "AskUserQuestion", input: { questions } };
}
function planUse(id, plan) {
  return { type: "tool_use", id, name: "ExitPlanMode", input: { plan } };
}
function asstRec(sessionId, ts, cwd, blocks) {
  return {
    type: "assistant",
    sessionId,
    timestamp: ts,
    cwd,
    message: { role: "assistant", content: blocks },
  };
}
function resultRec(sessionId, ts, cwd, toolUseId, toolUseResult, content = "ok") {
  const rec = {
    type: "user",
    sessionId,
    timestamp: ts,
    cwd,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  };
  if (toolUseResult !== undefined) rec.toolUseResult = toolUseResult;
  return rec;
}

test("extractDecisions: AskUserQuestion paired with a structured answer", () => {
  const records = [
    asstRec("s1", "2026-06-01T10:00:00Z", "/repo", [
      askUse("tu1", [
        {
          question: "Which database?",
          header: "DB",
          options: [{ label: "Postgres" }, { label: "Mongo" }],
        },
      ]),
    ]),
    resultRec("s1", "2026-06-01T10:00:05Z", "/repo", "tu1", {
      answers: [{ question: "Which database?", answer: "Postgres" }],
    }),
  ];
  const { decisions, stats } = extractDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(stats.unpaired, 0);
  const d = decisions[0];
  assert.equal(d.kind, "ask-user-question");
  assert.equal(d.question, "Which database?");
  assert.deepEqual(d.choice, ["Postgres"]);
  assert.equal(d.source, "backfill");
  assert.equal(d.context.sessionId, "s1");
  assert.equal(d.createdAt, "2026-06-01T10:00:00Z");
  assert.equal(d.originCwd, "/repo", "carries its own record cwd for CLI origin classification");
});

test("extractDecisions: each decision carries its OWN record cwd (multi-cwd transcript)", () => {
  const records = [
    asstRec("s1", "2026-06-01T10:00:00Z", "/repo-a", [
      askUse("tu1", [{ question: "A?", header: "A", options: [{ label: "x" }] }]),
    ]),
    resultRec("s1", "2026-06-01T10:00:05Z", "/repo-a", "tu1", {
      answers: [{ question: "A?", answer: "x" }],
    }),
    // Same session file, a different cwd (resumed session / cd mid-session).
    asstRec("s1", "2026-06-01T11:00:00Z", "/repo-b", [
      askUse("tu2", [{ question: "B?", header: "B", options: [{ label: "y" }] }]),
    ]),
    resultRec("s1", "2026-06-01T11:00:05Z", "/repo-b", "tu2", {
      answers: [{ question: "B?", answer: "y" }],
    }),
  ];
  const { decisions } = extractDecisions(records);
  assert.equal(decisions.length, 2);
  assert.equal(decisions.find((d) => d.question === "A?").originCwd, "/repo-a");
  assert.equal(decisions.find((d) => d.question === "B?").originCwd, "/repo-b");
});

test("extractDecisions: ExitPlanMode approved → plan-approval with the plan title", () => {
  const records = [
    asstRec("s2", "2026-06-02T09:00:00Z", "/repo", [
      planUse("tu2", "# Ship the billing module\n\nstep 1"),
    ]),
    resultRec(
      "s2",
      "2026-06-02T09:00:05Z",
      "/repo",
      "tu2",
      undefined,
      "User has approved your plan."
    ),
  ];
  const { decisions } = extractDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, "plan-approval");
  assert.equal(decisions[0].question, "Plan approval: Ship the billing module");
  assert.deepEqual(decisions[0].choice, ["approved"]);
});

test("extractDecisions: an unpaired tool_use (no tool_result) → choice null + counted", () => {
  const records = [
    asstRec("s3", "2026-06-03T09:00:00Z", "/repo", [
      askUse("tu3", [{ question: "Ghost?", header: "G", options: [{ label: "A" }] }]),
    ]),
    // no result record for tu3
  ];
  const { decisions, stats } = extractDecisions(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].choice, null);
  assert.equal(stats.unpaired, 1);
});

test("extractDecisions: a record with no timestamp is skipped + counted (never a fabricated now)", () => {
  const rec = asstRec("s3b", "2026-06-03T09:00:00Z", "/repo", [
    askUse("tu3b", [{ question: "When was I?", header: "T", options: [{ label: "A" }] }]),
  ]);
  delete rec.timestamp;
  const { decisions, stats } = extractDecisions([rec]);
  assert.equal(decisions.length, 0, "no createdAt → not extracted");
  assert.equal(stats.missingTimestamp, 1);
  assert.equal(stats.unpaired, 0, "a dropped moment is not double-counted as unpaired");
});

test("extractDecisions: an UNPARSEABLE timestamp is skipped + counted like a missing one", () => {
  const rec = asstRec("s3c", "not-a-real-date", "/repo", [
    askUse("tu3c", [{ question: "Corrupt when?", header: "T", options: [{ label: "A" }] }]),
  ]);
  const { decisions, stats } = extractDecisions([rec]);
  assert.equal(decisions.length, 0, "invalid createdAt would silently become 'now' — refuse");
  assert.equal(stats.missingTimestamp, 1);
});

test("extractDecisions: two questions in one call each keep their own answer", () => {
  const records = [
    asstRec("s4", "2026-06-04T09:00:00Z", "/repo", [
      askUse("tu4", [
        {
          question: "Deploy staging?",
          header: "Stg",
          options: [{ label: "Yes" }, { label: "No" }],
        },
        { question: "Deploy prod?", header: "Prod", options: [{ label: "Yes" }, { label: "No" }] },
      ]),
    ]),
    resultRec("s4", "2026-06-04T09:00:05Z", "/repo", "tu4", {
      answers: [
        { question: "Deploy staging?", answer: "Yes" },
        { question: "Deploy prod?", answer: "No" },
      ],
    }),
  ];
  const { decisions } = extractDecisions(records);
  assert.equal(decisions.length, 2);
  const stg = decisions.find((d) => /staging/.test(d.question));
  const prod = decisions.find((d) => /prod/.test(d.question));
  assert.deepEqual(stg.choice, ["Yes"]);
  assert.deepEqual(prod.choice, ["No"]);
});

test("extractDecisions: non-target tools and noise are ignored", () => {
  const records = [
    asstRec("s5", "2026-06-05T09:00:00Z", "/repo", [
      { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
    ]),
    {
      type: "user",
      sessionId: "s5",
      timestamp: "2026-06-05T09:00:01Z",
      message: { role: "user", content: "hi" },
    },
    { type: "summary", summary: "noise" },
  ];
  const { decisions } = extractDecisions(records);
  assert.equal(decisions.length, 0);
});
