// Unified inbox - Outbox + Gmail send (I-11 / AIO-392, the G5 gate).
//
// The first real ACTION on the deep channel: send a Gmail reply through the I-10 reply PDP with an
// idempotent outbox and native receipts. This completes the G4->G5 vertical (read -> reply -> send).
//
// Trust model + honest claim scope (spec tier-safety):
//   - Outbound content crosses the boundary ONLY under an `allow` PdpDecision (origin-confined, I-10).
//     `enqueue` refuses anything else - a `deny`/`needs_promotion` decision is a typed rejection.
//   - Deterministic pre-send checks run on the EXACT outbound bytes (never model output / thread
//     text): recipients parsed from the validated header block must EQUAL the PDP-approved set;
//     header-injection, quoted-thread smuggling, and admin-context leak markers are typed rejections.
//     Body text can never expand the recipient set - recipients come only from the structured,
//     schema-validated To/Cc/Bcc headers, so crafted quoted content is inert here.
//   - At-most-once actual sends per `command_id`: email send is RECONCILE-FIRST - every attempt
//     queries the Sent folder for the command's marker BEFORE any (re)send, so a timeout, a crash
//     between attempt and receipt, or a retry never produces a duplicate or a misdirected send.
//   - Delegation carries an explicit SCOPED capability (an I-03 handle), never ambient authority.
//   - Outbox records + receipts are admin-tier LOCAL journal state (I-02 action-attempt / outcome /
//     native-receipt events) - content-free (state / rule / counts / native ids, never body bytes)
//     and NEVER synced to the Team Brain. `src/operator-loop/comms/sender.ts` stays byte-untouched.
//   - Claim scope, stated everywhere: "the inbox code path is gated" at G5 - on John's Mac the
//     ambient `gog` CLI still exists; the full cannot-bypass credential broker + per-adapter uid
//     isolation belong to G6b (I-15) and are never advertised earlier.
//
// The `outbox` code depends on the I-10 reply-policy TYPES only (same inbox domain). The gog send
// surface and the durable journal are INJECTED (no cross-domain value imports; the loop composes the
// durable journal sink in ../index.ts via `createDurableOutboxJournal`).

import type { PdpDecision, ReplyRequest } from "./reply-policy.js";

// -- outbox state machine --------------------------------------------------------------------------

/**
 * The outbox lifecycle. `queued` -> `attempting` -> (`sent` | `failed` | `outcome_unknown`); an
 * `outcome_unknown`/`attempting` command is resolved by reconcile-first on the next attempt into
 * `reconciled` (proven already in Sent) or a fresh terminal state. `reconciled` and `sent` are the
 * at-most-once terminals: a command in either state never sends again.
 */
export type OutboxState =
  "queued" | "attempting" | "sent" | "failed" | "outcome_unknown" | "reconciled";

/** A queued/attempted outbound command. `exact_outbound_bytes` is the canonical wire message the
 *  pre-send checks + gog send both operate on - byte-for-byte, no re-serialization between check
 *  and send. */
export interface OutboxCommand {
  /** Idempotency key. Re-enqueue is a no-op; at-most-once send is keyed on this. */
  command_id: string;
  /** The I-10 PDP-approved reply request (structured refs only). */
  reply_request: ReplyRequest;
  /** The exact bytes handed to the transport (RFC822-shaped: header block, blank line, body). */
  exact_outbound_bytes: string;
  state: OutboxState;
  /** Native Gmail message id, set once a receipt is observed/reconciled. */
  native_message_id?: string;
  /** Native Gmail thread id, set once a receipt is observed/reconciled. */
  native_thread_id?: string;
  /** Recipients a multi-recipient send rejected (partial failure); empty on full success. */
  rejected_recipients?: string[];
}

// -- typed rejections ------------------------------------------------------------------------------

/** Why a command was rejected BEFORE any send (policy / pre-send / authority). Never a silent drop. */
export type OutboxRejectReason =
  | "not-allowed" // the PdpDecision was not `allow`
  | "recipient-mismatch" // header recipients != the PDP-approved set
  | "header-injection" // the header block violated the strict outbound schema
  | "quoted-thread-smuggle" // the body smuggled a recipient/header line
  | "admin-context-leak" // an admin-context marker appeared in the bytes
  | "ambient-delegation"; // a delegated send arrived without a scoped capability handle

