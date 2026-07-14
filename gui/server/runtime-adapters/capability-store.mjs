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

const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;

// ── canonical digest ─────────────────────────────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively so a digest is stable across arg ordering. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
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

function issueLine(record) {
  return JSON.stringify({ v: CAPABILITY_SCHEMA_VERSION, op: "issue", record });
}
function consumeLine(handle, decision, at, brokerDigest) {
  return JSON.stringify({
    v: CAPABILITY_SCHEMA_VERSION,
    op: "consume",
    handle,
    decision,
    at,
    brokerDigest,
  });
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
        state: "pending",
        decision: null,
        consumedAt: null,
      });
    } else if (parsed.op === "consume") {
      const rec = byHandle.get(parsed.handle);
      if (!rec || rec.state === "consumed") continue; // first consume wins (idempotent tombstone)
      rec.state = "consumed";
      rec.decision = typeof parsed.decision === "string" ? parsed.decision : "approve";
      rec.consumedAt = typeof parsed.at === "string" ? parsed.at : new Date().toISOString();
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
export function issueHandle(root, request, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const handle = randomUUID();
  const requestDigest = capabilityDigest(request);
  const record = {
    handle,
    operation: request.operation,
    normalizedArgs: request.normalizedArgs ?? null,
    targetResources:
      request.targetResources ?? capabilityTargets(request.operation, request.normalizedArgs),
    repoWorktreeIdentity: request.repoWorktreeIdentity,
    requestDigest,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
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
  { identity, execute, now = Date.now(), appendEvent } = {}
) {
  return withLock(root, () => {
    // Re-fold from disk INSIDE the lock so the pending/consumed check is a true compare-and-consume.
    const rec = readCapabilities(root).get(handle);
    if (!rec) return rejection(handle, "unknown-handle");
    if (rec.state === "consumed") {
      // Durable tombstone — this is the replay guard that survives a runtime restart.
      return rejection(handle, "replay-consumed", { decision: rec.decision });
    }
    if (Number.isFinite(Date.parse(rec.expiresAt)) && now > Date.parse(rec.expiresAt)) {
      return rejection(handle, "expired");
    }
    if (!brokered || brokered.handle !== handle) return rejection(handle, "handle-mismatch");
    // Tamper gate: the digest the human approved MUST equal the runtime's own stored digest.
    if (brokered.digest !== rec.requestDigest) return rejection(handle, "digest-mismatch");
    if (identity !== undefined && identity !== rec.repoWorktreeIdentity) {
      return rejection(handle, "identity-mismatch");
    }

    if (brokered.decision !== "approve") {
      // A denial spends the handle (durable tombstone) so it can never be re-brokered to approve.
      appendFileSync(
        storePath(root),
        consumeLine(handle, "deny", new Date(now).toISOString(), brokered.digest) + "\n"
      );
      appendEvent?.({
        kind: "outcome",
        handle,
        at: new Date(now).toISOString(),
        data: { outcome: "denied" },
      });
      return rejection(handle, "denied", { decision: "deny" });
    }

    // Atomic flip pending→consumed BEFORE executing: the tombstone is durable first, so a crash
    // mid-execute can never re-run on restart (it folds to consumed → replay-rejected).
    appendFileSync(
      storePath(root),
      consumeLine(handle, "approve", new Date(now).toISOString(), brokered.digest) + "\n"
    );

    let output;
    let outcome = "native-receipt";
    try {
      output = execute ? execute(rec) : undefined;
    } catch (e) {
      // Consumed but the side effect failed: outcome_unknown, retry-eligible by idempotency class.
      const receipt = {
        kind: "outcome",
        ok: true,
        handle,
        operation: rec.operation,
        outcome: "outcome_unknown",
        error: String(e?.message ?? e),
        consumedAt: rec.consumedAt ?? new Date(now).toISOString(),
      };
      appendEvent?.({
        kind: "outcome",
        handle,
        at: receipt.consumedAt,
        data: { outcome: "outcome_unknown" },
      });
      return receipt;
    }

    const receipt = {
      kind: outcome,
      ok: true,
      handle,
      operation: rec.operation,
      output,
      executedAt: new Date(now).toISOString(),
    };
    appendEvent?.({
      kind: "native-receipt",
      handle,
      at: receipt.executedAt,
      data: { operation: rec.operation },
    });
    return receipt;
  });
}
