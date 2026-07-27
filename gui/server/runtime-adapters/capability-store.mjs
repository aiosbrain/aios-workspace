// Runtime-issued capability handle store (I-03 / AIO-384 — Unified Inbox G2b).
//
// This is the OWNING RUNTIME side of the approval trust design (Claude Code first).
// It closes Sol r2 blocker 3: v3's self-described envelope was neither tamper- nor
// restart-safe. Here the runtime persists a durable, AUTHORITATIVE pending record and
// hands the coordinator only an OPAQUE handle plus a safe-to-render display projection.
// The coordinator brokers the human decision but never authorizes: this module validates
// its OWN record (never coordinator-supplied fields), atomically flips pending→consumed
// with a restart-surviving tombstone, executes exactly once, and emits a receipt.
//
// Storage mirrors src/operator-loop/asks/store.ts: an append-only NDJSON log folded to
// state on read, guarded by a writer-honored lockfile. It is dependency-free (like
// hooks/decision-capture.mjs re-implements the asks writer) so the gateway can load it
// without pulling in the compiled operator-loop. Admin-tier local state — NEVER synced.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const CAPABILITY_STORE_REL = ".aios/loop/inbox/capability.ndjson";
export const CAPABILITY_SCHEMA_VERSION = 1;
/** Default handle lifetime — a human approval that ages past this expires (distinct from denial). */
export const DEFAULT_TTL_MS = 5 * 60 * 1000; // matches the gateway's 5-min auto-deny

// ── idempotency classes (I-07 / AIO-388, per the I-01 domain spec) ─────────────────────────────────
//
// Every operation declares how it may be retried after an `outcome_unknown` crash window. Retry
// eligibility derives from the CLASS, never from a guess:
//   • safe-retry     — re-executing is harmless (the op is naturally idempotent) → re-execute.
//   • reconcile-first — the op MAY have run; query the channel's native receipt before anything → reconcile.
//   • at-most-once    — re-executing could double-fire an irreversible side effect → require human re-approval.
export const IDEMPOTENCY_CLASSES = ["safe-retry", "reconcile-first", "at-most-once"];
/** Default (safest) class: never auto-retry an operation whose class we don't know. */
export const DEFAULT_IDEMPOTENCY = "at-most-once";

/** Normalize an incoming idempotency declaration to a known class, defaulting to the safest. */
export function normalizeIdempotency(value) {
  return IDEMPOTENCY_CLASSES.includes(value) ? value : DEFAULT_IDEMPOTENCY;
}

/**
 * The retry plan for an `outcome_unknown` handle, derived ONLY from its idempotency class. This is the
 * single place the "safe-retry re-executes / reconcile-first queries the channel / at-most-once needs a
 * human" policy lives — no caller guesses.
 */
