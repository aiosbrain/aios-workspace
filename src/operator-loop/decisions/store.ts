// Decisions store (AIO-170 / EE4) — an append-only NDJSON log of human-in-the-loop decision
// prompts (AskUserQuestion + plan approvals), folded to state on read. A durable learning/training
// corpus: every question Claude asked the operator, the options offered, and the choice made.
//
// Mirrors the EE1 asks store (src/operator-loop/asks/store.ts) exactly in posture — local-only,
// admin-tier, gitignored under .aios/loop/, never synced — with the SAME writer-honored lockfile
// protocol (copied deliberately: a small amount of duplication keeps each module bounded, and the
// asks store is not refactored). Two ops:
//   • `create` — a decision record; decisions are NEVER mutated (first create wins on a dup id).
//   • `outcome` — an append that annotates a decision's outcome (last outcome wins on fold).
//
// Two invariants shape the code:
//   • The line schema is a v1 contract — the dependency-free capture hook reimplements the create
//     writer + lock protocol, and a parity test proves hook-written lines fold identically here.
//   • Reads NEVER silently drop a non-empty line: malformed / unknown-version / unknown-id ops /
//     duplicate create ids surface as warnings (returned, never swallowed).

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Tier } from "../signal.js";

export const DECISIONS_STORE_REL = ".aios/loop/decisions/decisions.ndjson";
export const DECISIONS_SCHEMA_VERSION = 1;

const LOCK_STALE_MS = 30_000;
// ~1s of bounded retries — generous enough to ride out CPU contention from many concurrent
// writers, still far below the 30s stale threshold so a truly dead lock is reclaimed, not waited on.
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;

const QUESTION_MAX = 500;
const HEADER_MAX = 200;
const NOTES_MAX = 2000;
const OUTCOME_MAX = 2000;
const OPTION_LABEL_MAX = 200;
const OPTION_DESC_MAX = 1000;
const KIND_MAX = 40;
// Bound the option / choice arrays so a pathological payload can't blow up a single line.
const OPTIONS_MAX = 50;
const CHOICE_MAX = 50;

// Any control char (C0 range + DEL) — collapsed to a space so a single-line field stays one line.
// eslint-disable-next-line no-control-regex -- intentional: sanitize control chars from single-line fields
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

const TIERS: ReadonlySet<string> = new Set<Tier>(["admin", "team", "external"]);

export type DecisionOp = "create" | "outcome";

export interface DecisionOption {
  label: string;
  description: string | null;
}

export interface DecisionContext {
  sessionId: string | null;
  project: string | null;
  transcriptPath: string | null;
  cwd: string | null;
}

/** The persisted create-line payload (no fold-derived outcome fields). */
export interface DecisionRecord {
  id: string;
  kind: "ask-user-question" | "plan-approval" | (string & {});
  question: string;
  header: string | null;
  options: DecisionOption[];
  choice: string[] | null;
  notes: string | null;
  context: DecisionContext;
  tier: Tier;
  createdAt: string;
}

/** A folded decision: the stored record + the fold-derived outcome annotation. */
export interface Decision extends DecisionRecord {
  outcome: string | null;
  outcomeAt: string | null;
}

/** Shape callers pass to `appendDecision`; `id`/`createdAt` are stamped, the rest normalized. */
export interface DecisionInput {
  kind: string;
  question: string;
  header?: string | null;
  options?: DecisionOption[] | null;
  choice?: string[] | string | null;
  notes?: string | null;
  context?: Partial<DecisionContext> | null;
  tier?: Tier;
  createdAt?: string;
  id?: string;
}

