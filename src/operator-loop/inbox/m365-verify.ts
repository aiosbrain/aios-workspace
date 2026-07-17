// Unified inbox — m365 connect-and-verify (I-12 / AIO-393).
//
// The SECOND channel wired at the honest claim level: auth → read → one policy-mediated send on a
// TEST tenant, reported at exactly the level proven ("connected and verified"). The deep adapter
// (enriched observations, reply-PDP integration, outbox) is post-Jul-29 and NOT built here.
//
// This module is CREDENTIAL-FREE by construction. Every Microsoft Graph interaction goes through the
// injected `GraphTransport` seam — the module makes no network call itself, imports no Graph SDK, and
// holds no tenant secret. Production wires a real transport; tests + the local self-test wire a
// deterministic fixture transport (`createFixtureTransport`). Because a credential-free run can never
// observe a live tenant, `verifyM365` only ever emits the "connected and verified" claim when the
// caller asserts `mode: "live"` AND all three checks pass; a fixture run is honestly labelled
// `mode: "fixture"` and its claim stays "not verified" no matter how green the checks are. The one
// residual — running the flows against a real Abe-provisioned test tenant — is the labelled
// live-verification step in the runbook (docs/v1-operator-loop/runbooks/m365-connect-and-verify.md).
//
// Design invariants (mirrors reply-policy.ts / capability.ts):
//   - The Graph boundary is a single injected interface. Deterministic: same transport + config →
//     identical `VerifyReport` (the only non-determinism, the timestamp, is injectable via `ts`).
//   - Diagnostics are a fixed, exported catalogue of machine-readable codes — every check names one.
//     Detail strings are composed from module constants only (no token/body/address interpolation),
//     so a hostile Graph payload cannot forge an explanation. No comms plaintext is ever read.
//   - Journaling is a side effect kept OUT of the core: `verifyM365` computes the report; the caller
//     may `recordVerifyReport(report, sink)` to emit ONE content-free I-02 event (statuses / scopes /
//     the opaque native message-id / counts — never a message body, address, or token).
//   - Admin-tier local. Nothing here syncs to the Team Brain; the CLI journals only a real `live` run.
//
// Provisional module home per I-01 (`src/operator-loop/inbox/`); no cross-domain value imports —
// `Tier` is a type-only reference (the legitimate typed seam).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Tier } from "../signal.js";

// ── least-privilege scopes ───────────────────────────────────────────────────────────────────────

/** The exact Microsoft Graph delegated scopes the flows require — least privilege, nothing more.
 *  `Mail.Read` backs the read check; `Mail.Send` backs the send check. The report enumerates the
 *  scopes ACTUALLY observed on the acquired token (`graph_permissions`), not this assumed set. */
export const M365_REQUIRED_SCOPES = ["Mail.Read", "Mail.Send"] as const;
export type M365Scope = (typeof M365_REQUIRED_SCOPES)[number];

/** Which granted scope each check exercises. Used to enumerate `graph_permissions` as-observed. */
export const M365_CHECK_SCOPE: { readonly read: M365Scope; readonly send: M365Scope } = {
  read: "Mail.Read",
  send: "Mail.Send",
};

// ── diagnostic codes (every check result names exactly one) ────────────────────────────────────────

export const M365_DIAGNOSTICS = {
  AUTH_OK: "auth.ok",
  AUTH_TOKEN_UNAVAILABLE: "auth.token-unavailable",
  AUTH_TOKEN_EXPIRED: "auth.token-expired",
  AUTH_INSUFFICIENT_SCOPE: "auth.insufficient-scope",
  READ_OK: "read.ok",
  READ_INSUFFICIENT_SCOPE: "read.insufficient-scope",
  READ_THROTTLED: "read.throttled",
  READ_ERROR: "read.error",
  SEND_OK: "send.ok",
  SEND_INSUFFICIENT_SCOPE: "send.insufficient-scope",
  SEND_THROTTLED: "send.throttled",
  SEND_ERROR: "send.error",
  SKIPPED_PRIOR_FAILURE: "skipped.prior-check-failed",
  NEEDS_TENANT: "needs-tenant",
} as const;

export type M365DiagnosticCode = (typeof M365_DIAGNOSTICS)[keyof typeof M365_DIAGNOSTICS];

// ── connection contract (tenant / account settings) ────────────────────────────────────────────────

