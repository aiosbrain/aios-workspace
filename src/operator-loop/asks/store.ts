// Asks store (AIO-167) — an append-only NDJSON escalation queue folded to state on read.
//
// Mirrors the C8 telemetry ledger pattern (local-only, admin-tier, gitignored under .aios/loop/,
// never synced) with ONE addition: a writer-honored lockfile. Every writer (CLI, hook, transport)
// acquires the lock before appending, and maintenance (compaction/GC) holds the SAME lock across
// the fold → temp → rename rewrite. Because every append honors the lock, no line can be lost
// during a rewrite — there is no optimistic-rename compare-and-swap to race.
//
// Two invariants shape the code:
//   • The line schema is a v1 contract — the dependency-free capture hook reimplements the create
//     writer + lock protocol, and a parity test proves hook-written lines fold identically here.
//   • Reads NEVER silently drop a non-empty line: malformed / unknown-version / unknown-id ops /
//     duplicate create ids surface as warnings (returned, never swallowed).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Tier } from "../signal.js";

const require = createRequire(import.meta.url);
const recoveryPolicy = require(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "hooks",
    "asks-claim-recovery.cjs"
  )
) as {
  claimRecoveryDecision: (claim: unknown, nowMs: number) => "recover" | "busy";
  processIdentity: (pid: number) => string | null;
};

export const ASKS_STORE_REL = ".aios/loop/asks/asks.ndjson";
export const ASKS_SCHEMA_VERSION = 1;
export const RESOLVED_GC_DAYS = 7;
export const OPEN_SOFT_CAP = 500;
/** Open asks older than this (with a sessionId) are orphaned by `drain`. */
export const OPEN_STALE_DAYS = 14;

const LOCK_STALE_MS = 30_000;
// ~1s of bounded retries — generous enough to ride out CPU contention from many concurrent
// writers, still far below the 30s stale threshold so a truly dead lock is reclaimed, not waited on.
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;
const TITLE_MAX = 200;
const BODY_MAX = 2000;
const KIND_MAX = 40;
const DAY_MS = 86_400_000;
/** Safely exceeds the GUI's enforced 120-second SDK abort window. */
export const REPLY_CLAIM_LEASE_MS = 5 * 60_000;
// Any control char (C0 range + DEL) — collapsed to a space so a title is always one clean line.
// eslint-disable-next-line no-control-regex -- intentional: sanitize control chars from a title
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

const SEVERITIES: ReadonlySet<string> = new Set(["blocker", "decision", "fyi"]);
const TIERS: ReadonlySet<string> = new Set<Tier>(["admin", "team", "external"]);

export type AskSeverity = "blocker" | "decision" | "fyi";
export type AskStatus = "open" | "resolved" | "orphaned" | "archived";
export type AskOp = "resolve" | "orphan" | "archive";

/** The persisted create-line payload (no fold-derived fields). */
export interface AskRecord {
  id: string;
  dedupeKey: string | null;
  kind: string;
  severity: AskSeverity;
  title: string;
  body: string;
  ref: string | null;
  source: string;
  sessionId: string | null;
  tailHash: string | null;
  transcriptPath: string | null;
  tier: Tier;
  createdAt: string;
}

/** A folded ask: the stored record + the fold-derived lifecycle state. */
export interface Ask extends AskRecord {
  status: AskStatus;
  resolvedAt: string | null;
  replyClaim?: {
    token: string;
    claimedAt: string;
    expiresAt: string;
    ownerPid: number | null;
    ownerIdentity: string | null;
  } | null;
  reconcileAfter?: string | null;
}

export type ReplyClaimResult = "claimed" | "missing" | "closed" | "busy";
export type ReplyCompletionResult = "resolved" | "missing" | "closed" | "claim-mismatch";
export type ArchiveResult = "archived" | "already-archived" | "missing" | "closed" | "busy";
export type AskReconcileResult = "resolved" | "missing" | "closed" | "busy" | "stale-evidence";

