/**
 * Native Gmail reply preparation for the Unified Inbox GUI (AIO-392).
 *
 * This module is the typed boundary between a projected inbox item and the existing reply PDP /
 * outbox. Browser input is deliberately limited to the body. Every destination field is rebuilt
 * from the enriched GOG observation, and the confirmation digest binds those server-derived fields
 * to the exact bytes checked by `checkPreSend`.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { InboxItem } from "./cli.js";
import type { ProjectedItem } from "./observations.js";
import {
  checkPreSend,
  createOutbox,
  foldOutboxState,
  type AppendOutboxEvent,
  type OutboxCommand,
  type OutboxEvent,
  type OutboxSendClient,
} from "./outbox.js";
import {
  decideReply,
  type ParticipantIdentity,
  type PdpDecision,
  type PdpJournalSink,
  type ReplyRequest,
  type ThreadContext,
} from "./reply-policy.js";

export const MAX_REPLY_BODY_BYTES = 100 * 1024;
export const GMAIL_REPLY_SUBJECT_CODE_POINTS = 200;
export const OUTBOX_COMMAND_LOCK_STALE_MS = 5 * 60 * 1000;
export const OUTBOX_COMMAND_LOCKS_REL = path.join(".aios", "loop", "inbox", "outbox-locks");
export const RESERVED_OUTBOX_MARKER = "aios-outbox-cmd:";

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
const SINGLE_EMAIL_RE =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu;
const OUTBOX_EVENT_KINDS = new Set(["action-attempt", "outcome", "native-receipt"]);

export type GmailReplyErrorCode =
  | "not-thread-item"
  | "legacy-observation"
  | "not-gog-observation"
  | "deleted-observation"
  | "not-email"
  | "missing-native-id"
  | "missing-thread-id"
  | "missing-account"
  | "missing-tenant"
  | "missing-subject"
  | "account-mismatch"
  | "invalid-sender"
  | "empty-body"
  | "body-too-large"
  | "nul-body"
  | "reserved-marker";

export class GmailReplyValidationError extends Error {
  readonly code: GmailReplyErrorCode;

  constructor(code: GmailReplyErrorCode, message: string) {
    super(message);
    this.name = "GmailReplyValidationError";
    this.code = code;
  }
}

export class OutboxSendInProgressError extends Error {
  readonly code = "send-in-progress" as const;

  constructor() {
    super("Another confirmation for this send is already in progress.");
    this.name = "OutboxSendInProgressError";
  }
}

export interface GmailReplyIdentity {
  item_id: string;
  observation: ProjectedItem;
  account: string;
  tenant: string;
  thread_id: string;
  thread_ref: string;
  recipients: ParticipantIdentity[];
  subject: string;
}

export interface GmailReplyDraft extends GmailReplyIdentity {
  command_id: string;
  body: string;
  reply_request: ReplyRequest;
  thread: ThreadContext;
  exact_outbound_bytes: string;
  digest: string;
  transport: {
    provider: "gmail";
    account: string;
    thread_id: string;
  };
}

export type GmailReplyPreparation =
  | { ok: true; draft: GmailReplyDraft; decision: PdpDecision }
  | {
      ok: false;
      draft: GmailReplyDraft;
      decision: PdpDecision;
      stage: "pdp" | "pre_send";
      code: string;
      error: string;
    };

export interface OutboxCommandSummary {
  command_id: string;
  state: OutboxCommand["state"];
  thread_ref: string | null;
  native_message_id: string | null;
  native_thread_id: string | null;
  last_attempt_at: string | null;
}

export interface InboxJournalEventLike {
  kind: string;
  correlation_id: string | null;
  ts: string;
  payload?: Record<string, unknown>;
}

export interface OutboxCommandLock {
  path: string;
  release(): void;
}

function required(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validSenderAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (!address || address.length > 254 || CONTROL_CHAR_RE.test(address)) return null;
  if (!SINGLE_EMAIL_RE.test(address)) return null;
  const local = address.slice(0, address.lastIndexOf("@"));
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return null;
  }
  return address.toLowerCase();
}

/** Derive the configured GUI account without letting the browser select one. */
export function configuredGmailAccount(env: NodeJS.ProcessEnv = process.env): string {
  return required(env.GOG_ACCOUNT) || "primary";
}

/**
 * Sanitize and bound the Gmail subject without allowing a header delimiter through.
 *
 * The input MUST be the observation's native subject. It is deliberately NOT the observation's
 * `snippet` — that field is a BODY excerpt (see `toRankInput`, which maps `snippet` to `body`), and
 * replying with it would put message body text in the Subject header of every reply.
 */
