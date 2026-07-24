import type {
  ApplyRecord,
  MigrationProvenance,
  PushAttempt,
  PushRecord,
  ReviewDiagnostic,
  ReviewLoop,
  TranscriptMetadata,
  TranscriptReviewStageV2,
} from "./models.js";
import { parseCandidateBatch } from "./candidate-schema.js";
import { assertNever, TranscriptReviewError } from "./errors.js";
import { parseGradeReport } from "./report-schema.js";
import {
  arrayValue,
  booleanValue,
  integer,
  jsonValue,
  literal,
  optionalString,
  record,
  stringValue,
} from "./parse.js";

export type LegacyTranscriptStageV1 = {
  readonly version: 1;
  readonly access: "admin";
  readonly status: "pending_review";
  readonly createdAt: string;
  readonly transcripts: readonly string[];
  readonly decisions: TranscriptReviewStageV2["decisions"];
  readonly tasks: TranscriptReviewStageV2["tasks"];
};

function diagnostic(value: unknown, label: string): ReviewDiagnostic {
  const item = record(value, label);
  return {
    phase: stringValue(item["phase"], `${label}.phase`),
    message: stringValue(item["message"], `${label}.message`),
  };
}

function diagnostics(value: unknown, label: string): readonly ReviewDiagnostic[] {
  return arrayValue(value, label).map((item, index) => diagnostic(item, `${label}[${index}]`));
}

function transcript(value: unknown, label: string): TranscriptMetadata {
  const item = record(value, label);
  const sha256 = stringValue(item["sha256"], `${label}.sha256`);
  if (!/^[a-f\d]{64}$/.test(sha256)) {
    throw new TranscriptReviewError("invalid_input", 2, `${label}.sha256 is invalid`);
  }
  return {
    path: stringValue(item["path"], `${label}.path`),
    sha256,
    bytes: integer(item["bytes"], `${label}.bytes`),
    chars: integer(item["chars"], `${label}.chars`),
  };
}

function loop(value: unknown, label: string): ReviewLoop {
  const item = record(value, label);
  const counts = record(item["candidateCounts"], `${label}.candidateCounts`);
  return {
    attempt: integer(item["attempt"], `${label}.attempt`),
    candidateCounts: {
      decisions: integer(counts["decisions"], `${label}.candidateCounts.decisions`),
      tasks: integer(counts["tasks"], `${label}.candidateCounts.tasks`),
    },
    gradeReport: parseGradeReport(item["gradeReport"]),
  };
}

function pushAttempt(value: unknown, label: string): PushAttempt {
  const item = record(value, label);
  return {
    id: stringValue(item["id"], `${label}.id`),
    state: literal(item["state"], ["pending", "failed", "succeeded"] as const, `${label}.state`),
    at: stringValue(item["at"], `${label}.at`),
    diagnostics: diagnostics(item["diagnostics"], `${label}.diagnostics`),
  };
}

function pushRecord(value: unknown): PushRecord {
  const item = record(value, "push");
  return {
    state: literal(
      item["state"],
      ["not_requested", "skipped", "pending", "failed", "succeeded"] as const,
      "push.state"
    ),
    attempts: arrayValue(item["attempts"], "push.attempts").map((attempt, index) =>
      pushAttempt(attempt, `push.attempts[${index}]`)
    ),
  };
}

function migration(value: unknown): MigrationProvenance | undefined {
  if (value === undefined) return undefined;
  const item = record(value, "migration");
  const version = integer(item["sourceVersion"], "migration.sourceVersion", 1);
  if (version !== 1) {
    throw new TranscriptReviewError("invalid_input", 2, "migration.sourceVersion must be 1");
  }
  return {
    sourcePath: stringValue(item["sourcePath"], "migration.sourcePath"),
    sourceDigest: stringValue(item["sourceDigest"], "migration.sourceDigest"),
    sourceVersion: 1,
  };
}

