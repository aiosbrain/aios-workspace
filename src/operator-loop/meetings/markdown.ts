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

/** Drop YAML frontmatter and speaker-turn markdown before grounding checks. */
export function stripTranscriptMarkup(content: string): string {
  let body = content;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end >= 0) body = body.slice(end + 5);
  }
  return body
    .replace(/\*\*[^*\n]+:\*\*/g, " ")
    .replace(/^#+ .+$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function substanceTokens(value: string): readonly string[] {
  const normalized = normalizeSubstance(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** Split a transcript into normalized speaker turns (frontmatter/headings dropped). */
export function splitTranscriptTurns(content: string): readonly string[] {
  let body = content;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end >= 0) body = body.slice(end + 5);
  }
  return body
    .replace(/^#+ .+$/gm, "\u0000")
    .replace(/\*\*[^*\n]+:\*\*/g, "\u0000")
    .split("\u0000")
    .map((turn) => normalizeSubstance(turn))
    .filter((turn) => turn.length > 0);
}

// A continuation may skip at most this many interjection turns between chunks;
// unbounded skipping would let a quote stitch words from unrelated turns.
const MAX_SKIPPED_TURNS_PER_GAP = 2;

function tokensEqualAt(
  haystack: readonly string[],
  haystackStart: number,
  needle: readonly string[],
  needleStart: number,
  length: number
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (haystack[haystackStart + offset] !== needle[needleStart + offset]) return false;
  }
  return true;
}

function continuesAcrossTurns(
  quoteTokens: readonly string[],
  consumed: number,
  turns: readonly (readonly string[])[],
  from: number
): boolean {
  const lastCandidate = Math.min(turns.length - 1, from + MAX_SKIPPED_TURNS_PER_GAP);
  for (let index = from; index <= lastCandidate; index += 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    const rest = quoteTokens.length - consumed;
    // Final chunk: the remainder of the quote opens this turn.
    if (turn.length >= rest && tokensEqualAt(turn, 0, quoteTokens, consumed, rest)) return true;
    // Middle chunk: this whole turn is the next stretch of the quote.
    if (
      turn.length < rest &&
      tokensEqualAt(turn, 0, quoteTokens, consumed, turn.length) &&
      continuesAcrossTurns(quoteTokens, consumed + turn.length, turns, index + 1)
    ) {
      return true;
    }
    // Otherwise skip this turn as an interjection (bounded by lastCandidate).
  }
  return false;
}

/**
 * True when the quote reads as one contiguous utterance whose turn was split by
 * transcript markup: a suffix of one turn, optionally whole intermediate turns,
 * then a prefix of a later turn. Chunks must anchor to turn boundaries — a match
 * may never resume mid-turn, so tokens dropped from inside a turn (e.g. a
 * negation) can never be skipped over.
 */
export function isCrossTurnContinuation(quote: string, transcript: string): boolean {
  const quoteTokens = substanceTokens(quote);
  if (quoteTokens.length === 0) return false;
  const turns = splitTranscriptTurns(transcript).map((turn) => turn.split(" "));
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    for (let start = 0; start < turn.length; start += 1) {
      // Whole quote contiguous inside this turn.
      if (
        turn.length - start >= quoteTokens.length &&
        tokensEqualAt(turn, start, quoteTokens, 0, quoteTokens.length)
      ) {
        return true;
      }
      // Opening chunk: the quote begins with this turn's tail, then continues.
      const suffixLength = turn.length - start;
      if (
        suffixLength < quoteTokens.length &&
        tokensEqualAt(turn, start, quoteTokens, 0, suffixLength) &&
        continuesAcrossTurns(quoteTokens, suffixLength, turns, index + 1)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isNearVerbatim(quote: string, transcript: string): boolean {
  const normalizedQuote = normalizeSubstance(quote);
  if (normalizedQuote.length === 0) return false;
  const normalizedTranscript = normalizeSubstance(stripTranscriptMarkup(transcript));
  if (normalizedQuote.length >= 8) {
    if (normalizedTranscript.includes(normalizedQuote)) return true;
    // Granola-style turn files often split one sentence across speaker blocks
    // (e.g. "...on the front" / "page."). Accept only boundary-anchored
    // continuations — never free token subsequences, which would let a quote
    // skip words (e.g. a negation) inside a turn.
    return isCrossTurnContinuation(quote, transcript);
  }
  return ` ${normalizedTranscript} `.includes(` ${normalizedQuote} `);
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
