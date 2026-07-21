/** Native Gmail reply + content-free outbox routes for the local workspace GUI (AIO-392). */

import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createGogSendClient,
  gogTokenSecurityGate,
  gogTransportAccount,
} from "../../scripts/inbox-gog-adapter.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOOP_DIST = path.join(SCRIPT_DIR, "..", "..", "dist", "operator-loop", "index.js");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/i;

// Includes JSON framing, command id, and digest while keeping the only large field (body) at 100 KiB.
export const REPLY_REQUEST_MAX_BYTES = 112 * 1024;

// The outbox projection is newest-first; the UI needs the active command plus recent sent history,
// not the journal's entire lifetime.
export const OUTBOX_PROJECTION_LIMIT = 50;

let loopPromise;
export function loadOutboxLoop() {
  if (!loopPromise) loopPromise = import(pathToFileURL(LOOP_DIST).href).catch(() => null);
  return loopPromise;
}

function exactFields(payload, expected) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

export function validateReplyCheckPayload(payload) {
  if (!exactFields(payload, ["body"])) return "Request must contain exactly { body }.";
  if (typeof payload.body !== "string") return "Reply body must be a string.";
  return null;
}

export function validateReplySendPayload(payload) {
  if (!exactFields(payload, ["body", "command_id", "digest"])) {
    return "Request must contain exactly { command_id, digest, body }.";
  }
  if (typeof payload.body !== "string") return "Reply body must be a string.";
  if (typeof payload.command_id !== "string" || !UUID_RE.test(payload.command_id)) {
    return "command_id must be a UUID.";
  }
  if (typeof payload.digest !== "string" || !DIGEST_RE.test(payload.digest)) {
    return "digest must be a SHA-256 value.";
  }
  return null;
}

