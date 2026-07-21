// Unified inbox — the Telegram notify lane (I-05 / AIO-386, the G3b interrupt lane).
//
// This is the INTERRUPT half of the recovery story (the safety net is recovery.ts). It ships a
// CONTENT-FREE notification projection + deep-link to the phone, and two honest journal events:
//   • `delivery-attempted` — the Bot API ACCEPTED the send (HTTP 200 / ok:true). NOT proof a human
//     saw it; only that the coordinator handed the notification to Telegram.
//   • `human-ack` — an explicit, content-free callback tap ("Open"). This is the ONLY event that
//     means a person acknowledged the interrupt. Non-ack within the escalation window surfaces the
//     ask in `aios inbox --overdue` (recovery.ts).
//
// The lane is content-free BY TYPE, not by discipline: `NotificationProjection` carries only an
// ask id, a count, a repo label, and a deep link — its shape cannot hold a message body, a sender
// name, or an evidence snippet. Approval-shaped buttons + any body/evidence on the phone are
// explicitly DEFERRED (G5+, signed one-use callback tokens through the runtime's compare-and-consume
// — I-05 §Scope). `src/operator-loop/comms/sender.ts` is a SEPARATE contract this lane never invokes
// and never modifies; admin plaintext never leaves the Mac and nothing here syncs to the Team Brain.
//
// The Bot API is reached through an INJECTED transport (`TelegramTransport`) — the HTTP boundary. The
// module owns the projection + ack policy, not the wire, so tests fake the boundary with recorded
// fixtures (Telegram disabled / token revoked / API-success-without-ack / phone offline) with no
// network and no real bot. The token is read from local env, used only to build the request URL, and
// is NEVER logged, journaled, or returned.
//
// Domain isolation (Constitution §4): same-domain value imports only (journal.js). The `asks` shape
// is referenced type-only elsewhere; this module needs only an ask id + repo label, passed in.

import { appendInboxEvent, type AppendResult } from "./journal.js";

// ── deep-link format contract ────────────────────────────────────────────────────────────────────

/** Scheme for the content-free deep link into the runtime's OWN local prompt (opens on the Mac). */
export const DEEP_LINK_SCHEME = "aios";
/**
 * The deep-link format contract: `aios://inbox/ask/<ask_id>`. The generated link resolves to exactly
 * one seeded ask id (no phone required to verify). `<ask_id>` is percent-safe (asks ids are UUIDs /
 * slugs); the regex captures it so a consumer can recover the id from the link alone.
 */
export const DEEP_LINK_RE = /^aios:\/\/inbox\/ask\/([A-Za-z0-9._~:-]+)$/;

/** Build the content-free deep link for an ask id. Carries the id and NOTHING else. */
export function deepLinkForAsk(askId: string): string {
  return `${DEEP_LINK_SCHEME}://inbox/ask/${askId}`;
}

/** Recover the ask id a deep link points at, or null if the string is not a valid inbox deep link. */
export function askIdFromDeepLink(link: string): string | null {
  const m = DEEP_LINK_RE.exec(link);
  return m ? (m[1] as string) : null;
}

// ── content-free projection ──────────────────────────────────────────────────────────────────────

/**
 * The ONLY payload that may cross the phone lane. Content-free by construction: four scalar fields,
 * none of which can carry a message body, a protected-thread sender name, or an evidence snippet.
 * A projection function (`projectNotification`) is the single constructor, and its input type is
 * likewise body-free — so there is no code path that puts admin evidence into a notification.
 */
export interface NotificationProjection {
  /** The durable ask this interrupt is about (also the journal `correlation_id`). */
  ask_id: string;
  /** How many blocking asks are outstanding (a count, never their contents). */
  count: number;
  /** A coarse repo label for orientation ("aios-workspace") — never a path, thread, or title. */
  repo_label: string;
  /** Content-free deep link into the runtime's own local prompt. */
  deep_link: string;
}

/** The body-free inputs a projection is built from — deliberately cannot reference any content. */
export interface ProjectionInput {
  ask_id: string;
  count: number;
  repo_label: string;
}