/** Shape callers pass to `appendCreate`; `id`/`createdAt` are stamped, the rest normalized. */
export interface AskInput {
  kind: string;
  severity: AskSeverity;
  title: string;
  body?: string;
  ref?: string | null;
  source: string;
  dedupeKey?: string | null;
  sessionId?: string | null;
  tailHash?: string | null;
  transcriptPath?: string | null;
  tier?: Tier;
  createdAt?: string;
  id?: string;
}

export interface FoldWarning {
  line: number;
  reason: string;
}
export interface FoldResult {
  asks: Ask[];
  warnings: FoldWarning[];
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function storePath(root: string): string {
  return path.join(root, ASKS_STORE_REL);
}

function normalizeKind(raw: string): string {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KIND_MAX);
  return k || "general";
}

function normalizeTitle(raw: string): string {
  return String(raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
}

function normalizeBody(raw: string | undefined): string {
  return String(raw ?? "").slice(0, BODY_MAX);
}

function resolveCreatedAt(raw: string | undefined): string {
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build a normalized, validated AskRecord. Throws on an invalid severity/tier (an entry-point
 *  contract violation), so a bad CLI/transport call fails loud rather than writing garbage. */
export function buildRecord(input: AskInput): AskRecord {
  if (!SEVERITIES.has(input.severity)) {
    throw new Error(`asks: invalid severity "${input.severity}" (expected blocker|decision|fyi)`);
  }
  const tier = input.tier ?? "admin";
  if (!TIERS.has(tier)) {
    throw new Error(`asks: invalid tier "${tier}" (expected admin|team|external)`);
  }
  return {
    id: input.id ?? randomUUID(),
    dedupeKey: input.dedupeKey ?? null,
    kind: normalizeKind(input.kind),
    severity: input.severity,
    title: normalizeTitle(input.title),
    body: normalizeBody(input.body),
    ref: input.ref ?? null,
    source: input.source,
    sessionId: input.sessionId ?? null,
    tailHash: input.tailHash ?? null,
    transcriptPath: input.transcriptPath ?? null,
    tier,
    createdAt: resolveCreatedAt(input.createdAt),
  };
}

// ── lock ─────────────────────────────────────────────────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lockfile next to the store. Bounded retries; a stale lock
 * (mtime older than LOCK_STALE_MS) is reclaimed. Throws if the lock cannot be acquired — callers
 * decide whether that is fatal (CLI: die) or skippable (hook: silent no-op). The lock is always
 * released, even if `fn` throws.
 *
 * `fn` receives `ownsLock()`: true iff the lockfile still carries this holder's token. A holder
 * that overruns LOCK_STALE_MS can have its lock reclaimed by another writer; any operation that
 * REWRITES the store (compaction) must confirm ownership immediately before its rename and abort
 * if reclaimed, so a reclaimer's fresh appends are never overwritten. Plain appends need no check
 * (a single O_APPEND write cannot clobber other lines).
 */
export function withLock<T>(root: string, fn: (ownsLock: () => boolean) => T): T {
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
  if (fd === null) throw new Error(`asks: could not acquire store lock (${lockPath})`);
  // Token still ours AND not yet reclaimable: a lock past LOCK_STALE_MS is treated as lost even
  // before anyone reclaims it, so a stalled holder aborts its rewrite instead of racing a future
  // reclaimer between this check and the rename.
  const ownsLock = (): boolean => {
    try {
      if (!readFileSync(lockPath, "utf8").includes(token)) return false;
      return Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS;
    } catch {
      return false; // lock gone or unreadable — assume reclaimed
    }
  };
  // Token-only (no freshness): releasing our own stale lock is safe while the token matches —
  // nobody has reclaimed it yet, and deleting it just lets the next writer in sooner.
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
      /* stamp failed — ownsLock() will report false, so rewrites abort conservatively */
    }
    closeSync(fd);
    return fn(ownsLock);
  } finally {
    try {
      if (tokenMatches()) unlinkSync(lockPath); // never delete a reclaimer's lock
    } catch {
      /* already gone */
    }
  }
}

// ── fold (pure) ────────────────────────────────────────────────────────────────────────────────