export function deriveGmailReplySubject(subject: unknown): string {
  const cleaned = (typeof subject === "string" ? subject : "").replace(/[\r\n]+/gu, " ").trim();
  const reply = cleaned
    ? /^re\s*:/iu.test(cleaned)
      ? cleaned
      : `Re: ${cleaned}`
    : "Re: (no subject)";
  return Array.from(reply).slice(0, GMAIL_REPLY_SUBJECT_CODE_POINTS).join("");
}

/** Validate the only browser-controlled content while preserving its bytes exactly. */
export function validateGmailReplyBody(body: unknown): asserts body is string {
  if (typeof body !== "string") {
    throw new GmailReplyValidationError("empty-body", "Reply body must be a string.");
  }
  if (!body.trim()) {
    throw new GmailReplyValidationError("empty-body", "Write a reply before reviewing it.");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_REPLY_BODY_BYTES) {
    throw new GmailReplyValidationError(
      "body-too-large",
      "Reply body is larger than the 100 KiB limit."
    );
  }
  if (body.includes("\0")) {
    throw new GmailReplyValidationError("nul-body", "Reply body contains a NUL character.");
  }
  if (body.toLowerCase().includes(RESERVED_OUTBOX_MARKER)) {
    throw new GmailReplyValidationError(
      "reserved-marker",
      "Reply body contains a reserved send marker."
    );
  }
}

/** The stable marker queried in Gmail Sent before every possible send. */
export function gmailReplyCommandMarker(commandId: string): string {
  return `${RESERVED_OUTBOX_MARKER}${commandId}`;
}

/**
 * Build the exact RFC822-shaped bytes consumed by both `checkPreSend` and the GOG adapter.
 *
 * Cc/Bcc are carried because `parseOutboundMessage` + `checkPreSend` both validate those headers and
 * the GOG adapter builds `--cc`/`--bcc` argv from them. The GUI reply path never populates them (the
 * browser cannot choose recipients), but the CLI draft path may.
 */
