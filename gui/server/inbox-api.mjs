/**
 * inbox-api.mjs — the GUI server half of the Unified Inbox comms section (I-14 / AIO-395, G6a).
 *
 * Three localhost-only, admin-tier routes the GUI server (gui/server/index.mjs) mounts:
 *
 *   • GET  /api/inbox            → the I-09 read-only unified queue plus GUI ingestion freshness.
 *                                  Ranking is served IN-PROCESS from the same compiled read model
 *                                  (`buildInbox`) the CLI uses. The GUI then removes inactive history and
 *                                  substitutes ingestion freshness for occurrence-derived staleness.
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
import {
  archiveClaudeAsk,
  projectClaudeAskContext,
  reconcileClaudeAsks,
  replyToClaudeAsk,
} from "./claude-asks.mjs";
import { createTelegramNotifyCoordinator } from "./inbox-notify-lock.mjs";

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

// Reconcile does a synchronous 256KB transcript tail-read per open hook-ask, and BOTH polling routes
// (queue + detail) fold through here — unthrottled, every 15s poll pays that cost twice. Transcript
// evidence only ages in, so once per interval is plenty; an ask mutation (reply/archive/decision)
// clears the throttle so the very next read reflects the user's action immediately.
const RECONCILE_INTERVAL_MS = 30_000;
let lastReconcileAt = 0;

/** Force the next inbox read to reconcile immediately (called after any ask/approval mutation). */
export function invalidateReconcileThrottle() {
  lastReconcileAt = 0;
}

/** Gate + record one reconcile pass. `now` is injectable for tests. */
export function shouldReconcileClaudeAsks(now = Date.now()) {
  if (now - lastReconcileAt < RECONCILE_INTERVAL_MS) return false;
  lastReconcileAt = now;
  return true;
}

/**
 * The unified read-only queue. Ranking comes from the same compiled model as the CLI; the GUI contract
 * deliberately replaces occurrence-based `staleness` with connector-ingestion `freshness`.
 */
export async function getInboxView(
  repo,
  { raw = false, refresh = null, notifyLane = null, now = Date.now() } = {}
) {
  const loop = await loadLoop();
  if (!loop || typeof loop.buildInbox !== "function") {
    const err = new Error("operator-loop is not built — run: npm run build:loop");
    err.statusCode = 503;
    throw err;
  }
  // Hook delivery is best-effort. A later ordinary user turn in the bound transcript is hard evidence
  // that an idle/stop ask is stale, so reconcile (throttled) before presenting the queue.
  if (shouldReconcileClaudeAsks(now)) reconcileClaudeAsks(loop, repo);
  const view = loop.buildInbox(repo);
  const projected = projectActiveInboxView(view, { raw, refresh, rawOrder: loop.rawOrder });
  projected.notify = buildNotifyView(
    loop,
    repo,
    new Set(projected.items.map((item) => item.id)),
    notifyLane
  );
  return projected;
}

export function projectActiveInboxView(view, { raw = false, refresh = null, rawOrder } = {}) {
  const active = view.items.filter(isActiveInboxItem);
  const items = raw && typeof rawOrder === "function" ? rawOrder(active) : active;
  return {
    items,
    ranker_version: view.ranker_version,
    generated_at: view.generated_at,
    freshness: refresh,
  };
}

const UNAVAILABLE_NOTIFY_LANE = Object.freeze({
  status: "unavailable",
  last_attempt_at: null,
  last_delivery_at: null,
  last_error: null,
});

/**
 * Project the durable notify journal beside, never into, ranked InboxItem rows.
 * A damaged journal degrades this optional sibling only; the queue remains available.
 */