function coerceRecord(ask: unknown): AskRecord | null {
  if (!isRecord(ask)) return null;
  const id = asStr(ask.id);
  const severity = asStr(ask.severity);
  const source = asStr(ask.source);
  if (!id || !severity || !SEVERITIES.has(severity) || source === undefined) return null;
  const tierRaw = asStr(ask.tier) ?? "admin";
  const tier = (TIERS.has(tierRaw) ? tierRaw : "admin") as Tier;
  const createdAt = asStr(ask.createdAt);
  return {
    id,
    dedupeKey: asStr(ask.dedupeKey) ?? null,
    kind: normalizeKind(asStr(ask.kind) ?? ""),
    severity: severity as AskSeverity,
    title: normalizeTitle(asStr(ask.title) ?? ""),
    body: normalizeBody(asStr(ask.body)),
    ref: asStr(ask.ref) ?? null,
    source,
    sessionId: asStr(ask.sessionId) ?? null,
    tailHash: asStr(ask.tailHash) ?? null,
    transcriptPath: asStr(ask.transcriptPath) ?? null,
    tier,
    createdAt: createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : "",
  };
}

/**
 * Fold NDJSON lines to the current ask state, in order. Pure — no I/O. First create wins on a
 * duplicate id; unknown-id resolve/orphan ops and malformed/unknown-version lines are warnings.
 * Returns asks in creation order.
 */
export function foldLines(lines: readonly string[]): FoldResult {
  const byId = new Map<string, Ask>();
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
    if (parsed.v !== ASKS_SCHEMA_VERSION) {
      warnings.push({ line, reason: "unknown-version" });
      return;
    }

    const op = asStr(parsed.op);
    if (op === "create") {
      const rec = coerceRecord(parsed.ask);
      if (!rec || !rec.createdAt) {
        warnings.push({ line, reason: "invalid-create" });
        return;
      }
      if (byId.has(rec.id)) {
        warnings.push({ line, reason: "duplicate-create-id" }); // first create wins
        return;
      }
      const folded = { ...rec, status: "open", resolvedAt: null } as Ask;
      // Concurrency metadata is durable but internal: keep the long-standing public/JSON ask shape
      // byte-stable while server lifecycle code can still inspect these folded properties.
      Object.defineProperties(folded, {
        replyClaim: { value: null, writable: true, enumerable: false },
        reconcileAfter: { value: null, writable: true, enumerable: false },
      });
      byId.set(rec.id, folded);
      order.push(rec.id);
      return;
    }
    if (op === "resolve" || op === "orphan" || op === "archive") {
      const id = asStr(parsed.id);
      const at = asStr(parsed.at);
      if (!id || !byId.has(id)) {
        warnings.push({ line, reason: `unknown-id-${op}` });
        return;
      }
      const ask = byId.get(id) as Ask;
      ask.status = op === "resolve" ? "resolved" : op === "orphan" ? "orphaned" : "archived";
      ask.resolvedAt = at && Number.isFinite(Date.parse(at)) ? at : new Date().toISOString();
      ask.replyClaim = null;
      return;
    }
    if (op === "claim-reply") {
      const id = asStr(parsed.id);
      const token = asStr(parsed.token);
      const at = asStr(parsed.at);
      const ask = id ? byId.get(id) : undefined;
      if (!ask || !token || !at || !Number.isFinite(Date.parse(at))) {
        warnings.push({ line, reason: "invalid-claim-reply" });
        return;
      }
      const expiresRaw = asStr(parsed.expiresAt);
      const acquiredMs = Date.parse(at);
      const expiresAt =
        expiresRaw && Number.isFinite(Date.parse(expiresRaw))
          ? expiresRaw
          : new Date(acquiredMs + REPLY_CLAIM_LEASE_MS).toISOString();
      const ownerPid =
        typeof parsed.ownerPid === "number" && Number.isSafeInteger(parsed.ownerPid)
          ? parsed.ownerPid
          : null;
      const ownerIdentity = asStr(parsed.ownerIdentity) ?? null;
      if (ask.status === "open" && !ask.replyClaim) {
        ask.replyClaim = { token, claimedAt: at, expiresAt, ownerPid, ownerIdentity };
      }
      return;
    }
    if (op === "release-reply") {
      const id = asStr(parsed.id);
      const token = asStr(parsed.token);
      const at = asStr(parsed.at);
      const ask = id ? byId.get(id) : undefined;
      if (!ask || !token || !at || !Number.isFinite(Date.parse(at))) {
        warnings.push({ line, reason: "invalid-release-reply" });
        return;
      }
      if (ask.replyClaim?.token === token) {
        ask.replyClaim = null;
        ask.reconcileAfter = at;
      }
      return;
    }
    if (op === "reconcile-after") {
      const id = asStr(parsed.id);
      const at = asStr(parsed.at);
      const ask = id ? byId.get(id) : undefined;
      if (!ask || !at || !Number.isFinite(Date.parse(at))) {
        warnings.push({ line, reason: "invalid-reconcile-after" });
        return;
      }
      ask.reconcileAfter = at;
      return;
    }
    warnings.push({ line, reason: "unknown-op" });
  });

  return { asks: order.map((id) => byId.get(id) as Ask), warnings };
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