export interface FoldWarning {
  line: number;
  reason: string;
}
export interface FoldResult {
  decisions: Decision[];
  warnings: FoldWarning[];
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function storePath(root: string): string {
  return path.join(root, DECISIONS_STORE_REL);
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSingleLine(raw: unknown, max: number): string {
  return String(raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeMultiline(raw: unknown, max: number): string {
  return String(raw ?? "").slice(0, max);
}

function normalizeKind(raw: unknown): string {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KIND_MAX);
  return k || "decision";
}

function normalizeHeader(raw: unknown): string | null {
  if (raw == null) return null;
  const h = normalizeSingleLine(raw, HEADER_MAX);
  return h || null;
}

function normalizeNotes(raw: unknown): string | null {
  if (raw == null) return null;
  const n = normalizeMultiline(raw, NOTES_MAX);
  return n || null;
}

function normalizeOptions(raw: unknown): DecisionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionOption[] = [];
  for (const o of raw.slice(0, OPTIONS_MAX)) {
    if (!isRecord(o)) continue;
    const label = normalizeSingleLine(o.label, OPTION_LABEL_MAX);
    if (!label) continue;
    const descRaw = o.description;
    const description =
      descRaw == null ? null : normalizeMultiline(descRaw, OPTION_DESC_MAX) || null;
    out.push({ label, description });
  }
  return out;
}

function normalizeChoice(raw: unknown): string[] | null {
  if (raw == null) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const c of arr.slice(0, CHOICE_MAX)) {
    const label = normalizeSingleLine(c, OPTION_LABEL_MAX);
    if (label) out.push(label);
  }
  return out.length ? out : null;
}

function normalizeContext(raw: Partial<DecisionContext> | null | undefined): DecisionContext {
  const r = raw ?? {};
  return {
    sessionId: asStr(r.sessionId) ?? null,
    project: asStr(r.project) ?? null,
    transcriptPath: asStr(r.transcriptPath) ?? null,
    cwd: asStr(r.cwd) ?? null,
  };
}

function resolveCreatedAt(raw: string | undefined): string {
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/** Build a normalized, validated DecisionRecord. Throws on an invalid tier (an entry-point
 *  contract violation), so a bad CLI/transport call fails loud rather than writing garbage. */
export function buildDecisionRecord(input: DecisionInput): DecisionRecord {
  const tier = input.tier ?? "admin";
  if (!TIERS.has(tier)) {
    throw new Error(`decisions: invalid tier "${tier}" (expected admin|team|external)`);
  }
  return {
    id: input.id ?? randomUUID(),
    kind: normalizeKind(input.kind),
    question: normalizeSingleLine(input.question, QUESTION_MAX),
    header: normalizeHeader(input.header),
    options: normalizeOptions(input.options),
    choice: normalizeChoice(input.choice),
    notes: normalizeNotes(input.notes),
    context: normalizeContext(input.context),
    tier,
    createdAt: resolveCreatedAt(input.createdAt),
  };
}

// ── lock ─────────────────────────────────────────────────────────────────────────────────────────
// Copied verbatim in posture from the EE1 asks store (a plain-append subset — decisions never
// rewrite the store, so no ownsLock() re-check is needed). Kept local to keep the module bounded.

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lockfile next to the store. Bounded retries; a stale lock
 * (mtime older than LOCK_STALE_MS) is reclaimed. Throws if the lock cannot be acquired — callers
 * decide whether that is fatal (CLI: die) or skippable (hook: silent no-op). The lock is always
 * released, even if `fn` throws. Only appends run under this lock (a single O_APPEND write cannot
 * clobber other lines), so there is no rewrite / compare-and-swap to race.
 */
export function withLock<T>(root: string, fn: () => T): T {
  const lockPath = storePath(root) + ".lock";
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let fd: number | null = null;
  for (let attempt = 0; attempt <= LOCK_RETRIES && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Someone holds it. Reclaim if stale, otherwise back off and retry.
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = false; // lock vanished between open and stat — just retry
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* lost the race to reclaim — fall through to retry */
        }
        continue; // retry immediately without consuming a backoff slot
      }
      if (attempt < LOCK_RETRIES) sleepSync(LOCK_DELAY_MS);
    }
  }
  if (fd === null) throw new Error(`decisions: could not acquire store lock (${lockPath})`);
  // Token-only release check: never delete a reclaimer's lock (one whose token no longer matches).
  const tokenMatches = (): boolean => {
    try {
      return readFileSync(lockPath, "utf8").includes(token);
    } catch {
      return false;
    }
  };
  try {
    try {
      writeFileSync(fd, `${process.pid} ${token} ${new Date().toISOString()}\n`);
    } catch {
      /* advisory stamp only */
    }
    closeSync(fd);
    return fn();
  } finally {
    try {
      if (tokenMatches()) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

// ── fold (pure) ────────────────────────────────────────────────────────────────────────────────

function coerceRecord(decision: unknown): DecisionRecord | null {
  if (!isRecord(decision)) return null;
  const id = asStr(decision.id);
  if (!id) return null;
  const createdAt = asStr(decision.createdAt);
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  const tierRaw = asStr(decision.tier) ?? "admin";
  const tier = (TIERS.has(tierRaw) ? tierRaw : "admin") as Tier;
  return {
    id,
    kind: normalizeKind(decision.kind),
    question: normalizeSingleLine(decision.question, QUESTION_MAX),
    header: normalizeHeader(decision.header),
    options: normalizeOptions(decision.options),
    choice: normalizeChoice(decision.choice),
    notes: normalizeNotes(decision.notes),
    context: normalizeContext(isRecord(decision.context) ? decision.context : null),
    tier,
    createdAt,
  };
}

/**
 * Fold NDJSON lines to the current decision state, in order. Pure — no I/O. First create wins on a
 * duplicate id; unknown-id outcome ops and malformed/unknown-version lines are warnings. A later
 * `outcome` op annotates the matching decision (last outcome wins). Returns decisions in creation
 * order.
 */
export function foldDecisionLines(lines: readonly string[]): FoldResult {
  const byId = new Map<string, Decision>();
  const order: string[] = [];
  const warnings: FoldWarning[] = [];

  lines.forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return; // blank → ignore

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      warnings.push({ line, reason: "malformed-json" });
      return;
    }
    if (!isRecord(parsed)) {
      warnings.push({ line, reason: "not-an-object" });
      return;
    }
    if (parsed.v !== DECISIONS_SCHEMA_VERSION) {
      warnings.push({ line, reason: "unknown-version" });
      return;
    }

    const op = asStr(parsed.op);
    if (op === "create") {
      const rec = coerceRecord(parsed.decision);
      if (!rec) {
        warnings.push({ line, reason: "invalid-create" });
        return;
      }
      if (byId.has(rec.id)) {
        warnings.push({ line, reason: "duplicate-create-id" }); // first create wins
        return;
      }
      byId.set(rec.id, { ...rec, outcome: null, outcomeAt: null });
      order.push(rec.id);
      return;
    }
    if (op === "outcome") {
      const id = asStr(parsed.id);
      if (!id || !byId.has(id)) {
        warnings.push({ line, reason: "unknown-id-outcome" });
        return;
      }
      const dec = byId.get(id) as Decision;
      dec.outcome = normalizeMultiline(parsed.outcome, OUTCOME_MAX) || null;
      const at = asStr(parsed.at);
      dec.outcomeAt = at && Number.isFinite(Date.parse(at)) ? at : new Date().toISOString();
      return;
    }
    warnings.push({ line, reason: "unknown-op" });
  });

  return { decisions: order.map((id) => byId.get(id) as Decision), warnings };
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

