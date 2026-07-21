/**
 * Comms API client (I-14 / AIO-395 and AIO-392) — thin, typed wrappers over the token-injected `Api`.
 * Isolated here so every mutating POST constructs its exact allowlisted body rather than forwarding a
 * caller-owned object.
 */

import type { Api } from "../../lib/api";
import type {
  InboxView,
  InboxDetail,
  OutboxView,
  ReplyCheckResult,
  ReplySendResult,
} from "./types";

export function fetchInbox(api: Api, opts: { raw?: boolean } = {}): Promise<InboxView> {
  return api.get<InboxView>(`/api/inbox${opts.raw ? "?raw=1" : ""}`);
}

export function fetchInboxItem(api: Api, id: string): Promise<InboxDetail> {
  return api.get<InboxDetail>(`/api/inbox/${encodeURIComponent(id)}`);
}

export function fetchOutbox(api: Api): Promise<OutboxView> {
  return api.get<OutboxView>("/api/outbox");
}

/** Only the body crosses from the browser; all destination fields are derived by the server. */
export function postReplyCheck(api: Api, id: string, body: string): Promise<ReplyCheckResult> {
  return api.post<ReplyCheckResult>(`/api/inbox/${encodeURIComponent(id)}/reply-check`, { body });
}

export function postReplySend(
  api: Api,
  id: string,
  input: { command_id: string; digest: string; body: string }
): Promise<ReplySendResult> {
  const payload = {
    command_id: input.command_id,
    digest: input.digest,
    body: input.body,
  };
  return api.post<ReplySendResult>(`/api/inbox/${encodeURIComponent(id)}/reply-send`, payload);
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