/** The tenant/account settings a verify run needs. A GUID/domain tenant, the app-registration
 *  client id, and the TEST-tenant recipient the one send targets. `account` is the mailbox the flows
 *  run as. No secret (client secret / token) is ever part of this contract — those live in the
 *  transport's own credential source, never on disk here. */
export interface M365TenantConfig {
  tenant_id: string;
  client_id: string;
  /** The test-tenant mailbox the single mediated send targets. Never a production recipient. */
  test_recipient: string;
  /** The mailbox/user the read + send flows run as; `null` when the transport infers it. */
  account: string | null;
  /** Auth authority; defaults to the standard AAD endpoint for `tenant_id` when omitted. */
  authority?: string;
}

// ── Graph boundary types (fixtures speak this shape) ────────────────────────────────────────────────

/** An acquired delegated access token. Opaque `access_token` (never logged/journaled); `scopes` are
 *  the granted (observed) scopes; `expires_at` is ISO. `account`/`tenant` are the resolved identity. */
export interface AccessToken {
  access_token: string;
  scopes: string[];
  expires_at: string;
  account: string;
  tenant: string;
}

/** A Graph message as the transport returns it — METADATA ONLY (no body). Identity is
 *  `(account, tenant, id)`; the rest is advisory metadata used for normalization. */
export interface GraphMessage {
  id: string;
  internet_message_id?: string | null;
  received_at?: string | null;
  from_address?: string | null;
  subject?: string | null;
}

/** A page of the Graph `messages` (or `messages/delta`) collection. `next_link` drives pagination;
 *  `delta_link` is the durable cursor to resume from on the next sync. */
export interface GraphPage<T> {
  value: T[];
  next_link: string | null;
  delta_link: string | null;
}

/** A structured Graph error. `status` is the HTTP status; `code` the Graph error code; when a 429
 *  carries a Retry-After, `retry_after_seconds` is set (drives the throttle backoff). */
export interface GraphError {
  status: number;
  code: string;
  message: string;
  retry_after_seconds?: number;
}

/** Discriminated transport result — the boundary never throws for an expected Graph failure; it
 *  returns `{ ok: false, error }` so classification stays deterministic and total. */
export type GraphResult<T> = { ok: true; value: T } | { ok: false; error: GraphError };

/** The one recipient-safe outbound test message. Body is a fixed marker string (no workspace
 *  content); recipient is the config's test-tenant mailbox. */
export interface OutboundTestMessage {
  to: string;
  subject: string;
  body: string;
}

/** The native receipt the send returns — the Graph-assigned message id (opaque server id). */
export interface SendReceipt {
  native_message_id: string;
}

export interface ListMessagesOptions {
  top: number;
  /** Follow-on page link from a prior `next_link`; null on the first request. */
  next_link?: string | null;
  /** Resume cursor from a prior `delta_link`; null for a full listing. */
  delta_link?: string | null;
}

/**
 * The Graph boundary. The ONLY place a real network call would live. `verifyM365` composes these
 * three operations; a fixture implementation makes the whole module runnable with no tenant.
 */
export interface GraphTransport {
  acquireToken(
    config: M365TenantConfig,
    scopes: readonly string[]
  ): Promise<GraphResult<AccessToken>>;
  listMessages(
    token: AccessToken,
    opts: ListMessagesOptions
  ): Promise<GraphResult<GraphPage<GraphMessage>>>;
  sendMail(token: AccessToken, mail: OutboundTestMessage): Promise<GraphResult<SendReceipt>>;
}

// ── report shape ────────────────────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "skipped";
export type VerifyMode = "live" | "fixture";
export type VerifyStatus = "verified" | "unverified" | "needs-tenant";
export type VerifyClaim = "connected and verified" | "not verified";

/** One check's machine-readable outcome. `code` is always a `M365_DIAGNOSTICS` value; `detail` is a
 *  module-constant string; `observed_scopes` (auth) enumerates the token's granted scopes. */
export interface CheckResult {
  status: CheckStatus;
  code: M365DiagnosticCode;
  detail: string;
  observed_scopes?: string[];
}

/** The verify report — written as a content-free journal event and a markdown runbook artifact.
 *  `claim` is "connected and verified" ONLY when a LIVE run passed all three checks; a fixture run
 *  is always "not verified" (honest: no live tenant was observed). */