/** Read + fold the store. Missing file → empty. An unreadable existing file → one warning. */
export function readAsks(root: string): FoldResult {
  const abs = storePath(root);
  if (!existsSync(abs)) return { asks: [], warnings: [] };
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return { asks: [], warnings: [{ line: 0, reason: "unreadable" }] };
  }
  return foldLines(raw.split(/\r?\n/));
}

/** True iff an OPEN ask currently carries `dedupeKey`. `null` never dedupes (returns false). */
export function hasOpenDuplicate(root: string, dedupeKey: string | null): boolean {
  if (!dedupeKey) return false;
  return readAsks(root).asks.some((a) => a.status === "open" && a.dedupeKey === dedupeKey);
}

// ── write (lock-protected appends) ──────────────────────────────────────────────────────────────

function createLine(rec: AskRecord): string {
  return JSON.stringify({ v: ASKS_SCHEMA_VERSION, op: "create", ask: rec });
}
function opLine(op: AskOp, id: string, at: string): string {
  return JSON.stringify({ v: ASKS_SCHEMA_VERSION, op, id, at });
}

/** Normalize + validate, then append one create line under the lock. Returns the stored record. */
export function appendCreate(root: string, input: AskInput): AskRecord {
  const rec = buildRecord(input);
  withLock(root, () => appendFileSync(storePath(root), createLine(rec) + "\n"));
  return rec;
}

/**
 * Dedupe-aware create: re-checks the dedupeKey against the folded store INSIDE the lock, so two
 * concurrent writers with the same key cannot both append (closes the check-then-append race a
 * lock-free `hasOpenDuplicate` pre-check leaves open). Returns null when suppressed. An input
 * without a dedupeKey never dedupes and always appends.
 */
export function appendCreateDeduped(root: string, input: AskInput): AskRecord | null {
  const rec = buildRecord(input);
  return withLock(root, () => {
    if (rec.dedupeKey) {
      const abs = storePath(root);
      if (existsSync(abs)) {
        const { asks } = foldLines(readFileSync(abs, "utf8").split(/\r?\n/));
        if (asks.some((a) => a.status === "open" && a.dedupeKey === rec.dedupeKey)) return null;
      }
    }
    appendFileSync(storePath(root), createLine(rec) + "\n");
    return rec;
  });
}

/** Append a resolve/orphan/archive op under the lock. Existence is the caller's concern. */
export function appendOp(
  root: string,
  op: AskOp,
  id: string,
  at: string = new Date().toISOString()
): void {
  withLock(root, () => appendFileSync(storePath(root), opLine(op, id, at) + "\n"));
}

function foldedUnderLock(root: string): Ask[] {
  const abs = storePath(root);
  return existsSync(abs) ? foldLines(readFileSync(abs, "utf8").split(/\r?\n/)).asks : [];
}