/** A pre-send / policy rejection. Carries a stable `reason` code so callers + tests pin the surface. */
export class OutboxRejectedError extends Error {
  readonly reason: OutboxRejectReason;
  constructor(reason: OutboxRejectReason, message: string) {
    super(`outbox rejected (${reason}): ${message}`);
    this.name = "OutboxRejectedError";
    this.reason = reason;
  }
}

/** The transport timed out with an UNKNOWN outcome - the send may or may not have landed. The outbox
 *  never resends on this without a reconcile-first Sent query. */
export class OutboxTimeoutError extends Error {
  constructor(message = "gog send timed out (outcome unknown)") {
    super(message);
    this.name = "OutboxTimeoutError";
  }
}

/** The transport failed definitively (no message created). Safe to treat as `failed`. */
export class OutboxSendError extends Error {
  constructor(message = "gog send failed") {
    super(message);
    this.name = "OutboxSendError";
  }
}

// -- injected transport (gog faked at the process boundary in CI) ----------------------------------

/** The result of one native send. `rejected_recipients` is non-empty on a multi-recipient partial
 *  failure (the message was still created for the accepted recipients - never resend). */
export interface OutboxSendResult {
  message_id: string;
  thread_id: string;
  rejected_recipients?: string[];
}

/** The result of a reconcile-first Sent-folder query keyed on the command marker. */
export interface SentQuery {
  found: boolean;
  message_id?: string;
  thread_id?: string;
}

/**
 * The gog send surface, injected. In CI this is a recorded-fixture fake (no live Gmail); production
 * wraps the real `gog gmail send` behind the gateway credential wrapper. `send` MUST throw
 * `OutboxTimeoutError` on an unknown-outcome timeout and `OutboxSendError` on a definitive failure.
 */
export interface OutboxSendClient {
  /** Reconcile-first: is a message carrying this command's marker already in Sent? */
  querySent(commandId: string): SentQuery;
  /** Send the EXACT bytes. Throws `OutboxTimeoutError` / `OutboxSendError` per above. */
  send(exactOutboundBytes: string): OutboxSendResult;
}

// -- injected journal seam (I-02) ------------------------------------------------------------------

/** The I-02 event kinds the outbox emits (a subset of `INBOX_EVENT_KINDS`). */
export type OutboxEventKind = "action-attempt" | "outcome" | "native-receipt";

/**
 * A content-free, command-keyed lifecycle event. The composition bridge (`createDurableOutboxJournal`)
 * maps it onto a real I-02 `AppendEventInput`: `command_id -> correlation_id`, `at -> ts`,
 * `data -> payload`. `data` MUST stay content-free (state / rule / counts / native ids - NEVER body
 * bytes, recipient addresses, or subject text).
 */
export interface OutboxEvent {
  kind: OutboxEventKind;
  command_id: string;
  at: string;
  data?: Record<string, unknown>;
}

/** The injected journal-append seam. Production supplies `createDurableOutboxJournal(root)`. */
export type AppendOutboxEvent = (event: OutboxEvent) => void;

/** TEST UTILITY: an in-memory journal recording the outbox lifecycle without touching disk. */
export function createInMemoryOutboxJournal(): {
  events: OutboxEvent[];
  append: AppendOutboxEvent;
} {
  const events: OutboxEvent[] = [];
  return { events, append: (e) => void events.push(e) };
}

// -- delegation scoping ----------------------------------------------------------------------------

/** The authority a send runs under. A `delegated` send MUST carry an explicit scoped capability
 *  handle (I-03) - never ambient authority. `direct` is the owner acting in their own session. */
export type SendAuthority = { kind: "direct" } | { kind: "delegated"; capabilityHandle: string };

const DIRECT_AUTHORITY: SendAuthority = { kind: "direct" };

// -- exact-outbound-bytes pre-send checks ----------------------------------------------------------

/**
 * Admin-context leak marker corpus. If ANY marker appears in the exact outbound bytes (header or
 * body), the send is rejected - the fixtures exercise hostile threads that try to exfiltrate admin
 * context into the reply. Real replies never carry these; they are a deterministic tripwire, not a
 * classifier. Overridable per-outbox for tests.
 */
export const ADMIN_CONTEXT_MARKERS: readonly string[] = Object.freeze([
  "[ADMIN-CONTEXT]",
  "X-AIOS-Tier: admin",
  "BEGIN-PRIVATE-LEDGER",
  "AIOS-PRIVATE-CONTEXT",
]);