export interface VerifyReport {
  tenant: string;
  mode: VerifyMode;
  status: VerifyStatus;
  verified: boolean;
  claim: VerifyClaim;
  checks: { auth: CheckResult; read: CheckResult; send: CheckResult };
  /** Every Graph scope the flows ACTUALLY exercised, as observed on the token (not assumed). */
  graph_permissions: string[];
  /** The native message-id captured by the send check (opaque server id), or null. */
  native_message_id: string | null;
  /** Count of messages the read check listed across all pages, or null when read did not run. */
  message_count: number | null;
  /** The durable delta cursor the read check captured, or null. */
  cursor: string | null;
  ts: string;
}

// ── content-free journal seam (I-02) ────────────────────────────────────────────────────────────────

/** The single content-free I-02 event a verify run emits. Statuses / scopes / the opaque native id /
 *  counts ONLY — never a token, address, subject, or body. `audit-checkpoint-link` per the journal
 *  vocabulary: the verify is an audit checkpoint over the connection. */
export interface M365VerifyEvent {
  kind: "audit-checkpoint-link";
  correlation_id: string;
  ts: string;
  data: {
    mode: VerifyMode;
    status: VerifyStatus;
    verified: boolean;
    checks: { auth: CheckStatus; read: CheckStatus; send: CheckStatus };
    graph_permissions: string[];
    native_message_id: string | null;
    message_count: number | null;
  };
}

/** Injected journal sink (kept out of the pure core). Production wires the durable
 *  `inbox-events.ndjson` journal via `createDurableM365VerifyJournal(root)` in ../index.ts. */
export interface M365VerifyJournalSink {
  record(event: M365VerifyEvent): void;
}

/** TEST / non-persistent in-memory sink. Production never defaults to this. */
export function createMemoryVerifyJournal(): M365VerifyJournalSink & { events: M365VerifyEvent[] } {
  const events: M365VerifyEvent[] = [];
  return { events, record: (e) => void events.push(e) };
}

// ── scopes + token validation seams ──────────────────────────────────────────────────────────────

/** Normalize a scope list: trim, drop the Graph resource prefix (`https://graph.microsoft.com/`),
 *  dedupe, preserve first-seen order. Scopes are opaque ids — never parsed as free text. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of scopes) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().replace(/^https:\/\/graph\.microsoft\.com\//i, "");
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** The required scopes NOT present in `granted` (case-insensitive on the normalized name). */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(normalizeScopes(granted).map((s) => s.toLowerCase()));
  return normalizeScopes(required).filter((s) => !have.has(s.toLowerCase()));
}

export interface TokenValidation {
  valid: boolean;
  code: M365DiagnosticCode;
  observed_scopes: string[];
  missing: string[];
}

/**
 * Validate an acquired token against the required scopes and expiry. Deterministic given `nowMs`.
 * Order: unavailable/empty token → expired → insufficient scope → ok.
 */
export function validateToken(
  token: AccessToken | null,
  required: readonly string[],
  nowMs: number
): TokenValidation {
  if (!token || typeof token.access_token !== "string" || token.access_token.length === 0) {
    return {
      valid: false,
      code: M365_DIAGNOSTICS.AUTH_TOKEN_UNAVAILABLE,
      observed_scopes: [],
      missing: [],
    };
  }
  const observed = normalizeScopes(token.scopes ?? []);
  const expMs = Date.parse(token.expires_at ?? "");
  if (Number.isFinite(expMs) && expMs <= nowMs) {
    return {
      valid: false,
      code: M365_DIAGNOSTICS.AUTH_TOKEN_EXPIRED,
      observed_scopes: observed,
      missing: [],
    };
  }
  const missing = missingScopes(observed, required);
  if (missing.length > 0) {
    return {
      valid: false,
      code: M365_DIAGNOSTICS.AUTH_INSUFFICIENT_SCOPE,
      observed_scopes: observed,
      missing,
    };
  }
  return { valid: true, code: M365_DIAGNOSTICS.AUTH_OK, observed_scopes: observed, missing: [] };
}

// ── error classification ────────────────────────────────────────────────────────────────────────────

export type GraphErrorClass = "insufficient-scope" | "throttled" | "auth" | "other";

/** Classify a structured Graph error into the coarse buckets the verify checks branch on. Reads
 *  `status` + `code` only (opaque enums), never the free-text `message`. */