function applyRecord(value: unknown): ApplyRecord {
  const item = record(value, "apply");
  return {
    approvedAt: stringValue(item["approvedAt"], "apply.approvedAt"),
    decisionsAdded: integer(item["decisionsAdded"], "apply.decisionsAdded"),
    tasksAdded: integer(item["tasksAdded"], "apply.tasksAdded"),
    decisionLogChanged: booleanValue(item["decisionLogChanged"], "apply.decisionLogChanged"),
    taskLogChanged: booleanValue(item["taskLogChanged"], "apply.taskLogChanged"),
  };
}

export function parseTranscriptReviewStage(input: string | unknown): TranscriptReviewStageV2 {
  const value = typeof input === "string" ? jsonValue(input) : input;
  const item = record(value, "transcript review stage");
  const version = integer(item["version"], "version", 2);
  if (version !== 2) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `stage version must be v2, received v${version}`
    );
  }
  const status = literal(
    item["status"],
    ["pending_review", "failed_rubric", "grading_error", "approved"] as const,
    "status"
  );
  const candidates = parseCandidateBatch(item);
  const rubricBudget = integer(item["rubricBudget"], "rubricBudget");
  const loopsUsed = integer(item["loopsUsed"], "loopsUsed");
  if (loopsUsed > rubricBudget) {
    throw new TranscriptReviewError("invalid_input", 2, "loopsUsed exceeds rubricBudget");
  }
  const reviewDigest = stringValue(item["reviewDigest"], "reviewDigest");
  if (!/^[a-f\d]{64}$/.test(reviewDigest)) {
    throw new TranscriptReviewError("invalid_input", 2, "reviewDigest must be a SHA-256 digest");
  }
  const transcripts = arrayValue(item["transcripts"], "transcripts").map((entry, index) =>
    transcript(entry, `transcripts[${index}]`)
  );
  if (transcripts.length === 0) {
    throw new TranscriptReviewError("invalid_input", 2, "transcripts must not be empty");
  }
  const gradeReport = parseGradeReport(item["gradeReport"]);
  const expectedVerdict =
    status === "failed_rubric" ? "fail" : status === "grading_error" ? "error" : "pass";
  if (gradeReport.verdict !== expectedVerdict) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `${status} stage requires a ${expectedVerdict} grade report`
    );
  }
  const common = {
    version: 2 as const,
    id: stringValue(item["id"], "id"),
    createdAt: stringValue(item["createdAt"], "createdAt"),
    access: literal(item["access"], ["admin"] as const, "access"),
    ...candidates,
    transcripts,
    rubricBudget,
    loopsUsed,
    loops: arrayValue(item["loops"], "loops").map((entry, index) => loop(entry, `loops[${index}]`)),
    gradeReport,
    diagnostics: diagnostics(item["diagnostics"], "diagnostics"),
    push: pushRecord(item["push"]),
    reviewDigest,
    migration: migration(item["migration"]),
  };
  switch (status) {
    case "pending_review":
      return { ...common, status };
    case "failed_rubric":
      return { ...common, status };
    case "grading_error":
      return { ...common, status };
    case "approved":
      return { ...common, status, apply: applyRecord(item["apply"]) };
    default:
      return assertNever(status);
  }
}

export function parseLegacyTranscriptStageV1(input: string | unknown): LegacyTranscriptStageV1 {
  const value = typeof input === "string" ? jsonValue(input) : input;
  const item = record(value, "legacy transcript stage");
  const version = integer(item["version"], "version", 1);
  if (version !== 1) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `legacy stage must be v1, received v${version}`
    );
  }
  const candidates = parseCandidateBatch(item, true);
  return {
    version: 1,
    access: literal(item["access"], ["admin"] as const, "access"),
    status: literal(item["status"], ["pending_review"] as const, "status"),
    createdAt: stringValue(item["createdAt"], "createdAt"),
    transcripts: arrayValue(item["transcripts"], "transcripts").map((entry, index) =>
      stringValue(entry, `transcripts[${index}]`)
    ),
    ...candidates,
  };
}

export function stageVersion(value: unknown): 1 | 2 | null {
  if (typeof value !== "object" || value === null || !("version" in value)) return null;
  return value.version === 1 || value.version === 2 ? value.version : null;
}
