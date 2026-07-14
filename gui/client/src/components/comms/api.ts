/**
 * Comms API client (I-14 / AIO-395) — thin, typed wrappers over the token-injected `Api` for the three
 * inbox routes. Isolated here so the scoped-confirm POST body is trivially testable: `postDecision`
 * sends EXACTLY `{ handle, digest, decision }` and nothing else (the "no other fields leave the client"
 * acceptance criterion is a unit test over this function).
 */

import type { Api } from "../../lib/api";
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