export function classifyGraphError(error: GraphError): GraphErrorClass {
  const code = (error.code ?? "").toLowerCase();
  if (error.status === 403 || code === "accessdenied" || code === "authorization_requestdenied") {
    return "insufficient-scope";
  }
  if (error.status === 429 || code === "toomanyrequests" || code === "activitylimitreached") {
    return "throttled";
  }
  if (error.status === 401 || code === "invalidauthenticationtoken" || code === "unauthenticated") {
    return "auth";
  }
  return "other";
}

// ── normalization + identity + cursor ──────────────────────────────────────────────────────────────

/** A normalized inbox observation of a Graph message — METADATA ONLY. Identity key is
 *  `(account, tenant, native_id)` (matches the enriched-observation dedup key, AIO-387): two accounts
 *  observing the same native id project to two items, not one. No body is ever carried. */
export interface NormalizedM365Message {
  key: string;
  account: string;
  tenant: string;
  native_id: string;
  object_kind: "email";
  received_at: string | null;
  tier: Tier;
}

/** NUL-free, order-fixed identity key. Addresses/ids are opaque — never parsed. */
export function m365IdentityKey(account: string, tenant: string, nativeId: string): string {
  return `${account} ${tenant} ${nativeId}`;
}

/** Normalize one Graph message under a token's identity. Admin-tier by default (inbound comms is
 *  personal-by-default, matching the gog writer). Snippet/body are never read. */
export function normalizeMessage(token: AccessToken, msg: GraphMessage): NormalizedM365Message {
  return {
    key: m365IdentityKey(token.account, token.tenant, msg.id),
    account: token.account,
    tenant: token.tenant,
    native_id: msg.id,
    object_kind: "email",
    received_at: msg.received_at ?? null,
    tier: "admin",
  };
}

// ── pagination + delta + throttle-aware listing ────────────────────────────────────────────────────

export interface PaginateResult {
  ok: boolean;
  messages: NormalizedM365Message[];
  /** The delta cursor to resume from next sync (from the terminal page's `delta_link`), or null. */
  cursor: string | null;
  pages: number;
  /** True iff a 429 was encountered and successfully retried within budget. */
  throttled: boolean;
  error?: GraphError;
}

export interface PaginateOptions {
  top: number;
  maxThrottleRetries: number;
  sleep: (ms: number) => Promise<void>;
  /** Hard cap on pages followed, so a misbehaving `next_link` loop can never run unbounded. */
  maxPages?: number;
}

/**
 * List messages across pages, following `next_link` until exhausted, capturing the terminal
 * `delta_link` as the resume cursor and normalizing every message. A 429 is retried up to
 * `maxThrottleRetries` times, honoring `retry_after_seconds` via the injected `sleep` (no real clock
 * in tests). Any non-retryable error stops the walk and is surfaced (never a silent partial success).
 */
export async function paginateMessages(
  transport: GraphTransport,
  token: AccessToken,
  opts: PaginateOptions
): Promise<PaginateResult> {
  const maxPages = opts.maxPages ?? 1000;
  const messages: NormalizedM365Message[] = [];
  let nextLink: string | null = null;
  let cursor: string | null = null;
  let pages = 0;
  let throttled = false;

  while (pages < maxPages) {
    let retries = 0;
    let page: GraphPage<GraphMessage> | null = null;
    // Inner loop: a single logical page request, retried on throttle.
    for (;;) {
      const res = await transport.listMessages(token, { top: opts.top, next_link: nextLink });
      if (res.ok) {
        page = res.value;
        break;
      }
      const kind = classifyGraphError(res.error);
      if (kind === "throttled" && retries < opts.maxThrottleRetries) {
        throttled = true;
        retries += 1;
        const waitMs = Math.max(0, res.error.retry_after_seconds ?? 1) * 1000;
        await opts.sleep(waitMs);
        continue;
      }
      return { ok: false, messages, cursor, pages, throttled, error: res.error };
    }
    pages += 1;
    for (const m of page.value) messages.push(normalizeMessage(token, m));
    if (page.delta_link) cursor = page.delta_link;
    if (!page.next_link) break;
    nextLink = page.next_link;
  }

  return { ok: true, messages, cursor, pages, throttled };
}

// ── the verify core ──────────────────────────────────────────────────────────────────────────────