/** Sanitize a repo label to a short, single-line, alphanumeric-ish token (belt-and-suspenders). */
function sanitizeRepoLabel(raw: string): string {
  return (
    String(raw ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "workspace"
  );
}

/**
 * Build the one content-free notification for an ask. The output type cannot carry body text; this
 * function additionally clamps the count and sanitizes the label so a caller cannot smuggle content
 * through the label field.
 */
export function projectNotification(input: ProjectionInput): NotificationProjection {
  const count = Number.isFinite(input.count) && input.count > 0 ? Math.floor(input.count) : 1;
  return {
    ask_id: input.ask_id,
    count,
    repo_label: sanitizeRepoLabel(input.repo_label),
    deep_link: deepLinkForAsk(input.ask_id),
  };
}

/**
 * The exact phone text — assembled ONLY from the projection's count + label. Mirrors the spec's
 * example "1 blocking ask · repo aios-workspace · open on your Mac". No body, no sender, no evidence.
 */
export function formatNotificationText(p: NotificationProjection): string {
  const noun = p.count === 1 ? "blocking ask" : "blocking asks";
  return `${p.count} ${noun} · repo ${p.repo_label} · open on your Mac`;
}

// ── the `tg` adapter (Bot API, sanctioned) ─────────────────────────────────────────────────────────

/** Telegram Bot API request the adapter hands the transport. Content-free `text`, no token in body. */
export interface TelegramRequest {
  chat_id: string;
  text: string;
  /**
   * Best-effort deep link, appended to the message text by the production transport (content-free).
   * NEVER surfaced as an inline-keyboard URL button: the Bot API rejects non-HTTP(S)/tg:// button
   * URLs with 400 BUTTON_URL_INVALID, and `aios://` is a custom scheme — a button would kill every
   * production send.
   */
  deep_link: string;
}

/** The transport's reply, normalized from the Bot API JSON envelope (`{ ok, description, ... }`). */
export interface TelegramResponse {
  ok: boolean;
  /** HTTP status, when the transport reached the wire. */
  status?: number;
  /** Bot API error description (e.g. "Unauthorized" for a revoked token) — never contains our token. */
  description?: string;
}

/** The injected HTTP boundary. Tests fake it with recorded fixtures; production uses `fetch`. */
export type TelegramTransport = (req: TelegramRequest) => Promise<TelegramResponse>;

/** Adapter config. The token is read from local env, used only to build the URL, never logged. */
export interface TelegramConfig {
  /** Master switch. When false (or token/chat absent), the lane is DISABLED — a no-op, ask stays queued. */
  enabled: boolean;
  /** Bot token — env-sourced. Present only so the production transport can build the URL. */
  token: string | null;
  /** Destination chat id — env-sourced. */
  chatId: string | null;
}

export const TELEGRAM_TOKEN_ENVS = ["AIOS_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"] as const;
export const TELEGRAM_CHAT_ENVS = ["AIOS_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"] as const;

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Resolve the adapter config from the local environment. Enabled iff BOTH a token and a chat id are
 * present (and not explicitly disabled). The returned token/chatId are never logged by this module.
 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = firstEnv(env, TELEGRAM_TOKEN_ENVS);
  const chatId = firstEnv(env, TELEGRAM_CHAT_ENVS);
  const disabled = String(env.AIOS_TELEGRAM_DISABLED ?? "").trim() === "1";
  return { enabled: !disabled && Boolean(token) && Boolean(chatId), token, chatId };
}

/** Hard ceiling on one Bot API call. Callers hold a cross-process lock across the send (the GUI
 *  notifier serializes send vs. ack on it), so an un-timeouted socket would not merely delay this
 *  alert — it would block acknowledgment and shutdown for as long as the peer holds the connection
 *  open. A stall is reported as a normal failure: the ask stays queued and recovery still lists it. */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The production transport — the real HTTP boundary. Builds the Bot API URL from the token (never
 * logged), POSTs the content-free text, and normalizes the envelope. A network error or timeout is
 * reported as `{ ok: false }` (the ask stays queued; the recovery view is the safety net) — it never
 * throws the token into a stack. Injected so tests never touch the network.
 */
export function fetchTelegramTransport(
  token: string,
  timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS
): TelegramTransport {
  return async (req) => {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        // The deep link rides IN the text: `aios://` is a custom scheme, and the Bot API rejects
        // non-HTTP(S)/tg:// inline-keyboard button URLs with 400 BUTTON_URL_INVALID. No reply_markup.
        body: JSON.stringify({
          chat_id: req.chat_id,
          text: req.deep_link ? `${req.text}\n${req.deep_link}` : req.text,
        }),
      });
      let description: string | undefined;
      let ok = res.ok;
      try {
        const json = (await res.json()) as { ok?: boolean; description?: string };
        if (typeof json.ok === "boolean") ok = json.ok;
        if (typeof json.description === "string") description = json.description;
      } catch {
        /* non-JSON body — fall back to the HTTP status for ok. */
      }
      return { ok, status: res.status, ...(description ? { description } : {}) };
    } catch (e) {
      // Redact: surface only the error name, NEVER the URL (which embeds the token) or the message.
      return { ok: false, description: `transport-error:${(e as Error).name}` };
    }
  };
}