export function retryEligibility(idempotency) {
  switch (normalizeIdempotency(idempotency)) {
    case "safe-retry":
      return { retryable: true, action: "re-execute" };
    case "reconcile-first":
      return { retryable: true, action: "reconcile-channel" };
    case "at-most-once":
    default:
      return { retryable: false, action: "human-reapproval" };
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;

// ── canonical digest ─────────────────────────────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively so a digest is stable across arg ordering. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The canonical request digest the human decision binds to. Computed over the fields the runtime
 * will actually execute — operation, normalized args, target resources, repo/worktree identity —
 * so a coordinator that mutates any of them cannot produce a matching digest.
 */
export function capabilityDigest(request) {
  const shape = {
    operation: request.operation,
    normalizedArgs: request.normalizedArgs ?? null,
    targetResources: request.targetResources ?? [],
    repoWorktreeIdentity: request.repoWorktreeIdentity,
  };
  return createHash("sha256").update(canonicalJson(shape)).digest("hex");
}

/** Best-effort, content-free resource extraction from a tool input (paths + a command head). */
export function capabilityTargets(operation, args) {
  const out = [];
  if (args && typeof args === "object") {
    for (const key of ["file_path", "path", "filePath", "notebook_path"]) {
      if (typeof args[key] === "string") out.push(args[key]);
    }
    if (typeof args.command === "string") out.push(`cmd:${args.command.split(/\s+/)[0] ?? ""}`);
  }
  return out;
}

// ── record integrity (I-07 / AIO-388) ──────────────────────────────────────────────────────────────
//
// `requestDigest` binds ONLY the fields the human approves (operation, args, targets, identity). It does
// NOT cover the lifetime/binding fields (createdAt, expiresAt, audience, idempotency, epoch). A local
// tamper that widens the TTL, re-points the audience, or downgrades the idempotency class would sail past
// the digest gate. `recordIntegrity` is a self-consistency hash over EVERY persisted issue field, checked
// at consume time, so a mutation to any one of them is caught before execution — the coverage the
// field-mutation fixture family asserts (a new persisted field cannot ship unattacked).
//
// Honest scope: this is an unkeyed hash — it defends against corruption and naive record tampering, not an
// attacker who can also recompute it. The keyed defense against a rotated/forged store is the rotation
// `epoch` (family 6): a superseded epoch is rejected even if every hash in the record is internally valid.
export const INTEGRITY_FIELDS = [
  "handle",
  "operation",
  "normalizedArgs",
  "targetResources",
  "repoWorktreeIdentity",
  "requestDigest",
  "createdAt",
  "expiresAt",
  "audience",
  "idempotency",
  "epoch",
];

export function recordIntegrity(record) {
  const shape = {};
  for (const k of INTEGRITY_FIELDS) shape[k] = record[k] ?? null;
  return createHash("sha256").update(canonicalJson(shape)).digest("hex");
}

// ── lock (minimal; append + compare-and-consume only, never a rewrite) ─────────────────────────────

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function storePath(root) {
  return path.join(root, CAPABILITY_STORE_REL);
}

/**
 * Run `fn` while holding an exclusive lockfile next to the store. Bounded retries; a stale lock is
 * reclaimed. Always released, even if `fn` throws. Mirrors asks/store.ts withLock, minus the
 * rewrite-ownership check (this store only ever appends).
 */
export function withLock(root, fn) {
  const lockPath = storePath(root) + ".lock";
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let fd = null;
  for (let attempt = 0; attempt <= LOCK_RETRIES && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* lost the reclaim race — retry */
        }
        continue;
      }
      if (attempt < LOCK_RETRIES) sleepSync(LOCK_DELAY_MS);
    }
  }
  if (fd === null) throw new Error(`capability: could not acquire store lock (${lockPath})`);
  try {
    try {
      writeFileSync(fd, `${process.pid} ${token} ${new Date().toISOString()}\n`);
    } catch {
      /* stamp failed — non-fatal for append-only use */
    }
    closeSync(fd);
    return fn();
  } finally {
    try {
      if (readFileSync(lockPath, "utf8").includes(token)) unlinkSync(lockPath);
    } catch {
      /* already gone / reclaimed */
    }
  }
}

// ── fold (pure) ────────────────────────────────────────────────────────────────────────────────

export function issueLine(record) {
  return JSON.stringify({ v: CAPABILITY_SCHEMA_VERSION, op: "issue", record });
}
export function consumeLine(handle, decision, at, brokerDigest) {
  return JSON.stringify({
    v: CAPABILITY_SCHEMA_VERSION,
    op: "consume",
    handle,
    decision,
    at,
    brokerDigest,
  });
}
/**
 * The durable OUTCOME line, appended AFTER the consume tombstone and after the side effect resolves. Its
 * presence is what distinguishes a completed round-trip (has an outcome → replay-consumed) from a crash
 * window (tombstone with NO outcome → outcome_unknown, action may never have run). Written for every
 * terminal path: native-receipt, outcome_unknown, denied, and reconcile resolutions.
 */
export function receiptLine(handle, outcome, at) {
  return JSON.stringify({ v: CAPABILITY_SCHEMA_VERSION, op: "receipt", handle, outcome, at });
}

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fold NDJSON lines to a Map<handle, PendingApproval>. First issue wins per handle; a consume op
 * is the durable tombstone (pending → consumed). Malformed / unknown-version lines are skipped.
 * State is `pending | consumed`; expiry is derived at read time against `now`, never persisted, so
 * an expired-but-un-consumed handle stays distinguishable from a denial (which carries a consume op).
 */