export interface VerifyOptions {
  transport: GraphTransport;
  config: M365TenantConfig;
  /** "live" runs against a real tenant (the only mode that may claim "connected and verified");
   *  "fixture" (default) is honest that no live tenant was observed. */
  mode?: VerifyMode;
  scopes?: readonly string[];
  /** How many recent messages the read check lists (paginated). Default 10. */
  readCount?: number;
  /** Injected clock (ms) for token-expiry validation. Default `Date.now`. */
  now?: () => number;
  /** Injected backoff for throttle retries. Default a real timer; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  maxThrottleRetries?: number;
  /** Timestamp stamp for the report/event (ISO). Default `new Date().toISOString()`. */
  ts?: string;
  /** Optional journal sink — when set, the report is recorded as one content-free event. */
  journal?: M365VerifyJournalSink;
}

/** A skip result for a check whose prerequisite did not pass. `detail` is a module-constant string. */
function skippedAfter(detail: string): CheckResult {
  return { status: "skipped", code: M365_DIAGNOSTICS.SKIPPED_PRIOR_FAILURE, detail };
}

const SKIPPED_AUTH_DETAIL = "auth did not pass — dependent check skipped";
const SKIPPED_READ_DETAIL = "read did not pass — send skipped (sequential gating)";

/**
 * Run auth → read → send against the injected transport and produce a `VerifyReport`. The gating is
 * SEQUENTIAL: read is skipped when auth fails (it needs a valid token), and send is skipped when
 * auth OR read did not pass — the one mediated send only fires on a connection whose prior checks
 * are green. The overall status is `verified` only when all three pass; the "connected and
 * verified" claim is emitted only for a LIVE verified run.
 */
export async function verifyM365(opts: VerifyOptions): Promise<VerifyReport> {
  const mode: VerifyMode = opts.mode ?? "fixture";
  const scopes = opts.scopes ?? M365_REQUIRED_SCOPES;
  const readCount = opts.readCount ?? 10;
  const nowMs = (opts.now ?? Date.now)();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxThrottleRetries = opts.maxThrottleRetries ?? 3;
  const ts = opts.ts ?? new Date().toISOString();

  // (1) AUTH — acquire a token and validate scopes + expiry.
  let token: AccessToken | null = null;
  let authRes: CheckResult;
  const acquired = await opts.transport.acquireToken(opts.config, scopes);
  if (!acquired.ok) {
    authRes = {
      status: "fail",
      code: M365_DIAGNOSTICS.AUTH_TOKEN_UNAVAILABLE,
      detail: "token acquisition failed at the auth flow",
      observed_scopes: [],
    };
  } else {
    token = acquired.value;
    const v = validateToken(token, scopes, nowMs);
    authRes = v.valid
      ? {
          status: "pass",
          code: M365_DIAGNOSTICS.AUTH_OK,
          detail: "token acquired with required scopes",
          observed_scopes: v.observed_scopes,
        }
      : {
          status: "fail",
          code: v.code,
          detail:
            v.code === M365_DIAGNOSTICS.AUTH_TOKEN_EXPIRED
              ? "acquired token is expired"
              : "acquired token is missing a required scope",
          observed_scopes: v.observed_scopes,
        };
  }

  const authPassed = authRes.status === "pass";
  const usableToken = authPassed ? token : null;

  // (2) READ — list the N most recent messages + capture the delta cursor. The verify is a bounded
  // probe, not a sync: one page of `readCount` proves Mail.Read works, so the walk is capped at a
  // single page — never a whole-mailbox pagination (the deep adapter owns real sync).
  let readRes: CheckResult = skippedAfter(SKIPPED_AUTH_DETAIL);
  let messageCount: number | null = null;
  let cursor: string | null = null;
  if (usableToken) {
    const p = await paginateMessages(opts.transport, usableToken, {
      top: readCount,
      maxThrottleRetries,
      sleep,
      maxPages: 1,
    });
    if (p.ok) {
      messageCount = p.messages.length;
      cursor = p.cursor;
      readRes = {
        status: "pass",
        code: M365_DIAGNOSTICS.READ_OK,
        detail: "listed recent messages",
      };
    } else {
      const cls = p.error ? classifyGraphError(p.error) : "other";
      readRes = {
        status: "fail",
        code:
          cls === "insufficient-scope"
            ? M365_DIAGNOSTICS.READ_INSUFFICIENT_SCOPE
            : cls === "throttled"
              ? M365_DIAGNOSTICS.READ_THROTTLED
              : M365_DIAGNOSTICS.READ_ERROR,
        detail:
          cls === "insufficient-scope"
            ? "read denied — token lacks Mail.Read"
            : cls === "throttled"
              ? "read throttled beyond the retry budget"
              : "read failed at the Graph boundary",
      };
    }
  }

  // (3) SEND — one policy-mediated send to the test-tenant recipient; capture the native message-id.
  // Sequential gating: send fires only when auth AND read passed (auth → read → send).
  let sendRes: CheckResult = skippedAfter(authPassed ? SKIPPED_READ_DETAIL : SKIPPED_AUTH_DETAIL);
  let nativeMessageId: string | null = null;
  if (usableToken && readRes.status === "pass") {
    const mail: OutboundTestMessage = {
      to: opts.config.test_recipient,
      subject: "AIOS m365 connect-and-verify",
      body: "AIOS m365 connect-and-verify test message.",
    };
    const s = await opts.transport.sendMail(usableToken, mail);
    if (s.ok) {
      nativeMessageId = s.value.native_message_id;
      sendRes = {
        status: "pass",
        code: M365_DIAGNOSTICS.SEND_OK,
        detail: "sent one mediated test message",
      };
    } else {
      const cls = classifyGraphError(s.error);
      sendRes = {
        status: "fail",
        code:
          cls === "insufficient-scope"
            ? M365_DIAGNOSTICS.SEND_INSUFFICIENT_SCOPE
            : cls === "throttled"
              ? M365_DIAGNOSTICS.SEND_THROTTLED
              : M365_DIAGNOSTICS.SEND_ERROR,
        detail:
          cls === "insufficient-scope"
            ? "send denied — token lacks Mail.Send"
            : cls === "throttled"
              ? "send throttled beyond the retry budget"
              : "send failed at the Graph boundary",
      };
    }
  }

  const verified =
    authRes.status === "pass" && readRes.status === "pass" && sendRes.status === "pass";
  const status: VerifyStatus = verified ? "verified" : "unverified";
  // "connected and verified" is emitted ONLY for a live, fully-green run — a fixture run never claims it.
  const claim: VerifyClaim =
    verified && mode === "live" ? "connected and verified" : "not verified";

  const report: VerifyReport = {
    tenant: opts.config.tenant_id,
    mode,
    status,
    verified,
    claim,
    checks: { auth: authRes, read: readRes, send: sendRes },
    graph_permissions: graphPermissionsFor(authRes, readRes, sendRes),
    native_message_id: nativeMessageId,
    message_count: messageCount,
    cursor,
    ts,
  };

  if (opts.journal) recordVerifyReport(report, opts.journal);
  return report;
}