/** The header names the canonical outbound schema permits. Anything else in the header block is a
 *  header-injection rejection (a smuggled `Bcc:`/`Reply-To:`/arbitrary header). */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "to",
  "cc",
  "bcc",
  "from",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "x-aios-command-id",
]);

/** Recipient-bearing headers (parsed into the outbound recipient set). */
const RECIPIENT_HEADERS: ReadonlySet<string> = new Set(["to", "cc", "bcc"]);

/** Headers that must appear at most once (a duplicate is a header-injection smuggle). */
const SINGLETON_HEADERS: ReadonlySet<string> = new Set([
  "to",
  "cc",
  "bcc",
  "from",
  "subject",
  "date",
  "message-id",
  "x-aios-command-id",
]);

interface ParsedHeaders {
  /** header name (lowercased) -> array of values, in appearance order. */
  values: Map<string, string[]>;
  /** true if any header line lacked a `name: value` form. */
  malformed: boolean;
  body: string;
}

/** Split the RFC822-shaped bytes at the first blank line into a header map + body. Header folding
 *  (a continuation line starting with SP/TAB) is joined onto the prior header value. */
function parseHeaderBlock(bytes: string): ParsedHeaders {
  const normalized = bytes.replace(/\r\n/g, "\n");
  const sepIdx = normalized.indexOf("\n\n");
  const headerText = sepIdx === -1 ? normalized : normalized.slice(0, sepIdx);
  const body = sepIdx === -1 ? "" : normalized.slice(sepIdx + 2);
  const values = new Map<string, string[]>();
  const rawLines = headerText.split("\n");
  const logical: string[] = [];
  for (const line of rawLines) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && logical.length > 0) {
      logical[logical.length - 1] += " " + line.trim();
    } else {
      logical.push(line);
    }
  }
  let malformed = false;
  for (const line of logical) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      malformed = true;
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const bucket = values.get(name) ?? [];
    bucket.push(value);
    values.set(name, bucket);
  }
  return { values, malformed, body };
}

/** Split a recipient header value into individual addresses (comma-separated, angle-brackets
 *  stripped). Addresses are opaque ids, never parsed as free text beyond extracting the addr-spec. */
function splitAddresses(value: string): string[] {
  return value
    .split(",")
    .map((a) => {
      const m = a.match(/<([^>]+)>/);
      return (m ? (m[1] as string) : a).trim().toLowerCase();
    })
    .filter((a) => a.length > 0);
}

/** The set of PDP-approved recipient addresses (from the I-10 request the decision covered). */
export function approvedRecipientSet(request: ReplyRequest): Set<string> {
  const set = new Set<string>();
  for (const r of request.recipients) {
    if (typeof r.address === "string" && r.address.trim()) set.add(r.address.trim().toLowerCase());
  }
  return set;
}