/** Read + fold the store. Missing file → empty. An unreadable existing file → one warning. */
export function readDecisions(root: string): FoldResult {
  const abs = storePath(root);
  if (!existsSync(abs)) return { decisions: [], warnings: [] };
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return { decisions: [], warnings: [{ line: 0, reason: "unreadable" }] };
  }
  return foldDecisionLines(raw.split(/\r?\n/));
}

// ── write (lock-protected appends) ──────────────────────────────────────────────────────────────

function createLine(rec: DecisionRecord): string {
  return JSON.stringify({ v: DECISIONS_SCHEMA_VERSION, op: "create", decision: rec });
}
function outcomeLine(id: string, outcome: string, at: string): string {
  return JSON.stringify({ v: DECISIONS_SCHEMA_VERSION, op: "outcome", id, outcome, at });
}

/** Normalize + validate, then append one create line under the lock. Returns the stored record. */
export function appendDecision(root: string, input: DecisionInput): DecisionRecord {
  const rec = buildDecisionRecord(input);
  withLock(root, () => appendFileSync(storePath(root), createLine(rec) + "\n"));
  return rec;
}

/**
 * Append an outcome annotation for `id` under the lock (a decision is never mutated — the outcome
 * is a separate append folded onto the record; last outcome wins). Existence is the caller's
 * concern (the CLI validates the id before calling). The outcome text is truncated to 2000 chars.
 */
export function appendOutcome(
  root: string,
  id: string,
  outcome: string,
  at: string = new Date().toISOString()
): void {
  const text = normalizeMultiline(outcome, OUTCOME_MAX);
  withLock(root, () => appendFileSync(storePath(root), outcomeLine(id, text, at) + "\n"));
}
