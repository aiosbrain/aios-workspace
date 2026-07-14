/**
 * inbox-api.mjs — the GUI server half of the Unified Inbox comms section (I-14 / AIO-395, G6a).
 *
 * Three localhost-only, admin-tier routes the GUI server (gui/server/index.mjs) mounts:
 *
 *   • GET  /api/inbox            → the I-09 read-only unified queue, byte-for-byte the same shape as
 *                                  `aios inbox --json`: `{ items, ranker_version, generated_at, staleness }`.
 *                                  Served IN-PROCESS from the same compiled read model (`buildInbox`) the
 *                                  CLI uses, so the GUI and the terminal render identical data (the API
 *                                  contract test deep-equals the two). `?raw=1` mirrors `aios inbox --raw`.
 *   • GET  /api/inbox/:id        → one item's detail plus any PENDING capability approvals (I-03 display
 *                                  projections) the operator could scoped-confirm from that item.
 *   • POST /api/inbox/:id/decision → the ONLY mutating call in this issue. Carries `{ handle, digest,
 *                                  decision }` and nothing else; brokers the human decision through the
 *                                  I-03 coordinator seam and lets the OWNING RUNTIME validate + durably
 *                                  consume its own record. The digest the human saw must match the
 *                                  runtime's stored request digest — a tamper is rejected before broker.
 *
 * Tier safety: read-only over admin-tier local state; nothing syncs to the Team Brain; `sender.ts` is
 * untouched. The compiled operator-loop (buildInbox / brokerDecision / durable journal) is imported
 * lazily and guarded so `npm run gui` starts even before `npm run build:loop`. The capability store is
 * plain ESM (no dist dependency) — the AUTHORITY that validates + consumes.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadRecord,
  consumeAndExecute,
  readCapabilities,
} from "./runtime-adapters/capability-store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOOP_DIST = path.join(SCRIPT_DIR, "..", "..", "dist", "operator-loop", "index.js");

// Lazily import the compiled operator-loop (buildInbox + the coordinator broker). Guarded: a missing
// dist yields `null` so a route degrades to a clear 503 instead of crashing the whole GUI server.
let _loopPromise;
function loadLoop() {
  if (!_loopPromise) {
    _loopPromise = import(pathToFileURL(LOOP_DIST).href).catch(() => null);
  }
  return _loopPromise;
}

/** The safe-to-render display projection for a pending capability record (no request payload). */
function projectionOf(rec) {
  const targets = Array.isArray(rec.targetResources) ? rec.targetResources : [];
  return {
    handle: rec.handle,
    operation: rec.operation,
    summary: `${rec.operation}${targets.length ? ` · ${targets.join(", ")}` : ""}`,
    digest: rec.requestDigest,
    expiresAt: rec.expiresAt,
  };
}

/**
 * The unified read-only queue. Returns EXACTLY the `aios inbox --json` contract shape, assembled from the
 * same compiled read model, so the GUI and the CLI never diverge. `raw` swaps to pure-chronological order.
 */
export async function getInboxView(repo, { raw = false } = {}) {
  const loop = await loadLoop();
  if (!loop || typeof loop.buildInbox !== "function") {
    const err = new Error("operator-loop is not built — run: npm run build:loop");
    err.statusCode = 503;
    throw err;
  }
  const view = loop.buildInbox(repo);
  const items = raw && typeof loop.rawOrder === "function" ? loop.rawOrder(view.items) : view.items;
  return {
    items,
    ranker_version: view.ranker_version,
    generated_at: view.generated_at,
    staleness: view.staleness,
  };
}

/**
 * One item's detail. `item` is the matching unified row (or null if the id is gone from the queue);
 * `pendingApprovals` are the display projections of any still-pending capability handles the operator
 * could scoped-confirm — the bridge between the read-model queue and the I-03 approval broker.
 */
export async function getInboxDetail(repo, id) {
  const view = await getInboxView(repo);
  const item = view.items.find((i) => i.id === id) ?? null;
  const pendingApprovals = readPendingApprovals(repo);
  return { item, pendingApprovals, generated_at: view.generated_at, staleness: view.staleness };
}

/** Fold the capability store and project every still-pending, unexpired handle (best-effort). */
function readPendingApprovals(repo, now = Date.now()) {
  try {
    const out = [];
    for (const rec of readCapabilities(repo).values()) {
      if (rec.state !== "pending") continue;
      if (Number.isFinite(Date.parse(rec.expiresAt)) && now > Date.parse(rec.expiresAt)) continue;
      out.push(projectionOf(rec));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Broker + durably consume a scoped-confirmation decision. Input is EXACTLY `{ handle, digest, decision }`.
 * The coordinator broker never authorizes; the owning runtime re-loads its authoritative record and
 * validates it. We additionally gate on the operator-supplied digest matching the runtime's stored request
 * digest, so a mutated digest is rejected BEFORE anything is brokered or consumed.
 *
 * Returns `{ ok, status, ...payload }` — `status` is the HTTP status the route should emit.
 */
export async function decideInbox(repo, id, payload) {
  const handle = payload && typeof payload.handle === "string" ? payload.handle : "";
  const digest = payload && typeof payload.digest === "string" ? payload.digest : "";
  const decision = payload && payload.decision;
  if (!handle) return { ok: false, status: 400, error: "handle is required" };
  if (decision !== "approve" && decision !== "deny") {
    return { ok: false, status: 400, error: "decision must be 'approve' or 'deny'" };
  }
  const rec = loadRecord(repo, handle);
  if (!rec) return { ok: false, status: 404, error: "unknown-handle" };
  if (rec.state !== "pending") {
    return { ok: false, status: 409, error: `handle is ${rec.state}`, state: rec.state };
  }
  // Tamper gate at the door: the digest the operator confirmed must equal the runtime's stored request
  // digest. (consumeAndExecute re-checks this against its own record; we fail fast + clearly here too.)
  if (!digest || digest !== rec.requestDigest) {
    return { ok: false, status: 409, error: "digest-mismatch" };
  }

  const loop = await loadLoop();
  const brokerDecision = loop && loop.brokerDecision;
  const makeJournal = loop && loop.createDurableCapabilityJournal;
  if (typeof brokerDecision !== "function") {
    return { ok: false, status: 503, error: "coordinator broker unavailable (build the loop)" };
  }
  const journal = typeof makeJournal === "function" ? makeJournal(repo) : undefined;
  const projection = projectionOf(rec);
  const brokered = brokerDecision(
    projection,
    decision,
    journal ? { appendInboxEvent: journal } : {}
  );
  const result = consumeAndExecute(repo, handle, brokered, {
    identity: repo,
    execute: () => true,
    appendEvent: journal,
  });
  // A rejection (incl. an explicit denial) is a processed decision, not a server error — 200 with the
  // typed result so the client can render "denied" / "rejected: <reason>" distinctly.
  const ok = result.kind !== "rejected" || result.reason === "denied";
  return { ok, status: 200, result };
}