export function buildGmailReplyOutboundBytes(input: {
  commandId: string;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  body: string;
}): string {
  validateGmailReplyBody(input.body);
  const headers = [`To: ${input.to.join(", ")}`];
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(", ")}`);
  headers.push(`Subject: ${input.subject}`);
  const footer = `\n\n-- \n${gmailReplyCommandMarker(input.commandId)}`;
  return `${headers.join("\n")}\n\n${input.body}${footer}\n`;
}

/** Validate item provenance and derive every immutable Gmail destination field server-side. */
export function deriveGmailReplyIdentity(
  item: InboxItem,
  expectedAccount = configuredGmailAccount()
): GmailReplyIdentity {
  if (!item || item.origin !== "thread-state" || !item.observation) {
    throw new GmailReplyValidationError(
      "not-thread-item",
      "Only Gmail thread items can be replied to here."
    );
  }
  const observation = item.observation;
  if (observation.origin !== "enriched") {
    throw new GmailReplyValidationError(
      "legacy-observation",
      "This message does not carry verified Gmail identity."
    );
  }
  if (observation.deleted) {
    throw new GmailReplyValidationError("deleted-observation", "This Gmail message was deleted.");
  }
  if (observation.object_kind !== "email") {
    throw new GmailReplyValidationError("not-email", "This item is not a Gmail message.");
  }

  const nativeId = required(observation.native_id);
  const threadId = required(observation.thread_id);
  const account = required(observation.account);
  const tenant = required(observation.tenant);
  const nativeSubject = required(observation.subject);
  if (!nativeId) {
    throw new GmailReplyValidationError("missing-native-id", "Gmail message identity is missing.");
  }
  if (!threadId) {
    throw new GmailReplyValidationError("missing-thread-id", "Gmail thread identity is missing.");
  }
  if (!account) {
    throw new GmailReplyValidationError("missing-account", "Gmail account identity is missing.");
  }
  if (!tenant) {
    throw new GmailReplyValidationError("missing-tenant", "Gmail tenant identity is missing.");
  }
  // Fail closed rather than fall back to `snippet`: the snippet is a body excerpt, so substituting it
  // would send body text as the Subject header. An item whose adapter carried no subject is simply
  // not natively replyable and falls back to the "Open in Gmail" affordance.
  if (!nativeSubject) {
    throw new GmailReplyValidationError(
      "missing-subject",
      "This message does not carry a verified Gmail subject."
    );
  }
  const connectionId = required(observation.connection_id);
  if (connectionId !== `gog:${account}`) {
    throw new GmailReplyValidationError(
      "not-gog-observation",
      "This message was not produced by the trusted GOG Gmail adapter."
    );
  }
  if (account !== expectedAccount) {
    throw new GmailReplyValidationError(
      "account-mismatch",
      "This message belongs to a different Gmail account."
    );
  }

  const addresses = new Set<string>();
  const participants = Array.isArray(observation.participants) ? observation.participants : [];
  for (const participant of participants) {
    if (participant.role !== "from") continue;
    const address = validSenderAddress(participant.id);
    if (address) addresses.add(address);
  }
  if (addresses.size === 0) {
    throw new GmailReplyValidationError(
      "invalid-sender",
      "The Gmail sender could not be verified as one email address."
    );
  }

  const recipients = [...addresses].map((address) => ({
    account,
    tenant,
    address,
    verified: true,
  }));
  const threadRef = `gmail:${threadId}`;
  return {
    item_id: item.id,
    observation,
    account,
    tenant,
    thread_id: threadId,
    thread_ref: threadRef,
    recipients,
    subject: deriveGmailReplySubject(nativeSubject),
  };
}

export function isGmailReplyable(
  item: InboxItem,
  expectedAccount = configuredGmailAccount()
): { replyable: true } | { replyable: false; code: GmailReplyErrorCode } {
  try {
    deriveGmailReplyIdentity(item, expectedAccount);
    return { replyable: true };
  } catch (error) {
    if (error instanceof GmailReplyValidationError) {
      return { replyable: false, code: error.code };
    }
    throw error;
  }
}

export function confirmationDigest(input: {
  item_id: string;
  exact_outbound_bytes: string;
  transport: GmailReplyDraft["transport"];
}): string {
  const canonical = JSON.stringify({
    schema_version: 1,
    item_id: input.item_id,
    exact_outbound_bytes: input.exact_outbound_bytes,
    transport: {
      provider: "gmail",
      account: input.transport.account,
      thread_id: input.transport.thread_id,
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Rebuild a complete immutable draft from a current item plus the browser's body. */
export function buildGmailReplyDraft(input: {
  item: InboxItem;
  commandId: string;
  body: string;
  expectedAccount?: string;
}): GmailReplyDraft {
  validateGmailReplyBody(input.body);
  const identity = deriveGmailReplyIdentity(input.item, input.expectedAccount);
  const replyRequest: ReplyRequest = {
    thread_ref: identity.thread_ref,
    evidence: [
      {
        id: identity.observation.native_id,
        kind: "thread-message",
        origin_thread: identity.thread_ref,
        tier: "admin",
      },
    ],
    recipients: identity.recipients,
    channel: { channel_type: "email", thread_ref: identity.thread_ref },
    attachments: [],
    quoted_refs: [],
    delegations: [],
  };
  const thread: ThreadContext = {
    thread_ref: identity.thread_ref,
    participants: identity.recipients,
    channel_type: "email",
  };
  const exactOutboundBytes = buildGmailReplyOutboundBytes({
    commandId: input.commandId,
    to: identity.recipients.map((recipient) => recipient.address),
    subject: identity.subject,
    body: input.body,
  });
  const transport = {
    provider: "gmail" as const,
    account: identity.account,
    thread_id: identity.thread_id,
  };
  return {
    ...identity,
    command_id: input.commandId,
    body: input.body,
    reply_request: replyRequest,
    thread,
    exact_outbound_bytes: exactOutboundBytes,
    digest: confirmationDigest({
      item_id: identity.item_id,
      exact_outbound_bytes: exactOutboundBytes,
      transport,
    }),
    transport,
  };
}

/** Run the existing PDP and exact-byte pre-send check without touching a transport. */
export function prepareGmailReply(
  draft: GmailReplyDraft,
  journal: PdpJournalSink
): GmailReplyPreparation {
  const decision = decideReply(draft.reply_request, { thread: draft.thread, journal });
  if (decision.verdict !== "allow") {
    return {
      ok: false,
      draft,
      decision,
      stage: "pdp",
      code: decision.rule_id,
      error: decision.explanation,
    };
  }
  const preSend = checkPreSend(
    {
      reply_request: draft.reply_request,
      exact_outbound_bytes: draft.exact_outbound_bytes,
    },
    decision,
    { kind: "direct" }
  );
  if (!preSend.ok) {
    return {
      ok: false,
      draft,
      decision,
      stage: "pre_send",
      code: preSend.reason,
      error: preSend.detail,
    };
  }
  return { ok: true, draft, decision };
}

/**
 * Execute only a fully prepared draft through the existing idempotent outbox.
 *
 * Async because the transport is: a real GOG send spawns a subprocess, and the GUI server cannot
 * block its event loop on it. The command lock — held by the caller across this call — is what keeps
 * concurrent confirmations of one command serialized.
 */
export async function executePreparedGmailReply(input: {
  preparation: Extract<GmailReplyPreparation, { ok: true }>;
  client: OutboxSendClient;
  journal: AppendOutboxEvent;
  priorEvents?: readonly OutboxEvent[];
  now?: () => number;
}): Promise<OutboxCommand> {
  const outbox = createOutbox({
    client: input.client,
    journal: input.journal,
    priorEvents: input.priorEvents,
    ...(input.now ? { now: input.now } : {}),
  });
  return outbox.sendApproved({
    command_id: input.preparation.draft.command_id,
    reply_request: input.preparation.draft.reply_request,
    exact_outbound_bytes: input.preparation.draft.exact_outbound_bytes,
    decision: input.preparation.decision,
  });
}

/** True only for lifecycle events belonging to the durable outbox lane. */
export function isOutboxLaneJournalEvent(event: InboxJournalEventLike): boolean {
  if (!OUTBOX_EVENT_KINDS.has(event.kind)) return false;
  const payload = event.payload ?? {};
  if (payload.lane != null) return payload.lane === "outbox";
  if (event.kind === "outcome") return !("result" in payload);
  if (event.kind === "native-receipt") return !("receipt_id" in payload);
  return true;
}

export function journalEventToOutboxEvent(event: InboxJournalEventLike): OutboxEvent {
  return {
    kind: event.kind as OutboxEvent["kind"],
    command_id: event.correlation_id ?? "",
    at: event.ts,
    data: event.payload ?? {},
  };
}

/** Fold content-free lifecycle rows and join their Gmail thread from the PDP decision event. */
export function projectOutboxCommands(
  events: readonly InboxJournalEventLike[]
): OutboxCommandSummary[] {
  const threadRefs = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload ?? {};
    if (
      event.kind === "pdp-decision" &&
      payload.lane === "outbox" &&
      event.correlation_id &&
      typeof payload.thread_ref === "string"
    ) {
      threadRefs.set(event.correlation_id, payload.thread_ref);
    }
  }
  const folded = foldOutboxState(
    events.filter(isOutboxLaneJournalEvent).map(journalEventToOutboxEvent)
  );
  return [...folded.entries()]
    .map(([commandId, command]) => ({
      command_id: commandId,
      state: command.state,
      thread_ref: threadRefs.get(commandId) ?? null,
      native_message_id: command.native_message_id ?? null,
      native_thread_id: command.native_thread_id ?? null,
      last_attempt_at: command.last_attempt_at ?? null,
    }))
    .sort((a, b) => (b.last_attempt_at ?? "").localeCompare(a.last_attempt_at ?? ""));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(lockPath: string): { token?: string; pid?: number; created_at?: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    return {
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
    };
  } catch {
    return null;
  }
}

function unlinkLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeLockIfTokenMatches(lockPath: string, token: string): void {
  const current = readLock(lockPath);
  if (current?.token !== token) return;
  unlinkLock(lockPath);
}

/**
 * Age of a lock whose contents we could not read. `openSync(…, "wx")` creates the file BEFORE it is
 * written, so a crash in between leaves a zero-byte lock with no token — falling back to mtime is
 * what keeps that from wedging the command forever.
 */
function lockAgeMsFromMtime(lockPath: string, nowMs: number): number {
  try {
    return nowMs - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Acquire one cross-process lock for a command before journal replay/reconciliation/send. */
export function acquireOutboxCommandLock(
  root: string,
  commandId: string,
  options: { now?: () => number; staleMs?: number } = {}
): OutboxCommandLock {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? OUTBOX_COMMAND_LOCK_STALE_MS;
  const locksDir = path.join(root, OUTBOX_COMMAND_LOCKS_REL);
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const filename = `${createHash("sha256").update(commandId, "utf8").digest("hex")}.lock`;
  const lockPath = path.join(locksDir, filename);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomBytes(24).toString("hex");
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        fd,
        JSON.stringify({ token, pid: process.pid, created_at: new Date(now()).toISOString() }),
        "utf8"
      );
      closeSync(fd);
      fd = null;
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          removeLockIfTokenMatches(lockPath, token);
        },
      };
    } catch (error) {
      if (fd != null) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(lockPath);
      if (!holder?.token) {
        // An unreadable/zero-byte lock carries no owner to compare against, so token-matched removal
        // can never reclaim it. Age it by mtime instead and unlink once stale — otherwise a crash
        // between create and write wedges this command permanently.
        if (lockAgeMsFromMtime(lockPath, now()) > staleMs) {
          unlinkLock(lockPath);
          continue;
        }
        throw new OutboxSendInProgressError();
      }
      const createdAt = holder.created_at ? Date.parse(holder.created_at) : Number.NaN;
      const stale = !Number.isFinite(createdAt) || now() - createdAt > staleMs;
      const dead = !holder.pid || !processIsAlive(holder.pid);
      if (stale || dead) {
        removeLockIfTokenMatches(lockPath, holder.token);
        continue;
      }
      throw new OutboxSendInProgressError();
    }
  }
  throw new OutboxSendInProgressError();
}