/** The scopes the flows ACTUALLY exercised: a check's mapped scope is included only when that check
 *  passed AND the scope was observed on the token (as-observed, not assumed). */
function graphPermissionsFor(auth: CheckResult, read: CheckResult, send: CheckResult): string[] {
  const observed = new Set((auth.observed_scopes ?? []).map((s) => s.toLowerCase()));
  const out: string[] = [];
  if (read.status === "pass" && observed.has(M365_CHECK_SCOPE.read.toLowerCase()))
    out.push(M365_CHECK_SCOPE.read);
  if (send.status === "pass" && observed.has(M365_CHECK_SCOPE.send.toLowerCase()))
    out.push(M365_CHECK_SCOPE.send);
  return out;
}

/** A `needs-tenant` report — no config/credentials were available, so nothing was observed. Every
 *  check is skipped with the `needs-tenant` diagnostic; the claim stays "not verified". */
export function needsTenantReport(config: M365TenantConfig | null, ts?: string): VerifyReport {
  const needs: CheckResult = {
    status: "skipped",
    code: M365_DIAGNOSTICS.NEEDS_TENANT,
    detail: "no test tenant configured — live verification is the residual step (see runbook)",
  };
  return {
    tenant: config?.tenant_id ?? "<unconfigured>",
    mode: "fixture",
    status: "needs-tenant",
    verified: false,
    claim: "not verified",
    checks: { auth: needs, read: needs, send: needs },
    graph_permissions: [],
    native_message_id: null,
    message_count: null,
    cursor: null,
    ts: ts ?? new Date().toISOString(),
  };
}

/** Emit exactly one content-free I-02 event for a verify run (statuses / scopes / opaque id / counts
 *  only). The correlation id is per-tenant so re-runs correlate. Never carries a token/address/body. */
