import { createHash } from "node:crypto";
import { TranscriptReviewError } from "./errors.js";
import type {
  CandidateBatch,
  DecisionCandidate,
  DroppedCandidate,
  LenientCandidateBatch,
  TaskCandidate,
} from "./models.js";
import {
  arrayValue,
  integer,
  literal,
  optionalString,
  record,
  stringValue,
  type UnknownRecord,
} from "./parse.js";

const TASK_SCHEDULE_DEFAULTS = {
  status: "Todo",
  sprint: "—",
  due: "—",
  linear: "—",
} as const;

function fallbackId(kind: "decision" | "task", substance: string, index: number): string {
  const digest = createHash("sha256").update(`${kind}\0${substance}\0${index}`).digest("hex");
  return `${kind}-${digest.slice(0, 16)}`;
}

function decisionCandidate(value: unknown, index: number, legacy: boolean): DecisionCandidate {
  const item = record(value, `decisions[${index}]`);
  const decision = stringValue(item["decision"], `decisions[${index}].decision`);
  const id = optionalString(item["id"], `decisions[${index}].id`);
  if (!legacy && id === undefined) {
    return decisionCandidate({ ...item, id: fallbackId("decision", decision, index) }, index, true);
  }
  const type = integer(item["type"], `decisions[${index}].type`, 1);
  if (type !== 1 && type !== 2 && type !== 3) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `decisions[${index}].type must be 1, 2, or 3`
    );
  }
  return {
    id: id ?? fallbackId("decision", decision, index),
    date: stringValue(item["date"], `decisions[${index}].date`),
    decision,
    rationale: stringValue(item["rationale"], `decisions[${index}].rationale`),
    decidedBy: stringValue(item["decidedBy"], `decisions[${index}].decidedBy`),
    impact: stringValue(item["impact"], `decisions[${index}].impact`),
    type,
    audience: literal(
      item["audience"],
      ["admin", "team", "external"] as const,
      `decisions[${index}].audience`
    ),
    transcript: stringValue(item["transcript"], `decisions[${index}].transcript`),
    sourceQuote: stringValue(item["sourceQuote"], `decisions[${index}].sourceQuote`),
  };
}

function taskCandidate(value: unknown, index: number, legacy: boolean): TaskCandidate {
  const item = record(value, `tasks[${index}]`);
  const task = stringValue(item["task"], `tasks[${index}].task`);
  const id = optionalString(item["id"], `tasks[${index}].id`);
  if (!legacy && id === undefined) {
    return taskCandidate({ ...item, id: fallbackId("task", task, index) }, index, true);
  }
  return {
    id: id ?? fallbackId("task", task, index),
    task,
    assignee: stringValue(item["assignee"], `tasks[${index}].assignee`),
    status: stringValue(item["status"], `tasks[${index}].status`),
    sprint: stringValue(item["sprint"], `tasks[${index}].sprint`),
    due: stringValue(item["due"], `tasks[${index}].due`),
    linear: stringValue(item["linear"], `tasks[${index}].linear`),
    transcript: stringValue(item["transcript"], `tasks[${index}].transcript`),
    sourceQuote: stringValue(item["sourceQuote"], `tasks[${index}].sourceQuote`),
  };
}

export function parseCandidateBatch(value: unknown, legacy = false): CandidateBatch {
  const batch = record(value, "candidate batch");
  return {
    decisions: arrayValue(batch["decisions"], "decisions").map((item, index) =>
      decisionCandidate(item, index, legacy)
    ),
    tasks: arrayValue(batch["tasks"], "tasks").map((item, index) =>
      taskCandidate(item, index, legacy)
    ),
  };
}

function scheduleValue(value: unknown, fallback: string): unknown {
  return value === undefined || (typeof value === "string" && value.trim().length === 0)
    ? fallback
    : value;
}

function normalizedPhaseTasks(batch: UnknownRecord): readonly unknown[] {
  return arrayValue(batch["tasks"], "tasks").map((value, index) => {
    const item = record(value, `tasks[${index}]`);
    return {
      ...item,
      status: scheduleValue(item["status"], TASK_SCHEDULE_DEFAULTS.status),
      sprint: scheduleValue(item["sprint"], TASK_SCHEDULE_DEFAULTS.sprint),
      due: scheduleValue(item["due"], TASK_SCHEDULE_DEFAULTS.due),
      linear: scheduleValue(item["linear"], TASK_SCHEDULE_DEFAULTS.linear),
    };
  });
}

export function parsePhaseCandidateBatch(value: unknown): CandidateBatch {
  const batch = record(value, "candidate batch");
  return parseCandidateBatch({ ...batch, tasks: normalizedPhaseTasks(batch) });
}

/**
 * A candidate whose `sourceQuote` field is missing/blank fails grounding by construction — it can
 * never pass TD1 (near-verbatim match against a transcript). Rather than hard-failing the whole
 * extract phase over one bad candidate (the historical behavior — `Promise.all` in
 * `extractCandidates` meant a single empty `sourceQuote` killed the entire batch), drop just that
 * candidate and continue. This mirrors `groundedCandidate()` in `scripts/transcript-extraction.mjs`
 * (the facts/stakeholders pipeline, AIO-494 "extraction contract v1.12"), ported here for
 * decisions/tasks. Any other malformed field still throws — only the empty-sourceQuote case is
 * forgiven; the schema itself stays strict (`sourceQuote` is not made optional).
 */
function isBlankSourceQuoteError(error: unknown, label: string): boolean {
  return (
    error instanceof TranscriptReviewError &&
    error.kind === "invalid_input" &&
    error.message === `${label} must be a non-empty string`
  );
}

export function parseLenientPhaseCandidateBatch(value: unknown): LenientCandidateBatch {
  const batch = record(value, "candidate batch");
  const dropped: DroppedCandidate[] = [];

  const decisions: DecisionCandidate[] = [];
  arrayValue(batch["decisions"], "decisions").forEach((raw, index) => {
    try {
      decisions.push(decisionCandidate(raw, index, false));
    } catch (error) {
      if (isBlankSourceQuoteError(error, `decisions[${index}].sourceQuote`)) {
        dropped.push({ kind: "decision", index, reason: "source_quote_empty" });
        return;
      }
      throw error;
    }
  });

  const tasks: TaskCandidate[] = [];
  normalizedPhaseTasks(batch).forEach((raw, index) => {
    try {
      tasks.push(taskCandidate(raw, index, false));
    } catch (error) {
      if (isBlankSourceQuoteError(error, `tasks[${index}].sourceQuote`)) {
        dropped.push({ kind: "task", index, reason: "source_quote_empty" });
        return;
      }
      throw error;
    }
  });

  return { batch: { decisions, tasks }, dropped };
}
