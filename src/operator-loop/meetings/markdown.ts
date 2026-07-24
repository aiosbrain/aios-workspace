import type { LiveLogIndex } from "./contracts.js";
import { TranscriptReviewError } from "./errors.js";
import type { DecisionCandidate, TaskCandidate } from "./models.js";

const DECISION_COLUMNS = [
  "#",
  "Date",
  "Decision",
  "Rationale",
  "Decided By",
  "Impact",
  "Type",
  "Audience",
] as const;
const TASK_COLUMNS = ["ID", "Task", "Assignee", "Status", "Sprint", "Due", "Linear"] as const;

export type LogKind = "decisions" | "tasks";

export function normalizeSubstance(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNearVerbatim(quote: string, transcript: string): boolean {
  const normalizedQuote = normalizeSubstance(quote);
  if (normalizedQuote.length === 0) return false;
  const normalizedTranscript = normalizeSubstance(transcript);
  return normalizedQuote.length >= 8
    ? normalizedTranscript.includes(normalizedQuote)
    : ` ${normalizedTranscript} `.includes(` ${normalizedQuote} `);
}

export function decisionKey(candidate: Pick<DecisionCandidate, "decision">): string {
  return normalizeSubstance(candidate.decision);
}

export function taskKey(candidate: Pick<TaskCandidate, "task" | "assignee">): string {
  return `${normalizeSubstance(candidate.task)}\0${normalizeSubstance(candidate.assignee)}`;
}

function escapeCell(value: string | number): string {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

export function renderDecisionRow(candidate: DecisionCandidate, row: number): string {
  return `| ${row} | ${escapeCell(candidate.date)} | ${escapeCell(candidate.decision)} | ${escapeCell(candidate.rationale)} | ${escapeCell(candidate.decidedBy)} | ${escapeCell(candidate.impact)} | ${candidate.type} | ${escapeCell(candidate.audience)} |\n`;
}

export function renderTaskRow(candidate: TaskCandidate, row: number): string {
  return `| TT${row} | ${escapeCell(candidate.task)} | ${escapeCell(candidate.assignee)} | ${escapeCell(candidate.status)} | ${escapeCell(candidate.sprint)} | ${escapeCell(candidate.due)} | ${escapeCell(candidate.linear)} |\n`;
}

function cells(line: string): readonly string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const result: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      result.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  result.push(current.trim());
  return result;
}

function sameColumns(actual: readonly string[] | null, expected: readonly string[]): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

type ParsedTable = {
  readonly lines: readonly string[];
  readonly insertAt: number;
  readonly rows: readonly (readonly string[])[];
};

function parseTable(content: string, kind: LogKind, filePath: string): ParsedTable {
  const expected = kind === "decisions" ? DECISION_COLUMNS : TASK_COLUMNS;
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => sameColumns(cells(line), expected));
  if (headerIndex < 0) {
    throw new TranscriptReviewError(
      "integrity",
      2,
      `${filePath} destination header does not match the required column order`
    );
  }
  const separator = cells(lines[headerIndex + 1] ?? "");
  if (
    separator === null ||
    separator.length !== expected.length ||
    !separator.every((value) => /^:?-{3,}:?$/.test(value))
  ) {
    throw new TranscriptReviewError("integrity", 2, `${filePath} has an invalid table separator`);
  }
  const rows: (readonly string[])[] = [];
  let insertAt = headerIndex + 2;
  while (insertAt < lines.length) {
    const row = cells(lines[insertAt] ?? "");
    if (row === null) break;
    if (row.length !== expected.length) {
      throw new TranscriptReviewError("integrity", 2, `${filePath} contains a malformed table row`);
    }
    rows.push(row);
    insertAt += 1;
  }
  return { lines, insertAt, rows };
}

export function parseLiveLog(content: string, kind: LogKind, filePath: string): LiveLogIndex {
  const table = parseTable(content, kind, filePath);
  const keys = table.rows.map((row) =>
    kind === "decisions"
      ? normalizeSubstance(row[2] ?? "")
      : `${normalizeSubstance(row[1] ?? "")}\0${normalizeSubstance(row[2] ?? "")}`
  );
  const numbers = table.rows.map((row) => {
    const raw = row[0] ?? "";
    return Number(kind === "decisions" ? raw : raw.replace(/^TT/i, ""));
  });
  const validNumbers = numbers.filter((number) => Number.isSafeInteger(number) && number >= 0);
  return {
    path: filePath,
    content,
    keys,
    nextNumber: Math.max(0, ...validNumbers) + 1,
  };
}

export type RowInsertion = {
  readonly content: string;
  readonly kind: LogKind;
  readonly filePath: string;
  readonly rows: string;
};

export function insertRows(insertion: RowInsertion): string {
  if (insertion.rows.length === 0) return insertion.content;
  const table = parseTable(insertion.content, insertion.kind, insertion.filePath);
  const additions = insertion.rows.endsWith("\n")
    ? insertion.rows.slice(0, -1).split("\n")
    : insertion.rows.split("\n");
  const output = [...table.lines];
  output.splice(table.insertAt, 0, ...additions);
  return output.join("\n");
}