/** Recipients parsed from the (schema-validated) outbound header block. */
export function outboundRecipientSet(bytes: string): Set<string> {
  const { values } = parseHeaderBlock(bytes);
  const set = new Set<string>();
  for (const h of RECIPIENT_HEADERS) {
    for (const v of values.get(h) ?? []) {
      for (const addr of splitAddresses(v)) set.add(addr);
    }
  }
  return set;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const PRESEND_OK = { ok: true } as const;

/**
 * Run every deterministic pre-send check on the EXACT outbound bytes + the PDP decision + authority.
 * Returns `{ ok: true }` or `{ ok: false, reason, detail }` - the caller turns a failure into an
 * `OutboxRejectedError`. Pure + deterministic: same inputs -> same verdict (no I/O, no clock).
 * Priority is fixed so a fixture always hits its intended reason (most-structural first).
 */
export function checkPreSend(
  command: Pick<OutboxCommand, "reply_request" | "exact_outbound_bytes">,
  decision: PdpDecision,
  authority: SendAuthority,
  adminMarkers: readonly string[] = ADMIN_CONTEXT_MARKERS
): { ok: true } | { ok: false; reason: OutboxRejectReason; detail: string } {
  // (0) Only an `allow` decision may cross the boundary.
  if (decision.verdict !== "allow") {
    return {
      ok: false,
      reason: "not-allowed",
      detail: `decision verdict is "${decision.verdict}"`,
    };
  }

  // (1) Delegation must be scoped (I-03 handle) - never ambient authority.
  const delegations = command.reply_request.delegations ?? [];
  if (delegations.length > 0 && authority.kind !== "delegated") {
    return {
      ok: false,
      reason: "ambient-delegation",
      detail:
        "a delegated capability is present but the send runs under ambient (direct) authority",
    };
  }
  if (authority.kind === "delegated" && !authority.capabilityHandle.trim()) {
    return {
      ok: false,
      reason: "ambient-delegation",
      detail: "delegated authority carries no scoped capability handle",
    };
  }

  const bytes = command.exact_outbound_bytes;
  const { values, malformed, body } = parseHeaderBlock(bytes);

  // (2) Strict header-block schema: no malformed lines, no unknown headers, no duplicate singletons,
  //     no control chars in a header value. Any violation is a header-injection smuggle.
  if (malformed) {
    return {
      ok: false,
      reason: "header-injection",
      detail: "a header line has no name:value form",
    };
  }
  for (const [name, vs] of values) {
    if (!ALLOWED_HEADERS.has(name)) {
      return { ok: false, reason: "header-injection", detail: `disallowed header "${name}"` };
    }
    if (SINGLETON_HEADERS.has(name) && vs.length > 1) {
      return {
        ok: false,
        reason: "header-injection",
        detail: `header "${name}" appears ${vs.length} times (duplicate smuggle)`,
      };
    }
    for (const v of vs) {
      if (CONTROL_CHAR_RE.test(v)) {
        return {
          ok: false,
          reason: "header-injection",
          detail: `header "${name}" carries a control character (CRLF injection)`,
        };
      }
    }
  }

  // (3) Quoted-thread smuggle: the body must not carry a line that looks like a smuggled recipient
  //     header (`To:`/`Cc:`/`Bcc:`), quoted or not. Body text can never add recipients, but an
  //     attempt to do so is a hostile signal we reject rather than silently ignore.
  for (const line of body.split("\n")) {
    if (/^\s*>?\s*(to|cc|bcc)\s*:/i.test(line)) {
      return {
        ok: false,
        reason: "quoted-thread-smuggle",
        detail: "the body carries a smuggled recipient header line",
      };
    }
  }

  // (4) Admin-context leak markers anywhere in the bytes.
  for (const marker of adminMarkers) {
    if (bytes.includes(marker)) {
      return { ok: false, reason: "admin-context-leak", detail: "admin-context marker present" };
    }
  }

  // (5) Recipient set must EQUAL the PDP-approved set - no addition, no omission.
  const approved = approvedRecipientSet(command.reply_request);
  const outbound = outboundRecipientSet(bytes);
  if (approved.size !== outbound.size || [...outbound].some((a) => !approved.has(a))) {
    return {
      ok: false,
      reason: "recipient-mismatch",
      detail: `outbound recipients (${outbound.size}) != PDP-approved (${approved.size})`,
    };
  }
  if ([...approved].some((a) => !outbound.has(a))) {
    return {
      ok: false,
      reason: "recipient-mismatch",
      detail: "an approved recipient is missing from the outbound bytes",
    };
  }

  return PRESEND_OK;
}

// -- outbox facade (idempotent enqueue + at-most-once, journal-durable) ----------------------------

/** What `enqueue` accepts: the command + the I-10 decision that authorizes it. */
export interface EnqueueInput {
  command_id: string;
  reply_request: ReplyRequest;
  exact_outbound_bytes: string;
  /** The I-10 reply PDP decision. Must be `allow`; anything else is a typed rejection. */
  decision: PdpDecision;
}

export interface OutboxDeps {
  client: OutboxSendClient;
  journal: AppendOutboxEvent;
  /** Injected clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Override the admin-context marker corpus (tests). */
  adminMarkers?: readonly string[];
  /** Prior journal events to fold on construction (crash recovery). */
  priorEvents?: readonly OutboxEvent[];
}

interface FoldedState {
  state: OutboxState;
  native_message_id?: string;
  native_thread_id?: string;
}

/**
 * Fold a stream of outbox journal events into the durable per-command state. Used on startup so a
 * command that was `attempting` (a crash between attempt and receipt) is recovered as needing a
 * reconcile-first query, never a blind resend. Content-free events -> state only (no bytes).
 */
export function foldOutboxState(events: readonly OutboxEvent[]): Map<string, FoldedState> {
  const out = new Map<string, FoldedState>();
  const terminal: ReadonlySet<OutboxState> = new Set(["sent", "reconciled"]);
  for (const ev of events) {
    const cur: FoldedState = out.get(ev.command_id) ?? { state: "queued" };
    if (terminal.has(cur.state)) {
      out.set(ev.command_id, cur);
      continue;
    }
    if (ev.kind === "action-attempt") {
      cur.state = "attempting";
    } else if (ev.kind === "native-receipt") {
      const mid = ev.data?.native_message_id;
      const tid = ev.data?.native_thread_id;
      if (typeof mid === "string") cur.native_message_id = mid;
      if (typeof tid === "string") cur.native_thread_id = tid;
    } else if (ev.kind === "outcome") {
      const status = ev.data?.status;
      if (status === "sent") cur.state = "sent";
      else if (status === "reconciled") cur.state = "reconciled";
      else if (status === "failed" || status === "rejected") cur.state = "failed";
      else if (status === "outcome_unknown") cur.state = "outcome_unknown";
    }
    out.set(ev.command_id, cur);
  }
  return out;
}

interface Entry {
  command: OutboxCommand;
  /** Actual native send-client invocations for this command (at-most-once => <= 1). */
  sendCount: number;
}

export interface Outbox {
  /** Idempotent on `command_id`; requires an `allow` decision (else throws `OutboxRejectedError`). */
  enqueue(input: EnqueueInput): OutboxCommand;
  /** Reconcile-first send. At-most-once per command. Throws typed pre-send rejections. */
  attempt(commandId: string, authority?: SendAuthority): OutboxCommand;
  /** Match native Gmail receipts back to the command; duplicate receipts are idempotent. */
  reconcile(commandId: string): OutboxCommand;
  /** Enqueue + attempt in one step - THE inbox send path. */
  sendApproved(input: EnqueueInput, authority?: SendAuthority): OutboxCommand;
  get(commandId: string): OutboxCommand | undefined;
  /** Actual native send-client invocations for a command (test/audit: proves at-most-once). */
  sendCount(commandId: string): number;
}

/**
 * Build a durable, idempotent outbox over an injected gog client + I-02 journal. In-memory command
 * index is seeded from `priorEvents` so a restart recovers `attempting`/`outcome_unknown` commands
 * into a reconcile-first path (never a blind resend). Every state transition journals a content-free
 * I-02 event.
 */
export function createOutbox(deps: OutboxDeps): Outbox {
  const now = deps.now ?? (() => Date.now());
  const markers = deps.adminMarkers ?? ADMIN_CONTEXT_MARKERS;
  const entries = new Map<string, Entry>();
  const priorState = foldOutboxState(deps.priorEvents ?? []);

  const stamp = (): string => new Date(now()).toISOString();
  const emit = (
    kind: OutboxEventKind,
    command_id: string,
    data?: Record<string, unknown>
  ): void => {
    deps.journal({ kind, command_id, at: stamp(), ...(data ? { data } : {}) });
  };

  function requireEntry(commandId: string): Entry {
    const e = entries.get(commandId);
    if (!e) throw new OutboxRejectedError("not-allowed", `no enqueued command "${commandId}"`);
    return e;
  }

  function enqueue(input: EnqueueInput): OutboxCommand {
    const existing = entries.get(input.command_id);
    if (existing) return existing.command; // idempotent no-op

    if (input.decision.verdict !== "allow") {
      throw new OutboxRejectedError(
        "not-allowed",
        `enqueue requires an "allow" decision (got "${input.decision.verdict}")`
      );
    }
    // Adopt any durable prior state (crash recovery); a fresh command starts `queued`.
    const prior = priorState.get(input.command_id);
    const command: OutboxCommand = {
      command_id: input.command_id,
      reply_request: input.reply_request,
      exact_outbound_bytes: input.exact_outbound_bytes,
      state: prior?.state ?? "queued",
      ...(prior?.native_message_id ? { native_message_id: prior.native_message_id } : {}),
      ...(prior?.native_thread_id ? { native_thread_id: prior.native_thread_id } : {}),
    };
    entries.set(input.command_id, { command, sendCount: 0 });
    return command;
  }

  function attempt(commandId: string, authority: SendAuthority = DIRECT_AUTHORITY): OutboxCommand {
    const entry = requireEntry(commandId);
    const cmd = entry.command;

    // At-most-once: a terminal-sent command never sends again.
    if (cmd.state === "sent" || cmd.state === "reconciled") return cmd;

    // Pre-send checks on the EXACT bytes. A rejection journals a content-free outcome, then throws.
    // The command was enqueued only under an `allow` decision, re-asserted here defensively.
    const decision: PdpDecision = {
      verdict: "allow",
      rule_id: "allow.origin-confined",
      explanation: "enqueued under an allow decision",
    };
    const check = checkPreSend(cmd, decision, authority, markers);
    if (!check.ok) {
      cmd.state = "failed";
      emit("outcome", commandId, { status: "rejected", reason: check.reason });
      throw new OutboxRejectedError(check.reason, check.detail);
    }

    // Reconcile-first: query Sent BEFORE any (re)send. Closes timeout/crash/retry duplicates.
    const q = deps.client.querySent(commandId);
    if (q.found) {
      if (q.message_id) cmd.native_message_id = q.message_id;
      if (q.thread_id) cmd.native_thread_id = q.thread_id;
      emit("native-receipt", commandId, {
        source: "reconcile",
        ...(q.message_id ? { native_message_id: q.message_id } : {}),
        ...(q.thread_id ? { native_thread_id: q.thread_id } : {}),
      });
      cmd.state = "reconciled";
      emit("outcome", commandId, { status: "reconciled" });
      return cmd;
    }

    // Journal the intent to act, then send exactly once.
    emit("action-attempt", commandId, {
      recipients: outboundRecipientSet(cmd.exact_outbound_bytes).size,
    });
    cmd.state = "attempting";

    let result: OutboxSendResult;
    try {
      entry.sendCount += 1;
      result = deps.client.send(cmd.exact_outbound_bytes);
    } catch (err) {
      if (err instanceof OutboxTimeoutError) {
        cmd.state = "outcome_unknown";
        emit("outcome", commandId, { status: "outcome_unknown" });
        return cmd;
      }
      cmd.state = "failed";
      emit("outcome", commandId, { status: "failed" });
      return cmd;
    }

    // Native receipt (content-free: native ids + counts only).
    cmd.native_message_id = result.message_id;
    cmd.native_thread_id = result.thread_id;
    const rejected = result.rejected_recipients ?? [];
    emit("native-receipt", commandId, {
      source: "send",
      native_message_id: result.message_id,
      native_thread_id: result.thread_id,
      rejected_count: rejected.length,
    });
    if (rejected.length > 0) {
      cmd.rejected_recipients = rejected;
      cmd.state = "failed"; // partial failure - the message exists; NEVER resend (at-most-once).
      emit("outcome", commandId, {
        status: "failed",
        partial: true,
        rejected_count: rejected.length,
      });
    } else {
      cmd.state = "sent";
      emit("outcome", commandId, { status: "sent" });
    }
    return cmd;
  }

  function reconcile(commandId: string): OutboxCommand {
    const entry = requireEntry(commandId);
    const cmd = entry.command;
    if (cmd.state === "reconciled") return cmd; // duplicate reconcile is idempotent
    const q = deps.client.querySent(commandId);
    if (!q.found) return cmd; // nothing to reconcile yet
    // Duplicate native receipt: if we already hold this message id, do not re-journal it.
    const already = Boolean(
      cmd.native_message_id && q.message_id && cmd.native_message_id === q.message_id
    );
    if (q.message_id) cmd.native_message_id = q.message_id;
    if (q.thread_id) cmd.native_thread_id = q.thread_id;
    if (!already) {
      emit("native-receipt", commandId, {
        source: "reconcile",
        ...(q.message_id ? { native_message_id: q.message_id } : {}),
        ...(q.thread_id ? { native_thread_id: q.thread_id } : {}),
      });
    }
    cmd.state = "reconciled";
    emit("outcome", commandId, { status: "reconciled" });
    return cmd;
  }

  function sendApproved(input: EnqueueInput, authority?: SendAuthority): OutboxCommand {
    enqueue(input);
    return attempt(input.command_id, authority);
  }

  return {
    enqueue,
    attempt,
    reconcile,
    sendApproved,
    get: (id) => entries.get(id)?.command,
    sendCount: (id) => entries.get(id)?.sendCount ?? 0,
  };
}