export function recordVerifyReport(
  report: VerifyReport,
  sink: M365VerifyJournalSink
): M365VerifyEvent {
  const event: M365VerifyEvent = {
    kind: "audit-checkpoint-link",
    correlation_id: `m365-verify:${report.tenant}`,
    ts: report.ts,
    data: {
      mode: report.mode,
      status: report.status,
      verified: report.verified,
      checks: {
        auth: report.checks.auth.status,
        read: report.checks.read.status,
        send: report.checks.send.status,
      },
      graph_permissions: report.graph_permissions,
      native_message_id: report.native_message_id,
      message_count: report.message_count,
    },
  };
  sink.record(event);
  return event;
}

// ── config loading ──────────────────────────────────────────────────────────────────────────────────

export const M365_CONFIG_REL = ".aios/m365-config.json";

/** Validate + normalize a parsed m365 config object. Exposed for tests. Malformed → throws loudly
 *  (never a silent default that could target the wrong recipient). Missing optional `account` → null. */
export function parseM365Config(parsed: unknown, file = "<config>"): M365TenantConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`m365-config: ${file} must be a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  const reqStr = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`m365-config: ${key} must be a non-empty string`);
    }
    return v.trim();
  };
  const cfg: M365TenantConfig = {
    tenant_id: reqStr("tenant_id"),
    client_id: reqStr("client_id"),
    test_recipient: reqStr("test_recipient"),
    account: null,
  };
  if (o.account !== undefined && o.account !== null) {
    if (typeof o.account !== "string" || !o.account.trim()) {
      throw new Error(`m365-config: account must be a non-empty string or null`);
    }
    cfg.account = o.account.trim();
  }
  if (o.authority !== undefined) {
    if (typeof o.authority !== "string" || !o.authority.trim()) {
      throw new Error(`m365-config: authority must be a non-empty string`);
    }
    cfg.authority = o.authority.trim();
  }
  return cfg;
}

/** Load `.aios/m365-config.json` (or an explicit override path). Missing file → null (a `needs-tenant`
 *  signal, not an error). Malformed → throws (never a silent default that could misroute the send). */
export function loadM365Config(root: string, overridePath?: string): M365TenantConfig | null {
  const file = overridePath ?? path.join(root, M365_CONFIG_REL);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`m365-config: cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`m365-config: invalid JSON in ${file}: ${(e as Error).message}`);
  }
  return parseM365Config(parsed, file);
}

// ── fixture transport (local self-test + tests; makes the module runnable with no tenant) ──────────

export type FixtureScenario = "happy" | "bad-token" | "missing-scope" | "throttled";

/**
 * A deterministic in-memory `GraphTransport` for the four canonical scenarios. Makes the flows
 * runnable + demonstrable with NO tenant and NO network. This is the ONLY transport this
 * credential-free build ships — a live transport is the labelled needs-tenant residual (runbook).
 */
export function createFixtureTransport(scenario: FixtureScenario): GraphTransport {
  const baseToken = (): AccessToken => ({
    access_token: "fixture-token",
    scopes: [...M365_REQUIRED_SCOPES],
    expires_at: "2999-01-01T00:00:00.000Z",
    account: "verify@contoso.onmicrosoft.test",
    tenant: "contoso.onmicrosoft.test",
  });
  const messagesPage = (): GraphPage<GraphMessage> => ({
    value: [
      { id: "AAMk-fixture-1", received_at: "2026-07-14T09:00:00.000Z" },
      { id: "AAMk-fixture-2", received_at: "2026-07-14T08:00:00.000Z" },
    ],
    next_link: null,
    delta_link: "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=FIXTURE",
  });
  let throttledOnce = false;

  return {
    async acquireToken() {
      if (scenario === "bad-token") {
        return {
          ok: false,
          error: { status: 401, code: "invalidAuthenticationToken", message: "token unavailable" },
        };
      }
      if (scenario === "missing-scope") {
        return { ok: true, value: { ...baseToken(), scopes: ["Mail.Read"] } }; // Mail.Send withheld
      }
      return { ok: true, value: baseToken() };
    },
    async listMessages() {
      if (scenario === "throttled" && !throttledOnce) {
        throttledOnce = true;
        return {
          ok: false,
          error: {
            status: 429,
            code: "TooManyRequests",
            message: "throttled",
            retry_after_seconds: 1,
          },
        };
      }
      return { ok: true, value: messagesPage() };
    },
    async sendMail() {
      if (scenario === "missing-scope") {
        return {
          ok: false,
          error: { status: 403, code: "accessDenied", message: "insufficient scope" },
        };
      }
      return { ok: true, value: { native_message_id: "AAMk-fixture-sent-1" } };
    },
  };
}