// ── send + ack (the two honest journal events) ─────────────────────────────────────────────────────

export type NotifyStatus = "disabled" | "delivery_attempted" | "failed";

export interface NotifyResult {
  status: NotifyStatus;
  projection: NotificationProjection;
  /** Bot API error description on `failed` (e.g. "Unauthorized") — content-free, no token. */
  reason?: string;
  /** The journal append receipt when a `delivery-attempted` event was written; absent otherwise. */
  event?: AppendResult;
}

export interface NotifyEventInput {
  kind: "delivery-attempted" | "human-ack";
  correlation_id: string;
  payload: Record<string, unknown>;
  /** The event timestamp (delivery/ack time). Injected so the escalation clock is deterministic. */
  ts: string;
}

export interface NotifyDeps {
  transport?: TelegramTransport;
  /** Injected journal writer bound to a workspace root — appends the two notify-lane events. */
  appendEvent: (input: NotifyEventInput) => AppendResult;
  now?: Date;
}

/**
 * Send ONE content-free interrupt for an ask and record honest ack state.
 *
 * Fail-safe by construction — in EVERY branch the ask stays durably queued (this function never
 * touches the asks store) and the recovery view still lists it:
 *   • DISABLED (no token/chat, or explicitly off) → no wire call, no journal event, `disabled`.
 *   • Bot API ACCEPTED (ok) → append `delivery-attempted` ONLY (never `human-ack`), `delivery_attempted`.
 *   • Bot API REJECTED (revoked token / error) or transport error → no `delivery-attempted`, `failed`.
 * A "phone offline" delivery still returns `ok` from the Bot API (Telegram queues it), so it records
 * `delivery-attempted` — correct: delivery was attempted, the human has NOT acknowledged.
 */
export async function sendNotification(
  projection: NotificationProjection,
  cfg: TelegramConfig,
  deps: NotifyDeps
): Promise<NotifyResult> {
  if (!cfg.enabled || !cfg.token || !cfg.chatId) {
    return { status: "disabled", projection };
  }
  const transport = deps.transport ?? fetchTelegramTransport(cfg.token);
  const text = formatNotificationText(projection);
  const res = await transport({ chat_id: cfg.chatId, text, deep_link: projection.deep_link });
  if (!res.ok) {
    return {
      status: "failed",
      projection,
      ...(res.description ? { reason: res.description } : {}),
    };
  }
  const at = (deps.now ?? new Date()).toISOString();
  const event = deps.appendEvent({
    kind: "delivery-attempted",
    correlation_id: projection.ask_id,
    ts: at,
    // Content-free: count + label + deep link + wire status. NEVER the ask body, title, or evidence.
    payload: {
      lane: "telegram",
      count: projection.count,
      repo_label: projection.repo_label,
      deep_link: projection.deep_link,
      ...(typeof res.status === "number" ? { http_status: res.status } : {}),
      at,
    },
  });
  return { status: "delivery_attempted", projection, event };
}

/**
 * Record a human acknowledgement (the content-free "Open" callback tap). This is the ONLY path that
 * writes `human-ack`; a Bot API 200 never does. Idempotency is a read-model concern (a second ack is
 * just another `human-ack` event; recovery folds "acked = any human-ack after the last attempt").
 */
export function recordHumanAck(
  askId: string,
  deps: Pick<NotifyDeps, "appendEvent" | "now">
): AppendResult {
  const at = (deps.now ?? new Date()).toISOString();
  return deps.appendEvent({
    kind: "human-ack",
    correlation_id: askId,
    ts: at,
    payload: { lane: "telegram", at },
  });
}

/**
 * A durable journal sink for the two notify-lane events, bound to a workspace `root`. The production
 * composition (loop index.ts) injects this into `sendNotification` / `recordHumanAck`; the `inbox`
 * domain never value-imports the journal from another domain — this stays same-domain (journal.js).
 */
export function createDurableNotifyJournal(root: string): NotifyDeps["appendEvent"] {
  return (input) =>
    appendInboxEvent(root, {
      kind: input.kind,
      correlation_id: input.correlation_id,
      ts: input.ts,
      payload: input.payload,
    });
}