export function buildNotifyView(loop, repo, itemIds, laneSnapshot = null) {
  try {
    if (
      typeof loop?.readJournalSegments !== "function" ||
      typeof loop?.foldNotificationState !== "function" ||
      typeof loop?.buildOverdue !== "function"
    ) {
      return null;
    }
    const ids = itemIds instanceof Set ? itemIds : new Set(itemIds ?? []);
    const journal = loop.readJournalSegments(repo);
    const folded = loop.foldNotificationState(journal.events);
    const states = {};
    for (const [askId, state] of folded) {
      if (!ids.has(askId)) continue;
      states[askId] = {
        delivery_attempts: state.delivery_attempts,
        last_delivery_at: state.last_delivery_at,
        acked: state.acked,
        last_ack_at: state.last_ack_at,
      };
    }
    // Reuse the events we just read: `buildOverdue` would otherwise re-read and re-fold the whole
    // journal, doubling the file I/O on a surface the GUI polls every 15s.
    const overdueView = loop.buildOverdue(repo, { eventsOverride: journal.events });
    const overdue = {};
    for (const row of overdueView.items ?? []) {
      if (!ids.has(row.ask_id)) continue;
      overdue[row.ask_id] = {
        overdue_by_ms: row.overdue_by_ms,
        delivery_attempts: row.delivery_attempts,
        last_delivery_at: row.last_delivery_at,
      };
    }
    return {
      escalation_window_ms: overdueView.escalation_window_ms,
      states,
      overdue,
      lane: { ...(laneSnapshot ?? UNAVAILABLE_NOTIFY_LANE) },
    };
  } catch {
    return null;
  }
}

/** Resolved/archived asks and done rows belong to history, never the active attention queue. */
export function isActiveInboxItem(item) {
  if (!item || item.bucket === "done") return false;
  if (item.origin !== "agent-event") return true;
  if (!item.ask) return true;
  if (item.attention_state === "resolved" || item.attention_state === "archived") return false;
  return item.ask?.status === "open";
}

/**
 * One item's detail. `item` is the matching unified row (or null if the id is gone from the queue);
 * `pendingApprovals` are the display projections of any still-pending capability handles the operator
 * could scoped-confirm — the bridge between the read-model queue and the I-03 approval broker.
 */
export async function getInboxDetail(repo, id, { refresh = null, notifyLane = null } = {}) {
  const view = await getInboxView(repo, { refresh, notifyLane });
  const item = view.items.find((i) => i.id === id) ?? null;
  const pendingApprovals = readPendingApprovals(repo);
  let agentContext = null;
  if (item?.origin === "agent-event" && item.ask?.status === "open") {
    try {
      agentContext = projectClaudeAskContext(repo, item.ask);
    } catch {
      // Do not expose an unbound transcript. The row remains visible and can still be archived.
      agentContext = {
        subject: item.ask.title || "Claude needs your input",
        summary: item.ask.body || "The original Claude session cannot be resumed safely.",
        turns: [],
        canReply: false,
      };
    }
  }
  return {
    item,
    agentContext,
    pendingApprovals,
    generated_at: view.generated_at,
    freshness: view.freshness,
    notify: view.notify
      ? {
          ...view.notify,
          states:
            item && view.notify.states[item.id] ? { [item.id]: view.notify.states[item.id] } : {},
          overdue:
            item && view.notify.overdue[item.id] ? { [item.id]: view.notify.overdue[item.id] } : {},
        }
      : null,
  };
}

/**
 * Record human acknowledgment only for a currently open, delivered agent ask.
 * The shared notify coordinator makes the delivery check and ack append one critical section,
 * so an ack can never interleave with the notifier's send loop.
 *
 * It deliberately does NOT also take the asks-store `withLock`. That lock backs off with
 * `sleepSync` (Atomics.wait, asks/store.ts) — on this single-threaded server that would stall ALL
 * HTTP and WebSocket agent streaming for up to a second whenever an ack raced a reply. The race it
 * would close is benign anyway: if a reply resolves the ask between the status check and the
 * append, the worst case is an ack event for a just-resolved ask, and `overdueView` already skips
 * every non-open ask, so the recovery view is unaffected either way.
 */
