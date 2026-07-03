// Hook ↔ backfill parity (AIO-192) — the SAME decision moment, expressed as (a) a live PostToolUse
// payload through the capture hook binary, and (b) the equivalent transcript record sequence through
// the pure extractor + the deduped batch writer, must produce equivalent store records (modulo
// source / context / timestamps). Extends the EE4 fold-parity guarantee across representations.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDecisions, appendDecisionsDeduped } from "../../dist/operator-loop/index.js";
import { extractDecisions } from "../../scripts/decision-extract.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "decision-capture.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "parity-"));
}
function runHook(dir, payload) {
  execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function core(d) {
  return { kind: d.kind, question: d.question, header: d.header, options: d.options, choice: d.choice, notes: d.notes };
}

test("AskUserQuestion: hook capture and backfill extraction produce equivalent records", () => {
  const hookDir = ws();
  const bfDir = ws();
  try {
    // (a) Live hook path.
    runHook(hookDir, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      session_id: "sess-parity",
      cwd: "/repo",
      tool_input: { questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "relational" }, { label: "Mongo", description: "document" }] }] },
      tool_response: { answers: [{ question: "Which database?", answer: "Postgres", notes: "cheaper" }] },
    });
    const hookRec = readDecisions(hookDir).decisions[0];

    // (b) Backfill path: the same moment as a transcript sequence.
    const records = [
      { type: "assistant", sessionId: "sess-parity", timestamp: "2026-06-01T10:00:00Z", cwd: "/repo", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: { questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "relational" }, { label: "Mongo", description: "document" }] }] } }] } },
      { type: "user", sessionId: "sess-parity", timestamp: "2026-06-01T10:00:05Z", cwd: "/repo", toolUseResult: { answers: [{ question: "Which database?", answer: "Postgres", notes: "cheaper" }] }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
    ];
    const { decisions } = extractDecisions(records);
    appendDecisionsDeduped(bfDir, decisions);
    const bfRec = readDecisions(bfDir).decisions[0];

    assert.deepEqual(core(bfRec), core(hookRec), "the decision core matches across representations");
    assert.equal(bfRec.source, "backfill");
    assert.equal(hookRec.source, null, "the live hook does not stamp a source");
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
    rmSync(bfDir, { recursive: true, force: true });
  }
});

test("ExitPlanMode: hook capture and backfill extraction agree on the plan-approval record", () => {
  const hookDir = ws();
  const bfDir = ws();
  try {
    runHook(hookDir, {
      hook_event_name: "PostToolUse",
      tool_name: "ExitPlanMode",
      session_id: "sess-plan",
      cwd: "/repo",
      tool_input: { plan: "# Ship the billing module\n\nStep 1" },
      tool_response: "User has approved your plan.",
    });
    const hookRec = readDecisions(hookDir).decisions[0];

    const records = [
      { type: "assistant", sessionId: "sess-plan", timestamp: "2026-06-01T10:00:00Z", cwd: "/repo", message: { role: "assistant", content: [{ type: "tool_use", id: "tp1", name: "ExitPlanMode", input: { plan: "# Ship the billing module\n\nStep 1" } }] } },
      { type: "user", sessionId: "sess-plan", timestamp: "2026-06-01T10:00:05Z", cwd: "/repo", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tp1", content: "User has approved your plan." }] } },
    ];
    const { decisions } = extractDecisions(records);
    appendDecisionsDeduped(bfDir, decisions);
    const bfRec = readDecisions(bfDir).decisions[0];

    assert.deepEqual(core(bfRec), core(hookRec));
    assert.equal(bfRec.question, "Plan approval: Ship the billing module");
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
    rmSync(bfDir, { recursive: true, force: true });
  }
});