function safeDigestEqual(left, right) {
  if (!DIGEST_RE.test(left) || !DIGEST_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validationResponse(error, send = false) {
  if (error?.name !== "GmailReplyValidationError") throw error;
  if (error.code === "body-too-large") {
    return { status: 413, body: { ok: false, code: error.code, error: error.message } };
  }
  const bodyCode = new Set(["empty-body", "nul-body", "reserved-marker"]);
  if (bodyCode.has(error.code)) {
    return { status: 400, body: { ok: false, code: error.code, error: error.message } };
  }
  if (send) {
    return {
      status: 409,
      body: {
        ok: false,
        code: "no-longer-allowed",
        error: "This message can no longer be replied to safely here.",
      },
    };
  }
  if (error.code === "account-mismatch") {
    return {
      status: 409,
      body: {
        ok: false,
        code: "account-mismatch",
        error: "This message belongs to a different Gmail account.",
      },
    };
  }
  return {
    status: 409,
    body: {
      ok: false,
      code: "not-replyable",
      error: "This message can’t be replied to safely here. Open it in Gmail.",
    },
  };
}

async function currentItem(loop, repo, id, deps) {
  const view = deps.getInboxView ? await deps.getInboxView(repo) : loop.buildInbox(repo);
  return view.items.find((item) => item.id === id) ?? null;
}

/** Side-effect-free PDP/pre-send preview. */
export async function replyCheck(repo, id, payload, deps = {}) {
  const invalid = validateReplyCheckPayload(payload);
  if (invalid) return { status: 400, body: { ok: false, error: invalid } };
  const loop = deps.loop ?? (await (deps.loadLoop ?? loadOutboxLoop)());
  if (!loop) {
    return {
      status: 503,
      body: { ok: false, error: "The compiled inbox send pipeline is unavailable." },
    };
  }
  const item = await currentItem(loop, repo, id, deps);
  if (!item) return { status: 404, body: { ok: false, error: "Inbox item not found." } };

  try {
    const commandId = (deps.randomUUID ?? randomUUID)();
    const draft = loop.buildGmailReplyDraft({
      item,
      commandId,
      body: payload.body,
      expectedAccount: loop.configuredGmailAccount(deps.env ?? process.env),
    });
    const preparation = loop.prepareGmailReply(draft, loop.createMemoryJournalSink());
    if (!preparation.ok) {
      return {
        status: 200,
        body: {
          ok: false,
          stage: preparation.stage,
          code: preparation.code,
          error:
            preparation.stage === "pdp"
              ? "This reply is not allowed for the current Gmail thread."
              : "This reply did not pass the final safety check.",
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        command_id: draft.command_id,
        digest: draft.digest,
        preview: {
          to: draft.recipients.map((recipient) => recipient.address),
          subject: draft.subject,
          body: draft.body,
          thread_label: "Gmail thread",
        },
      },
    };
  } catch (error) {
    return validationResponse(error);
  }
}

/**
 * Buffer the PDP's decision records and write them only once the command lock is held.
 *
 * Deciding and recording are separated for two reasons: a reply the PDP refuses leaves no durable
 * trace at all (it was never authorized), and two racing confirmations of one command can't both
 * write a `pdp-decision` row — which matters because `projectOutboxCommands` joins each command's
 * thread_ref from exactly those rows.
 */
function bufferedPdpJournal(loop, repo, commandId, threadRef) {
  const pending = [];
  return {
    sink: {
      record(event) {
        pending.push(event);
      },
    },
    flush() {
      for (const event of pending) {
        loop.appendInboxEvent(repo, {
          kind: "pdp-decision",
          correlation_id: commandId,
          payload: { lane: "outbox", thread_ref: threadRef, ...event },
        });
      }
      pending.length = 0;
    },
  };
}

function retryAfterFor(loop, command) {
  if (!command.last_attempt_at) return null;
  const attemptedAt = Date.parse(command.last_attempt_at);
  if (!Number.isFinite(attemptedAt)) return null;
  return new Date(attemptedAt + loop.DEFAULT_RECONCILE_MIN_DELAY_MS).toISOString();
}

/** Revalidate the current item/digest, then durably authorize and send under the command lock. */
export async function replySend(repo, id, payload, deps = {}) {
  const invalid = validateReplySendPayload(payload);
  if (invalid) return { status: 400, body: { ok: false, error: invalid } };
  const loop = deps.loop ?? (await (deps.loadLoop ?? loadOutboxLoop)());
  if (!loop) {
    return {
      status: 503,
      body: { ok: false, error: "The compiled inbox send pipeline is unavailable." },
    };
  }
  const item = await currentItem(loop, repo, id, deps);
  if (!item) return { status: 404, body: { ok: false, error: "Inbox item not found." } };

  let draft;
  try {
    draft = loop.buildGmailReplyDraft({
      item,
      commandId: payload.command_id,
      body: payload.body,
      expectedAccount: loop.configuredGmailAccount(deps.env ?? process.env),
    });
  } catch (error) {
    return validationResponse(error, true);
  }

  // Digest equality is checked before durable journal, credential, lock, Sent query, or send access.
  if (!safeDigestEqual(draft.digest, payload.digest)) {
    return {
      status: 409,
      body: {
        ok: false,
        code: "digest-mismatch",
        error: "The reply changed after review. Review it again before sending.",
      },
    };
  }

  // Decide now (side-effect-free), record under the lock. A refusal never touches the journal.
  const pdpJournal = bufferedPdpJournal(loop, repo, draft.command_id, draft.thread_ref);
  const preparation = loop.prepareGmailReply(draft, pdpJournal.sink);
  if (!preparation.ok) {
    return {
      status: 409,
      body: {
        ok: false,
        code: "no-longer-allowed",
        error: "This reply is no longer allowed. Review the current message again.",
      },
    };
  }

  const credentialGate = deps.credentialGate ?? gogTokenSecurityGate;
  const credential = credentialGate(loop, { env: deps.env ?? process.env });
  if (!credential.ok) {
    return {
      status: 403,
      body: {
        ok: false,
        code: "credential-gate",
        error: "Gmail credentials are not secured for workspace sending.",
      },
    };
  }

  const acquireLock = deps.acquireLock ?? loop.acquireOutboxCommandLock;
  let lock;
  try {
    lock = acquireLock(repo, draft.command_id, deps.lockOptions);
  } catch (error) {
    if (error?.code === "send-in-progress" || error?.name === "OutboxSendInProgressError") {
      return {
        status: 409,
        body: {
          ok: false,
          code: "send-in-progress",
          error: "This reply is already being sent.",
        },
      };
    }
    throw error;
  }

  try {
    // The authorization record lands here, under the lock, not at decision time.
    pdpJournal.flush();

    // The final replay happens after lock acquisition and the lock remains held through both GOG calls.
    const journalRead = loop.readJournalSegments(repo);
    const priorEvents = journalRead.events
      .filter(loop.isOutboxLaneJournalEvent)
      .map(loop.journalEventToOutboxEvent);
    const makeClient = deps.createGogSendClient ?? createGogSendClient;
    const client = makeClient(loop, {
      // The gog CLI alias, NOT `draft.transport.account` — that is an observation identity label
      // (default "primary"), and passing it to `gog -a` breaks every call on a default-account gog.
      account: gogTransportAccount(deps.env ?? process.env),
      threadId: draft.transport.thread_id,
      commandId: draft.command_id,
      marker: loop.gmailReplyCommandMarker(draft.command_id),
      ...(deps.runGog ? { runGog: deps.runGog } : {}),
    });
    let command;
    try {
      command = await loop.executePreparedGmailReply({
        preparation,
        client,
        journal: loop.createDurableOutboxJournal(repo),
        priorEvents,
        ...(deps.now ? { now: deps.now } : {}),
      });
    } catch (error) {
      if (error?.name === "OutboxRetryDeferredError") {
        return {
          status: 429,
          body: {
            ok: false,
            deferred: true,
            retry_after: error.retryAfter ?? null,
            error: "Gmail is still confirming the previous send. Try again after the retry time.",
          },
        };
      }
      if (error?.name === "OutboxRejectedError") {
        return {
          status: 409,
          body: {
            ok: false,
            code: "no-longer-allowed",
            error: "This reply no longer passes the final safety check.",
          },
        };
      }
      throw error;
    }

    if (command.state === "sent" || command.state === "reconciled") {
      return {
        status: 200,
        body: {
          ok: true,
          command_id: command.command_id,
          state: command.state,
          native_message_id: command.native_message_id ?? null,
          native_thread_id: command.native_thread_id ?? null,
        },
      };
    }
    if (command.state === "outcome_unknown") {
      return {
        status: 200,
        body: {
          ok: false,
          command_id: command.command_id,
          state: command.state,
          code: "gmail-confirming",
          error: "Gmail may have accepted the reply. AIOS will check Sent before any retry.",
          retry_after: retryAfterFor(loop, command),
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: false,
        command_id: command.command_id,
        state: "failed",
        code: "gmail-send-failed",
        error: "Gmail did not accept the reply. Run a fresh check before trying again.",
      },
    };
  } finally {
    lock.release();
  }
}

/** Content-free durable outbox projection, bounded so a long-lived journal can't grow the payload. */
export async function getOutbox(repo, deps = {}) {
  const loop = deps.loop ?? (await (deps.loadLoop ?? loadOutboxLoop)());
  if (!loop) {
    return {
      status: 503,
      body: { ok: false, error: "The compiled inbox send pipeline is unavailable." },
    };
  }
  const all = loop.projectOutboxCommands(loop.readJournalSegments(repo).events);
  // Already sorted newest-first by last_attempt_at. The UI only ever needs the active command plus
  // recent sent history; older commands stay in the journal and remain readable via the inbox CLI.
  const commands = all.slice(0, OUTBOX_PROJECTION_LIMIT);
  return {
    status: 200,
    body: {
      commands,
      count: commands.length,
      total: all.length,
      truncated: all.length > commands.length,
      generated_at: new Date((deps.now ?? Date.now)()).toISOString(),
    },
  };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = REPLY_REQUEST_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        resolve({ tooLarge: true });
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve({ payload: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      } catch {
        resolve({ invalidJson: true });
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Mount before generic `/api/inbox/:id` routes. Returns true when it owns the request. */
export function handleOutboxApi(req, res, url, options) {
  const checkMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/reply-check$/);
  const sendMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/reply-send$/);
  const outboxMatch = url.pathname === "/api/outbox";
  if (!checkMatch && !sendMatch && !outboxMatch) return false;

  if (url.searchParams.get("token") !== options.token) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  const deps = options.deps ?? {};
  if (outboxMatch) {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    void getOutbox(options.repo, deps)
      .then((result) => json(res, result.status, result.body))
      .catch(() => json(res, 500, { ok: false, error: "Could not read the outbox." }));
    return true;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method not allowed" });
    return true;
  }
  void readJsonBody(req)
    .then(async (parsed) => {
      if (parsed.tooLarge) {
        json(res, 413, { ok: false, error: "request body too large" });
        return;
      }
      if (parsed.invalidJson) {
        json(res, 400, { ok: false, error: "request body must be valid JSON" });
        return;
      }
      const encodedId = checkMatch?.[1] ?? sendMatch?.[1] ?? "";
      let id;
      try {
        id = decodeURIComponent(encodedId);
      } catch {
        json(res, 400, { ok: false, error: "invalid inbox item id" });
        return;
      }
      const result = checkMatch
        ? await replyCheck(options.repo, id, parsed.payload, deps)
        : await replySend(options.repo, id, parsed.payload, deps);
      json(res, result.status, result.body);
    })
    .catch(() => json(res, 500, { ok: false, error: "Could not process the reply request." }));
  return true;
}