export function foldCapabilityLines(lines) {
  const byHandle = new Map();
  for (const text of lines) {
    if (!text || !text.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.v !== CAPABILITY_SCHEMA_VERSION) continue;
    if (parsed.op === "issue") {
      const r = parsed.record;
      if (!isRecord(r) || typeof r.handle !== "string") continue;
      if (byHandle.has(r.handle)) continue; // first issue wins
      byHandle.set(r.handle, {
        handle: r.handle,
        operation: r.operation,
        normalizedArgs: r.normalizedArgs ?? null,
        targetResources: Array.isArray(r.targetResources) ? r.targetResources : [],
        repoWorktreeIdentity: r.repoWorktreeIdentity,
        requestDigest: r.requestDigest,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        // I-07 binding fields — folded back verbatim so recordIntegrity re-verifies against them.
        audience: r.audience ?? null,
        idempotency: r.idempotency ?? DEFAULT_IDEMPOTENCY,
        epoch: r.epoch ?? null,
        integrity: r.integrity ?? null,
        state: "pending",
        decision: null,
        consumedAt: null,
        // The durable outcome (null until a `receipt` line lands). A consumed record with a null outcome
        // is a crash window: the tombstone exists but the side effect never recorded its result.
        outcome: null,
      });
    } else if (parsed.op === "consume") {
      const rec = byHandle.get(parsed.handle);
      if (!rec || rec.state === "consumed") continue; // first consume wins (idempotent tombstone)
      rec.state = "consumed";
      rec.decision = typeof parsed.decision === "string" ? parsed.decision : "approve";
      rec.consumedAt = typeof parsed.at === "string" ? parsed.at : new Date().toISOString();
    } else if (parsed.op === "receipt") {
      const rec = byHandle.get(parsed.handle);
      if (!rec || rec.outcome) continue; // first outcome wins (durable resolution)
      rec.outcome = typeof parsed.outcome === "string" ? parsed.outcome : "native-receipt";
    }
  }
  return byHandle;
}

/** Read + fold the store from disk. Missing file → empty map. This is the restart-reload seam. */
export function readCapabilities(root) {
  const abs = storePath(root);
  if (!existsSync(abs)) return new Map();
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return new Map();
  }
  return foldCapabilityLines(raw.split(/\r?\n/));
}

/** Load one folded record, with `state` corrected to `expired` if a pending handle aged past its TTL. */
export function loadRecord(root, handle, now = Date.now()) {
  const rec = readCapabilities(root).get(handle);
  if (!rec) return null;
  if (
    rec.state === "pending" &&
    Number.isFinite(Date.parse(rec.expiresAt)) &&
    now > Date.parse(rec.expiresAt)
  ) {
    return { ...rec, state: "expired" };
  }
  return rec;
}

