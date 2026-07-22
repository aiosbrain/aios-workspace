/**
 * Comms API client (I-14 / AIO-395) — thin, typed wrappers over the token-injected `Api` for the three
 * inbox routes. Isolated here so the scoped-confirm POST body is trivially testable: `postDecision`
 * sends EXACTLY `{ handle, digest, decision }` and nothing else (the "no other fields leave the client"
 * acceptance criterion is a unit test over this function).
 */

import { ApiError, type Api } from "../../lib/api";
import type { InboxView, InboxDetail } from "./types";

export function fetchInbox(api: Api, opts: { raw?: boolean } = {}): Promise<InboxView> {
  return api.get<InboxView>(`/api/inbox${opts.raw ? "?raw=1" : ""}`);
}

export function fetchInboxItem(api: Api, id: string): Promise<InboxDetail> {
  return api.get<InboxDetail>(`/api/inbox/${encodeURIComponent(id)}`);
}

/** The decision the scoped-confirm dialog posts — the ONLY three fields that ever leave the client. */
export interface DecisionBody {
  handle: string;
  digest: string;
  decision: "approve" | "deny";
}

export interface DecisionResult {
  ok: boolean;
  error?: string;
  state?: string;
  result?: { kind: string; reason?: string; outcome?: string; operation?: string };
}

/**
 * Post a scoped-confirmation decision. Constructs the body from exactly the three contract fields — the
 * handle + the digest the human saw + the verdict — so a caller can never leak request payload through it.
 */
export function postDecision(api: Api, id: string, body: DecisionBody): Promise<DecisionResult> {
  const payload: DecisionBody = {
    handle: body.handle,
    digest: body.digest,
    decision: body.decision,
  };
  return api.post<DecisionResult>(`/api/inbox/${encodeURIComponent(id)}/decision`, payload);
}

export interface AskActionResult {
  ok: boolean;
  accepted?: boolean;
  archived?: boolean;
  error?: string;
  code?: "reply_in_progress" | "ask_closed" | "lifecycle_conflict";
}

/** Only the reply text leaves the client; session identity is resolved from the canonical ask server-side. */
export function postAskReply(api: Api, id: string, message: string): Promise<AskActionResult> {
  return api.post<AskActionResult>(`/api/inbox/${encodeURIComponent(id)}/reply`, { message });
}

export function postAskArchive(api: Api, id: string): Promise<AskActionResult> {
  return api.post<AskActionResult>(`/api/inbox/${encodeURIComponent(id)}/archive`, {});
}

export type AskAckReason =
  | "never-delivered"
  | "already-acked"
  | "not-acknowledgeable"
  | "notify-busy"
  | "notify-unavailable";

export interface AskAckResult {
  ok: boolean;
  recorded: boolean;
  reason?: AskAckReason;
}

const ACK_REASONS: readonly AskAckReason[] = [
  "never-delivered",
  "already-acked",
  "not-acknowledgeable",
  "notify-busy",
  "notify-unavailable",
];

/**
 * Outcomes that can never change for this ask, so a caller may stop retrying.
 *
 * Everything NOT listed here is transient and must stay retryable: `notify-busy` (the notifier holds
 * the coordination lock this tick), `notify-unavailable` (the compiled loop is not loaded yet) and
 * `never-delivered` (the lane may still deliver) all resolve on their own.
 */
export function isTerminalAckReason(reason?: AskAckReason): boolean {
  return reason === "already-acked" || reason === "not-acknowledgeable";
}

/**
 * No ask content or client timestamp is sent; the server folds the durable delivery journal.
 *
 * `not-acknowledgeable` (404), `notify-busy` (503) and `notify-unavailable` (503) are MODELLED
 * outcomes the server states in the response body — but `Api.post` throws on any non-2xx, so
 * without this translation they could never be observed and all three collapsed into one silent
 * `catch` at the call site. Only a genuine transport/unknown failure still throws.
 */
export async function postAskAck(api: Api, id: string): Promise<AskAckResult> {
  try {
    return await api.post<AskAckResult>(`/api/inbox/${encodeURIComponent(id)}/ack`);
  } catch (e) {
    const body = e instanceof ApiError ? (e.body as { reason?: unknown } | null) : null;
    const reason = ACK_REASONS.find((r) => r === body?.reason);
    if (reason) return { ok: false, recorded: false, reason };
    throw e;
  }
}