export async function ackInboxAsk(
  repo,
  id,
  {
    notifyCoordinator = createTelegramNotifyCoordinator({ repo }),
    now = () => new Date(),
    loadLoopFn = loadLoop,
  } = {}
) {
  const guarded = await notifyCoordinator.runExclusive(async () => {
    const loop = await loadLoopFn();
    if (
      !loop ||
      typeof loop.buildInbox !== "function" ||
      typeof loop.readJournalSegments !== "function" ||
      typeof loop.foldNotificationState !== "function" ||
      typeof loop.recordHumanAck !== "function" ||
      typeof loop.createDurableNotifyJournal !== "function"
    ) {
      return { ok: false, status: 503, recorded: false, reason: "notify-unavailable" };
    }
    const item = loop.buildInbox(repo).items.find((row) => row.id === id);
    if (
      !item ||
      !isActiveInboxItem(item) ||
      item.origin !== "agent-event" ||
      item.ask?.status !== "open"
    ) {
      return { ok: false, status: 404, recorded: false, reason: "not-acknowledgeable" };
    }
    const journal = loop.readJournalSegments(repo);
    const state = loop.foldNotificationState(journal.events).get(id);
    if (!state || state.delivery_attempts <= 0 || !state.last_delivery_at) {
      return { ok: true, status: 200, recorded: false, reason: "never-delivered" };
    }
    if (state.acked) {
      return { ok: true, status: 200, recorded: false, reason: "already-acked" };
    }
    // `lockRetries: 0` keeps the append OFF the blocking path. The journal lock is shared with the
    // CLI, connectors and compaction; its default backoff is `sleepSync` (Atomics.wait, up to
    // 40 x 25ms), which on this single-threaded server would freeze every other HTTP request and
    // WebSocket agent stream. An ack is never urgent — report busy and let the client retry.
    try {
      loop.recordHumanAck(id, {
        appendEvent: loop.createDurableNotifyJournal(repo, { lockRetries: 0 }),
        now: now(),
      });
    } catch (error) {
      if (error?.code === "INBOX_JOURNAL_LOCK_BUSY") {
        return { ok: false, status: 503, recorded: false, reason: "notify-busy", retryAfter: 1 };
      }
      throw error;
    }
    return { ok: true, status: 200, recorded: true };
  });
  if (!guarded.acquired) {
    return { ok: false, status: 503, recorded: false, reason: "notify-busy", retryAfter: 1 };
  }
  return guarded.value;
}

export async function replyInboxAsk(repo, id, payload, deps) {
  const loop = await loadLoop();
  if (!loop) throw Object.assign(new Error("operator-loop is not built"), { statusCode: 503 });
  const result = await replyToClaudeAsk(loop, repo, id, payload, deps);
  invalidateReconcileThrottle();
  return result;
}