function releaseAbandonedClaim(root: string, ask: Ask, at: string): boolean {
  if (
    !ask.replyClaim ||
    recoveryPolicy.claimRecoveryDecision(ask.replyClaim, Date.parse(at)) !== "recover"
  )
    return false;
  appendFileSync(
    storePath(root),
    JSON.stringify({
      v: ASKS_SCHEMA_VERSION,
      op: "release-reply",
      id: ask.id,
      token: ask.replyClaim.token,
      at,
      reason: "owner-dead-or-lease-expired",
    }) + "\n"
  );
  return true;
}

export function claimReply(
  root: string,
  id: string,
  token: string,
  at: string = new Date().toISOString(),
  ownerPid: number = process.pid
): ReplyClaimResult {
  return withLock(root, () => {
    const ask = foldedUnderLock(root).find((candidate) => candidate.id === id);
    if (!ask) return "missing";
    if (ask.status !== "open") return "closed";
    if (ask.replyClaim && !releaseAbandonedClaim(root, ask, at)) return "busy";
    const acquiredMs = Date.parse(at);
    if (!Number.isFinite(acquiredMs)) return "busy";
    const expiresAt = new Date(acquiredMs + REPLY_CLAIM_LEASE_MS).toISOString();
    const ownerIdentity = recoveryPolicy.processIdentity(ownerPid);
    appendFileSync(
      storePath(root),
      JSON.stringify({
        v: ASKS_SCHEMA_VERSION,
        op: "claim-reply",
        id,
        token,
        at,
        expiresAt,
        ownerPid,
        ownerIdentity,
      }) + "\n"
    );
    return "claimed";
  });
}

export function releaseReply(
  root: string,
  id: string,
  token: string,
  at: string = new Date().toISOString()
): boolean {
  return withLock(root, () => {
    const ask = foldedUnderLock(root).find((candidate) => candidate.id === id);
    if (ask?.status !== "open" || ask.replyClaim?.token !== token) return false;
    appendFileSync(
      storePath(root),
      JSON.stringify({ v: ASKS_SCHEMA_VERSION, op: "release-reply", id, token, at }) + "\n"
    );
    return true;
  });
}

export function completeReply(
  root: string,
  id: string,
  token: string,
  at: string = new Date().toISOString()
): ReplyCompletionResult {
  return withLock(root, () => {
    const ask = foldedUnderLock(root).find((candidate) => candidate.id === id);
    if (!ask) return "missing";
    if (ask.status !== "open") return "closed";
    if (ask.replyClaim?.token !== token) return "claim-mismatch";
    appendFileSync(storePath(root), opLine("resolve", id, at) + "\n");
    return "resolved";
  });
}

export function archiveAsk(
  root: string,
  id: string,
  at: string = new Date().toISOString()
): ArchiveResult {
  return withLock(root, () => {
    const ask = foldedUnderLock(root).find((candidate) => candidate.id === id);
    if (!ask) return "missing";
    if (ask.status === "archived") return "already-archived";
    if (ask.status !== "open") return "closed";
    if (ask.replyClaim && !releaseAbandonedClaim(root, ask, at)) return "busy";
    appendFileSync(storePath(root), opLine("archive", id, at) + "\n");
    return "archived";
  });
}

/** Atomically consume transcript evidence only while no UI reply owns the ask. */
export function resolveUnclaimed(root: string, id: string, evidenceAt: string): AskReconcileResult {
  return withLock(root, () => {
    const ask = foldedUnderLock(root).find((candidate) => candidate.id === id);
    if (!ask) return "missing";
    if (ask.status !== "open") return "closed";
    if (ask.replyClaim) {
      if (releaseAbandonedClaim(root, ask, new Date().toISOString())) return "stale-evidence";
      return "busy";
    }
    const evidenceMs = Date.parse(evidenceAt);
    const createdMs = Date.parse(ask.createdAt);
    const reconcileMs = Date.parse(ask.reconcileAfter || "");
    const afterMs = Number.isFinite(reconcileMs) ? Math.max(createdMs, reconcileMs) : createdMs;
    if (!Number.isFinite(evidenceMs) || !Number.isFinite(afterMs) || evidenceMs <= afterMs) {
      return "stale-evidence";
    }
    appendFileSync(storePath(root), opLine("resolve", id, evidenceAt) + "\n");
    return "resolved";
  });
}