// ── issue ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Persist a durable PendingApproval and return the OPAQUE handle + a safe display projection. The
 * handle carries no request data (unlike v3's self-describing envelope); the runtime keeps the
 * authoritative record keyed by handle. The projection carries only the digest the human binds to.
 *
 * @returns {{ handle: string, displayProjection: { handle, operation, summary, digest, expiresAt } }}
 */
/**
 * Build (but do not persist) the durable PendingApproval record for a request, integrity hash included.
 * Exported so the fixture matrix can craft valid AND adversarially-mutated records without reaching into
 * the store's private shape. `issueHandle` is the one caller that also persists + projects it.
 */
export function makeIssueRecord(request, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const record = {
    handle: request.handle ?? randomUUID(),
    operation: request.operation,
    normalizedArgs: request.normalizedArgs ?? null,
    targetResources:
      request.targetResources ?? capabilityTargets(request.operation, request.normalizedArgs),
    repoWorktreeIdentity: request.repoWorktreeIdentity,
    requestDigest: capabilityDigest(request),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    // I-07 binding fields: which session/audience may consume, how it may be retried, and under which
    // key/session epoch it was issued. All fold-persisted and integrity-bound.
    audience: request.audience ?? null,
    idempotency: normalizeIdempotency(request.idempotency),
    epoch: request.epoch ?? null,
  };
  record.integrity = recordIntegrity(record);
  return record;
}

export function issueHandle(root, request, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const record = makeIssueRecord(request, { now, ttlMs });
  const handle = record.handle;
  const requestDigest = record.requestDigest;
  withLock(root, () => appendFileSync(storePath(root), issueLine(record) + "\n"));
  return {
    handle,
    displayProjection: {
      handle,
      operation: record.operation,
      // A short, safe-to-render label (no full args) — the human sees WHAT, bound to the digest.
      summary: `${record.operation}${record.targetResources.length ? ` · ${record.targetResources.join(", ")}` : ""}`,
      digest: requestDigest,
      expiresAt: record.expiresAt,
    },
  };
}

// ── consume + execute (atomic, exactly-once) ──────────────────────────────────────────────────────

function rejection(handle, reason, extra = {}) {
  return { kind: "rejected", ok: false, handle, reason, ...extra };
}

/**
 * Emit one journal event through the injected sink, NON-FATALLY, honouring the journal-BEFORE-store
 * ordering contract (AIO-427 review). Two properties, reconciled deliberately:
 *
 *   1. ORDERING — every caller invokes this IMMEDIATELY BEFORE the authoritative capability-store
 *      append for the same transition. So on the happy path the durable journal is never BEHIND the
 *      store: a crash between the two leaves the journal at-or-ahead of the store (the recoverable
 *      direction — the read-model dedups a duplicate/early event; the store, still authoritative,
 *      re-derives true state on restart). This removes the divergence crash window where the store
 *      advanced past an unwritten journal event.
 *
 *   2. NON-FATAL — a journal failure (validation / filesystem / lock error from the sink) must NEVER
 *      strand the store lock, abort the authoritative mutation, or crash the gateway. Any throw is
 *      swallowed here with a CONTENT-FREE warning (the event KIND only — never the payload/args), and
 *      the caller's store write then proceeds. The authoritative store stays the source of truth; a
 *      dropped journal line is recoverable by a later `rebuildReadModel`.
 *
 * These do not conflict: (1) is about SEQUENCE (attempt the journal first), (2) is about ERROR
 * HANDLING (never let that attempt block the authoritative store). At-most-once/replay are unaffected
 * because execution is gated on the STORE tombstone, which every caller still writes before `execute`.
 */
function emitJournal(appendEvent, event) {
  if (!appendEvent) return;
  try {
    appendEvent(event);
  } catch {
    try {
      // Content-free: the event KIND is a fixed enum string; the payload is never logged.
      console.warn(
        `capability: journal append failed (kind=${event?.kind ?? "?"}); authoritative store write proceeds`
      );
    } catch {
      /* never let logging itself throw */
    }
  }
}

/**
 * Validate the runtime's OWN record for `handle`, then — only if the brokered decision approves and
 * every check passes — atomically flip pending→consumed (durable tombstone) and execute EXACTLY once.
 *
 * The runtime NEVER trusts coordinator-supplied request fields: it re-loads its authoritative record
 * and executes that. `brokered` contributes only the human decision + the digest the human saw; a
 * mutated digest (tamper) fails the equality check against the stored digest and is rejected before
 * any execution. A replayed handle — even after a full runtime restart — folds to `consumed` from
 * the durable tombstone and is rejected. Denials and expiries are typed, distinct rejections.
 *
 * @param {object} deps
 * @param {string} deps.identity      the runtime's current repo/worktree identity (checked, not trusted)
 * @param {(record)=>any} [deps.execute]   the exactly-once side effect; receives the AUTHORITATIVE record
 * @param {number} [deps.now]
 * @param {(event)=>void} [deps.appendEvent]  I-02 journal writer (stubbed until I-02 merges)
 * @returns a `native-receipt` Receipt on success, or a TypedRejection.
 */
export function consumeAndExecute(
  root,
  handle,
  brokered,
  { identity, audience, epoch, execute, now = Date.now(), appendEvent } = {}
) {
  return withLock(root, () => {
    // Re-fold from disk INSIDE the lock so the pending/consumed check is a true compare-and-consume.
    const rec = readCapabilities(root).get(handle);
    if (!rec) return rejection(handle, "unknown-handle");
    if (rec.state === "consumed") {
      // A consumed tombstone that also carries a DURABLE outcome = a completed round-trip → replay guard
      // (survives a full runtime restart). This is the replay family (I-07 family 7).
      if (rec.outcome) {
        return rejection(handle, "replay-consumed", {
          decision: rec.decision,
          outcome: rec.outcome,
        });
      }
      // Tombstone but NO durable outcome = a crash window (I-07 families 3/4): the consume committed but
      // the action's result was never recorded, so the action may or may not have run. NEVER silently
      // re-execute and NEVER hide it behind a flat replay — surface `outcome_unknown` with the retry plan
      // the record's idempotency class dictates. Resolution runs through `reconcile`.
      return {
        kind: "outcome",
        ok: true,
        handle,
        operation: rec.operation,
        outcome: "outcome_unknown",
        crashWindow: true,
        idempotency: rec.idempotency,
        retry: retryEligibility(rec.idempotency),
        decision: rec.decision,
      };
    }
    if (Number.isFinite(Date.parse(rec.expiresAt)) && now > Date.parse(rec.expiresAt)) {
      return rejection(handle, "expired");
    }
    if (!brokered || brokered.handle !== handle) return rejection(handle, "handle-mismatch");
    // Record-integrity gate (I-07 family 1): the record must be internally self-consistent BEFORE we act
    // on it. (a) the stored digest must still hash the fields we're about to execute, and (b) every
    // persisted field must match the issue-time integrity hash — so a local tamper of args, targets, TTL,
    // audience, idempotency class, or epoch is caught before any execution, not just the digest-covered
    // fields. This is the coverage the field-mutation fixture family asserts field by field.
    if (capabilityDigest(rec) !== rec.requestDigest) return rejection(handle, "record-integrity");
    if (rec.integrity != null && recordIntegrity(rec) !== rec.integrity) {
      return rejection(handle, "record-integrity");
    }
    // Tamper gate: the digest the human approved MUST equal the runtime's own stored digest.
    if (brokered.digest !== rec.requestDigest) return rejection(handle, "digest-mismatch");
    if (identity !== undefined && identity !== rec.repoWorktreeIdentity) {
      return rejection(handle, "identity-mismatch");
    }
    // Audience / session binding (I-07 family 2): a handle issued FOR one runtime+session cannot be
    // consumed under another, even with a perfectly valid brokered decision — the request digest never
    // covered the audience, so only this explicit check stops a cross-session substitution.
    if (rec.audience != null && audience !== rec.audience) {
      return rejection(handle, "audience-mismatch", {
        expected: rec.audience,
        presented: audience ?? null,
      });
    }
    // Rotation (I-07 family 6): a key/session rotation between issue and consume supersedes old handles.
    // A TYPED rotation error (not a generic failure) so a legitimate rotation is distinguishable from an
    // attack and can be surfaced to the human as "please re-approve under the new session".
    if (rec.epoch != null && epoch !== rec.epoch) {
      return rejection(handle, "rotation-superseded", {
        issuedEpoch: rec.epoch,
        currentEpoch: epoch ?? null,
      });
    }

    if (brokered.decision !== "approve") {
      const at = new Date(now).toISOString();
      // Journal-BEFORE-store (AIO-427): record the consumption in the durable journal FIRST, then
      // commit the authoritative deny tombstone. A denial executes nothing, so at-most-once is moot;
      // replay is unweakened because replay-rejection only guards a STORE-committed consume — a crash
      // between these two writes leaves the handle un-committed (safely re-decidable), and the read
      // model dedups the orphaned journal event. The denial VERDICT is the coordinator's
      // pdp-decision(deny) event; here we only record that the handle is consumed.
      emitJournal(appendEvent, {
        kind: "capability-consumption",
        handle,
        at,
        data: {
          capability_id: handle,
          operation: rec.operation,
          request_digest: rec.requestDigest,
          decision: "deny",
        },
      });
      // A denial spends the handle (durable tombstone + outcome) so it can never be re-brokered to approve.
      appendFileSync(storePath(root), consumeLine(handle, "deny", at, brokered.digest) + "\n");
      appendFileSync(storePath(root), receiptLine(handle, "denied", at) + "\n");
      return rejection(handle, "denied", { decision: "deny" });
    }

    const consumedAt = new Date(now).toISOString();
    // Journal-BEFORE-store (AIO-427): emit the durable I-02 consumption event FIRST, then commit the
    // authoritative store tombstone. `capability_id` keys the read-model tombstone table;
    // `operation`/`request_digest` are content-free (tool name + canonical hash).
    emitJournal(appendEvent, {
      kind: "capability-consumption",
      handle,
      at: consumedAt,
      data: {
        capability_id: handle,
        operation: rec.operation,
        request_digest: rec.requestDigest,
        decision: "approve",
      },
    });
    // Atomic flip pending→consumed BEFORE executing: the tombstone is durable first, so a crash
    // mid-execute can never re-run on restart (it folds to consumed → replay-rejected / crash-window).
    // Ordering safety: because the journal event above is written BEFORE this line, a crash between
    // them leaves the handle PENDING (this line never landed) → the action never ran → a safe single
    // retry executes exactly once. At-most-once is preserved by THIS tombstone, not by the journal.
    appendFileSync(
      storePath(root),
      consumeLine(handle, "approve", consumedAt, brokered.digest) + "\n"
    );

    let output;
    try {
      output = execute ? execute(rec) : undefined;
    } catch (e) {
      // Consumed, side effect threw: record a DURABLE outcome_unknown line so a retry replays the KNOWN
      // outcome rather than re-running. Retry eligibility is the record's idempotency class, not a guess.
      const outcomeAt = rec.consumedAt ?? new Date(now).toISOString();
      // Journal-BEFORE-store (AIO-427): the read-model reads `result` (∈ succeeded | failed |
      // outcome_unknown). Emit it before committing the store outcome line; a crash between leaves the
      // store in a crash-window (surfaced as outcome_unknown on restart, never silently re-run), while
      // the journal already carries the outcome — the recoverable direction.
      emitJournal(appendEvent, {
        kind: "outcome",
        handle,
        at: outcomeAt,
        data: { result: "outcome_unknown" },
      });
      appendFileSync(storePath(root), receiptLine(handle, "outcome_unknown", outcomeAt) + "\n");
      return {
        kind: "outcome",
        ok: true,
        handle,
        operation: rec.operation,
        outcome: "outcome_unknown",
        error: String(e?.message ?? e),
        idempotency: rec.idempotency,
        retry: retryEligibility(rec.idempotency),
        consumedAt: outcomeAt,
      };
    }

    const executedAt = new Date(now).toISOString();
    // Journal-BEFORE-store (AIO-427): emit the native-receipt event FIRST, then commit the durable
    // store receipt line that turns this into a completed round-trip (replay-rejected thereafter). The
    // read-model keys the receipt table by `receipt_id` (the handle — one receipt per round-trip);
    // `native_ref` is null for a local execute; `operation` is content-free. A crash between the two
    // leaves the store in a crash-window (outcome_unknown on restart — never re-executed, the tombstone
    // is already durable) while the journal already records the receipt.
    emitJournal(appendEvent, {
      kind: "native-receipt",
      handle,
      at: executedAt,
      data: { receipt_id: handle, native_ref: null, operation: rec.operation },
    });
    // Durable native receipt: the outcome line that turns this from a crash window into a completed
    // round-trip, so any later replay (even after restart) is rejected rather than re-run.
    appendFileSync(storePath(root), receiptLine(handle, "native-receipt", executedAt) + "\n");
    return {
      kind: "native-receipt",
      ok: true,
      handle,
      operation: rec.operation,
      output,
      executedAt,
    };
  });
}

// ── reconcile (crash-window resolution by idempotency class) ────────────────────────────────────────

/**
 * Resolve a crash-window handle — one whose consume tombstone committed but whose durable OUTCOME line is
 * missing (the process died between the two writes). The resolution is dictated ENTIRELY by the record's
 * idempotency class (I-07 families 3/4/5), never by a guess:
 *
 *   • reconcile-first — the action MAY have run. Query the channel's native receipt (`queryNativeReceipt`)
 *     FIRST; if the channel confirms it ran, resolve durably as `resolved-native` (no re-execution). If the
 *     channel has no receipt, stay `outcome_unknown` (retryable) — we still don't know, so we don't act.
 *   • safe-retry — re-executing is harmless; run `execute` (the action never completed, so this is the
 *     one and only execution) and resolve as `re-executed`.
 *   • at-most-once — re-executing could double-fire an irreversible effect; never auto-retry. Return
 *     `outcome_unknown` requiring `human-reapproval`.
 *
 * A record that already carries a durable outcome is terminal and returned as-is (idempotent).
 */
export function reconcile(
  root,
  handle,
  { queryNativeReceipt, execute, now = Date.now(), appendEvent } = {}
) {
  return withLock(root, () => {
    const rec = readCapabilities(root).get(handle);
    if (!rec) return rejection(handle, "unknown-handle");
    if (rec.state !== "consumed") return rejection(handle, "not-consumed");
    if (rec.outcome) {
      return { kind: "outcome", ok: true, handle, outcome: rec.outcome, alreadyResolved: true };
    }
    const at = new Date(now).toISOString();
    const cls = normalizeIdempotency(rec.idempotency);
    // The crash window is ALWAYS surfaced as outcome_unknown first — the journal records that we did not
    // know the action's fate before we resolved it (non-fatal; no paired store write to order against).
    emitJournal(appendEvent, {
      kind: "outcome",
      handle,
      at,
      data: { result: "outcome_unknown", idempotency: cls },
    });

    if (cls === "reconcile-first") {
      const native = queryNativeReceipt ? queryNativeReceipt(rec) : null;
      if (native) {
        // Journal-BEFORE-store (AIO-427): record the resolving receipt, then commit the store line.
        emitJournal(appendEvent, {
          kind: "native-receipt",
          handle,
          at,
          data: { receipt_id: handle, native_ref: null, via: "reconcile" },
        });
        appendFileSync(storePath(root), receiptLine(handle, "resolved-native", at) + "\n");
        return {
          kind: "outcome",
          ok: true,
          handle,
          outcome: "resolved-native",
          via: "native-receipt",
          nativeReceipt: native,
        };
      }
      return {
        kind: "outcome",
        ok: true,
        handle,
        outcome: "outcome_unknown",
        retryable: true,
        action: "reconcile-channel",
      };
    }

    if (cls === "safe-retry") {
      let output;
      try {
        output = execute ? execute(rec) : undefined;
      } catch (e) {
        return {
          kind: "outcome",
          ok: true,
          handle,
          outcome: "outcome_unknown",
          error: String(e?.message ?? e),
        };
      }
      // Journal-BEFORE-store (AIO-427): the action re-executed above (the one and only execution for a
      // safe-retry crash window); record its receipt, then commit the durable store line.
      emitJournal(appendEvent, {
        kind: "native-receipt",
        handle,
        at,
        data: { receipt_id: handle, native_ref: null, via: "safe-retry" },
      });
      appendFileSync(storePath(root), receiptLine(handle, "re-executed", at) + "\n");
      return { kind: "outcome", ok: true, handle, outcome: "re-executed", output };
    }

    // at-most-once (and the safe default): never auto-retry — hand it back to a human.
    return {
      kind: "outcome",
      ok: true,
      handle,
      outcome: "outcome_unknown",
      retryable: false,
      requires: "human-reapproval",
    };
  });
}