export async function archiveInboxAsk(repo, id) {
  const loop = await loadLoop();
  if (!loop) throw Object.assign(new Error("operator-loop is not built"), { statusCode: 503 });
  const result = archiveClaudeAsk(loop, repo, id);
  invalidateReconcileThrottle();
  return result;
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

// A typed rejection reason → the HTTP status the route emits. A denial is a *processed* decision (200),
// not a client/server error; everything else is a 4xx the caller must surface distinctly.
const REJECTION_STATUS = {
  denied: 200,
  "unknown-handle": 404,
  "handle-mismatch": 409,
  "digest-mismatch": 409,
  "record-integrity": 409,
  expired: 409,
  "replay-consumed": 409,
  "identity-mismatch": 409,
  "audience-mismatch": 403,
  "rotation-superseded": 409,
};

// Machine reason → the human-readable sentence the route emits as `error`, so the
// GUI dialog (ApiError reads body.error — api.ts) shows WHY instead of a bare
// "Conflict" statusText. A denial is a processed decision (ok:true) and carries none.
const REJECTION_MESSAGE = {
  "unknown-handle": "This approval request no longer exists.",
  "handle-mismatch": "The approval does not match this request.",
  "digest-mismatch": "The request changed after it was shown to you — approval refused.",
  "record-integrity": "The stored approval record failed its integrity check.",
  expired: "The approval window has expired — ask the agent to request again.",
  "replay-consumed": "This request was already decided.",
  "identity-mismatch": "The approval was issued for a different workspace.",
  "audience-mismatch": "The approval is bound to a different session.",
  "rotation-superseded": "The session was rotated — this approval is no longer valid.",
};

/**
 * Broker + durably consume a scoped-confirmation decision. The client body is EXACTLY
 * `{ handle, digest, decision }`; `id` is the URL path segment naming the capability resource.
 *
 * Four properties the review made load-bearing:
 *
 *  1. BINDING (no cross-item / arbitrary-id substitution). The URL `id` IS the authoritative resource
 *     key — the capability handle. The record is loaded by `id` from the store (server data, never a
 *     client claim), and the body `handle` must echo the same `id`. A handle for one resource therefore
 *     cannot be approved through another resource's URL or through an arbitrary id.
 *  2. NO MISLEADING TOCTOU PRECHECK. We do NOT pre-decide accept/reject from an unlocked read. The single
 *     unlocked read exists only to build the content-free display projection `brokerDecision` needs; every
 *     accept/reject verdict — pending/consumed/expired, digest tamper, record integrity, identity, audience,
 *     epoch — is made INSIDE `consumeAndExecute`'s lock (a true compare-and-consume), and the HTTP response
 *     is derived from THAT locked result.
 *  3. DIGEST IS THE HUMAN'S CLAIM. The brokered envelope carries the client-supplied digest (what the human
 *     saw), so the locked consume's tamper gate genuinely compares it against the runtime's stored digest.
 *  4. AUDIENCE + EPOCH. The consuming session's `audience`/`epoch` (server-supplied via `session`, never the
 *     client) are plumbed through, so session binding and key/session rotation are enforced, not dormant.
 *
 * Returns `{ ok, status, ...payload }` — `status` is the HTTP status the route should emit.
 */
export async function decideInbox(repo, id, payload, session = {}) {
  const handle = payload && typeof payload.handle === "string" ? payload.handle : "";
  const digest = payload && typeof payload.digest === "string" ? payload.digest : "";
  const decision = payload && payload.decision;
  if (decision !== "approve" && decision !== "deny") {
    return { ok: false, status: 400, error: "decision must be 'approve' or 'deny'" };
  }
  // BINDING: the URL id is the authoritative resource; the body handle must name that same resource.
  // (Comparing the two request-supplied names only *scopes* the decision to one URL — the record itself
  // is loaded and validated from the store below, so this never trusts the client for authorization.)
  if (!handle) return { ok: false, status: 400, error: "handle is required" };
  if (handle !== id) {
    return { ok: false, status: 400, error: "handle does not match the decision resource" };
  }

  const loop = await loadLoop();
  const brokerDecision = loop && loop.brokerDecision;
  const makeJournal = loop && loop.createDurableCapabilityJournal;
  if (typeof brokerDecision !== "function") {
    return { ok: false, status: 503, error: "coordinator broker unavailable (build the loop)" };
  }

  // ONE unlocked read — used ONLY to build the content-free display projection the broker needs (operation
  // label + expiry). It never decides accept/reject; the locked consume re-folds and is the sole authority.
  const seed = loadRecord(repo, id);
  if (!seed) return { ok: false, status: 404, error: "unknown-handle" };

  const journal = typeof makeJournal === "function" ? makeJournal(repo) : undefined;
  // The projection carries the CLIENT digest (the human's claim), so the locked tamper gate is genuine.
  const projection = { ...projectionOf(seed), digest };
  const brokered = brokerDecision(
    projection,
    decision,
    journal ? { appendInboxEvent: journal } : {}
  );
  // Authoritative, locked compare-and-consume. `identity`/`audience`/`epoch` are server-supplied; the
  // owning runtime validates ITS record against them. Optional `session.now` is a test-only clock seam.
  const result = consumeAndExecute(repo, id, brokered, {
    identity: repo,
    audience: session.audience,
    epoch: session.epoch,
    ...(session.now !== undefined ? { now: session.now } : {}),
    execute: () => true,
    appendEvent: journal,
  });
  // The locked consume mutated the approval state; let the next queue/detail read reconcile
  // immediately so the UI reflects the decision without waiting out the throttle window.
  invalidateReconcileThrottle();

  if (result.kind === "rejected") {
    const status = REJECTION_STATUS[result.reason] ?? 409;
    if (result.reason === "denied") return { ok: true, status, result };
    // 4xx bodies must carry `error` — it is what the client surfaces (api.ts falls
    // back to the bare statusText otherwise, e.g. "Conflict").
    const error = REJECTION_MESSAGE[result.reason] ?? `Approval rejected: ${result.reason}.`;
    return { ok: false, status, error, result };
  }
  // native-receipt (approved + executed) or a typed outcome (crash-window / outcome_unknown) — both are
  // processed terminal states the client renders as-is.
  return { ok: true, status: 200, result };
}