// ── maintenance ────────────────────────────────────────────────────────────────────────────────

/**
 * Ids of OPEN asks that should be orphaned: a set `transcriptPath` whose file is now gone, or an
 * ask open longer than OPEN_STALE_DAYS that carries a sessionId (a session that never came back).
 */
export function detectOrphans(asks: readonly Ask[], now: Date = new Date()): string[] {
  const nowMs = now.getTime();
  const ids: string[] = [];
  for (const ask of asks) {
    if (ask.status !== "open") continue;
    if (ask.transcriptPath && !existsSync(ask.transcriptPath)) {
      ids.push(ask.id);
      continue;
    }
    const createdMs = Date.parse(ask.createdAt);
    if (
      ask.sessionId &&
      Number.isFinite(createdMs) &&
      nowMs - createdMs > OPEN_STALE_DAYS * DAY_MS
    ) {
      ids.push(ask.id);
    }
  }
  return ids;
}

/**
 * Compact the store: drop resolved/orphaned asks closed more than RESOLVED_GC_DAYS ago, and
 * collapse the log to one create line per kept ask (+ a close op for kept-but-closed asks). Held
 * entirely under the lock across fold → temp → rename; ownership is re-verified immediately
 * before the rename and the rewrite is skipped if the lock was stale-reclaimed, so a reclaimer's
 * appends are never overwritten. Returns the number of asks removed (`skipped` on abort).
 */
export function compact(
  root: string,
  now: Date = new Date()
): { removed: number; skipped?: boolean } {
  const abs = storePath(root);
  return withLock(root, (ownsLock) => {
    if (!existsSync(abs)) return { removed: 0 };
    const { asks } = foldLines(readFileSync(abs, "utf8").split(/\r?\n/));
    const cutoff = now.getTime() - RESOLVED_GC_DAYS * DAY_MS;
    const kept: Ask[] = [];
    let removed = 0;
    for (const ask of asks) {
      if (ask.status !== "open") {
        const closedMs = ask.resolvedAt ? Date.parse(ask.resolvedAt) : NaN;
        if (!Number.isFinite(closedMs) || closedMs < cutoff) {
          removed++;
          continue;
        }
      }
      kept.push(ask);
    }
    const lines: string[] = [];
    for (const ask of kept) {
      const { status, resolvedAt, replyClaim, reconcileAfter, ...rec } = ask;
      lines.push(createLine(rec));
      if (reconcileAfter) {
        lines.push(
          JSON.stringify({
            v: ASKS_SCHEMA_VERSION,
            op: "reconcile-after",
            id: ask.id,
            at: reconcileAfter,
          })
        );
      }
      if (replyClaim) {
        lines.push(
          JSON.stringify({
            v: ASKS_SCHEMA_VERSION,
            op: "claim-reply",
            id: ask.id,
            token: replyClaim.token,
            at: replyClaim.claimedAt,
            expiresAt: replyClaim.expiresAt,
            ownerPid: replyClaim.ownerPid,
            ownerIdentity: replyClaim.ownerIdentity,
          })
        );
      }
      if (status !== "open") {
        lines.push(
          opLine(
            status === "resolved" ? "resolve" : status === "orphaned" ? "orphan" : "archive",
            ask.id,
            resolvedAt ?? now.toISOString()
          )
        );
      }
    }
    const tmp = abs + `.tmp-${process.pid}`;
    writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "");
    if (!ownsLock()) {
      // Lock was stale-reclaimed while we folded (holder overran LOCK_STALE_MS): a reclaimer may
      // have appended lines our snapshot doesn't contain. Abort the rewrite rather than lose them.
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort tmp cleanup */
      }
      return { removed: 0, skipped: true };
    }
    renameSync(tmp, abs);
    return { removed };
  });
}
