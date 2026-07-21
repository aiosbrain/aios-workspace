// Comms section component tests (I-14 / AIO-395, the G6a gate).
//
// Rendered with react-dom/server (no jsdom dependency — same node environment as the existing client lib
// tests), which is enough to assert structure/snapshots and enumerate every ask-card state. Interaction
// contracts (the scoped-confirm POST body, the content-free notification) are asserted against the pure
// functions the components call, so "no other fields leave the client" is a real, precise check.

import { describe, test, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CommsQueue,
  refreshLabel,
  telegramInboundLabel,
  telegramLaneLabel,
} from "./CommsQueue";
import { CommsDetail } from "./CommsDetail";
import { shouldAcknowledgeDeliveredAsk } from "./ack-evidence";
import { LatestDetailRequest } from "./detail-request";
import { AskCard } from "./AskCard";
import { ScopedConfirmDialog } from "./ScopedConfirmDialog";
import { ReplyConfirmDialog, advanceReplyConfirmation, canSubmitReply } from "./ReplyConfirmDialog";
import { SendStatusStrip } from "./SendStatusStrip";
import { SentSection } from "./SentSection";
import {
  fetchOutbox,
  postAskAck,
  postAskArchive,
  postAskReply,
  postDecision,
  postReplyCheck,
  postReplySend,
} from "./api";
import { ageLabel, presentSendState } from "./presenters";
import {
  MAX_CONFIRMED_SEND_ATTEMPTS,
  canRetryConfirmed,
  deferredRetryAfter,
  retryDelayMs,
} from "./reply-retry";
import { gmailThreadRef, immutableReplySnapshot, retainLastGood } from "./view-state";
import {
  contentFreeNotification,
  desktopNotify,
  notifyNewBlockingAsks,
  CONTENT_FREE_DEEPLINK_RE,
  type InboxNotification,
} from "./notification";
import {
  ASK_CARD_STATES,
  ASK_CARD_STATE_LABELS,
  type InboxItem,
  type InboxView,
  type DisplayProjection,
  type InboxDetail,
  type OutboxCommand,
} from "./types";
import { ApiError, type Api } from "../../lib/api";

// ── fixtures (synthetic, admin-tier — no grey channels, no real names) ──────────────────────────────
function agentAsk(
  id: string,
  opts: Partial<InboxItem> & { title: string; why: string }
): InboxItem {
  return {
    id,
    origin: "agent-event",
    source: "claude-code",
    account: null,
    bucket: "needs-you",
    protected: false,
    attention_state: "surfaced",
    action_state: "none",
    ts: "2026-07-14T09:00:00.000Z",
    ask: { id, title: opts.title, kind: "idle", severity: "blocker", status: "open" },
    ...opts,
  };
}
function thread(
  id: string,
  opts: Partial<InboxItem> & { why: string; snippet: string }
): InboxItem {
  return {
    id,
    origin: "thread-state",
    source: "email",
    account: "me@acme.com",
    bucket: "thread",
    protected: false,
    attention_state: "surfaced",
    action_state: "none",
    ts: "2026-07-14T08:30:00.000Z",
    observation: {
      key: id,
      account: "me@acme.com",
      object_kind: "email",
      ts: "2026-07-14T08:30:00.000Z",
      snippet: opts.snippet,
    },
    ...opts,
  };
}

function fixtureView(): InboxView {
  return {
    items: [
      agentAsk("ask-blocker", {
        title: "Approve deploy of feat/inbox-adapter",
        why: "open blocker",
        protected: true,
      }),
      thread("thr-vip", {
        why: "tier-1 client · active engagement",
        snippet: "can you confirm the SOW today",
        protected: true,
        bucket: "thread",
      }),
      agentAsk("ask-fyi", {
        title: "Nightly ran clean",
        why: "recency",
        protected: false,
        bucket: "fyi",
        action_state: "none",
      }),
      thread("thr-fyi", { why: "recency", snippet: "quarterly review notes attached" }),
    ],
    ranker_version: "inbox-ranker-v1",
    generated_at: "2026-07-14T09:05:00.000Z",
    freshness: null,
  };
}

function gmailDetail(replyable = true): InboxDetail {
  const selected = thread("gmail-row", { why: "recency", snippet: "Current subject" });
  selected.observation = {
    key: "gog:primary/email/message-1",
    connection_id: "gog:primary",
    account: "primary",
    tenant: "personal",
    object_kind: "email",
    native_id: "message-1",
    thread_id: "native-thread-1",
    ts: selected.ts,
    snippet: "Current subject",
    origin: "enriched",
    deleted: false,
    participants: [{ id: "sender@example.test", role: "from" }],
  };
  return {
    item: selected,
    agentContext: null,
    replyability: { replyable },
    pendingApprovals: [],
    generated_at: "2026-07-21T00:00:00.000Z",
    freshness: null,
  };
}

describe("CommsQueue", () => {
  test("renders protected items above the partition separator, each row carrying its why string", () => {
    const view = fixtureView();
    const html = renderToStaticMarkup(
      <CommsQueue view={view} selectedId="ask-blocker" onSelect={() => {}} />
    );
    const sep = html.indexOf('aria-label="protected partition"');
    expect(sep).toBeGreaterThan(-1);

    // Both protected rows render ABOVE the separator; both unprotected rows render BELOW it.
    expect(html.indexOf("Approve deploy of feat/inbox-adapter")).toBeGreaterThan(-1);
    expect(html.indexOf("Approve deploy of feat/inbox-adapter")).toBeLessThan(sep);
    expect(html.indexOf("can you confirm the SOW today")).toBeLessThan(sep);
    expect(html.indexOf("Nightly ran clean")).toBeGreaterThan(sep);
    expect(html.indexOf("quarterly review notes attached")).toBeGreaterThan(sep);

    // Every row keeps its "why" explanation available to assistive technology without adding chrome.
    for (const why of ["open blocker", "tier-1 client · active engagement", "recency"]) {
      expect(html).toContain(why);
    }
    expect(html).not.toContain("inbox-ranker-v1");
    expect(html).not.toContain("Ranked by attention");
    expect(html).toContain("Telegram sends alerts only");
  });

  test("freshness reports connector success time, not a future source occurrence time", () => {
    const view = fixtureView();
    view.freshness = {
      status: "ready",
      last_attempt_at: "2026-07-14T09:04:59.000Z",
      last_success_at: "2026-07-14T09:05:00.000Z",
      error: null,
      sources: { gmail: "ready", calendar: "ready", telegram: "outbound_only" },
    };
    expect(refreshLabel(view)).toMatch(/^Updated /);
    const html = renderToStaticMarkup(
      <CommsQueue view={view} selectedId={null} onSelect={() => {}} />
    );
    expect(html).not.toContain("2099");
    expect(html).not.toContain("STALE");
    expect(ageLabel("2099-01-01T00:00:00.000Z", new Date("2026-07-16T00:00:00.000Z"))).toBe(
      "just now"
    );
  });

  test("a fetch error is rendered in the header while the last-good queue stays visible", () => {
    const view = fixtureView();
    const html = renderToStaticMarkup(
      <CommsQueue
        view={view}
        selectedId={null}
        onSelect={() => {}}
        error="GET /api/inbox failed: 503"
      />
    );
    expect(html).toContain("Refresh failed — showing the last good read.");
    expect(html).toContain("GET /api/inbox failed: 503");
    expect(html).toContain('role="status"');
    // The queue itself still renders from the last good read.
    expect(html).toContain("Approve deploy of feat/inbox-adapter");
  });

  test("renders overdue chip and independent outbound/inbound Telegram status", () => {
    const view = fixtureView();
    view.notify = {
      escalation_window_ms: 900_000,
      states: {},
      overdue: {
        "ask-blocker": {
          overdue_by_ms: 300_000,
          delivery_attempts: 0,
          last_delivery_at: null,
        },
      },
      lane: {
        status: "configured",
        last_attempt_at: null,
        last_delivery_at: null,
        last_error: null,
      },
    };
    view.freshness = {
      status: "ready",
      last_attempt_at: "2026-07-14T09:04:59.000Z",
      last_success_at: "2026-07-14T09:05:00.000Z",
      error: null,
      sources: { gmail: "ready", calendar: "ready", telegram: "unavailable" },
    };
    const html = renderToStaticMarkup(
      <CommsQueue view={view} selectedId="ask-blocker" onSelect={() => {}} />
    );
    expect(html).toContain("Unacked");
    expect(html).toContain("overdue 5m · never delivered");
    expect(html).toContain("Telegram alerts armed");
    expect(html).toContain("Telegram inbox not connected");
    expect(telegramLaneLabel(view)).toBe("Telegram alerts armed");
    expect(telegramInboundLabel(view)).toBe("Telegram inbox not connected");
  });
});

describe("AskCard", () => {
  test("renders EVERY state in the I-13 vocabulary (a missing state is a failing test)", () => {
    for (const state of ASK_CARD_STATES) {
      const html = renderToStaticMarkup(
        <AskCard
          state={state}
          title="Claude Code"
          body="git push origin feat/x"
          why="open blocker"
        />
      );
      expect(html, `state ${state} must render its label`).toContain(ASK_CARD_STATE_LABELS[state]);
      expect(html, `state ${state} must be tagged`).toContain(`data-ask-state="${state}"`);
    }
    // The three the design ruling names explicitly are covered by the enumeration above.
    for (const named of ["stale", "action_pending", "delivery_failed"] as const) {
      expect(ASK_CARD_STATES).toContain(named);
    }
  });
});

describe("actionable Claude ask", () => {
  test("renders useful prose context and an inline original-session reply composer", () => {
    const item = agentAsk("ask-reply", {
      title: "Generic hook title",
      why: "open blocker",
      protected: true,
    });
    const html = renderToStaticMarkup(
      <CommsDetail
        detail={{
          item,
          agentContext: {
            subject: "Choose the release environment",
            summary: "Claude has prepared the release and needs to know whether to use staging.",
            turns: [{ role: "Claude", text: "Should I deploy this to staging or production?" }],
            canReply: true,
          },
          replyability: null,
          pendingApprovals: [],
          generated_at: "2026-07-16T02:00:00.000Z",
          freshness: fixtureView().freshness,
        }}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
      />
    );
    expect(html).toContain("Choose the release environment");
    expect(html).toContain("Should I deploy this to staging or production?");
    expect(html).toContain("resumes the original Claude session");
    expect(html).toContain("Send to Claude");
    expect(html).toContain("Archive");
    expect(html).not.toContain("data-terminal-frame");
    expect(html.match(/Choose the release environment/g)).toHaveLength(1);
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain("uppercase");
  });

  test("renders delivered and never-delivered recovery evidence", () => {
    const item = agentAsk("ask-overdue", {
      title: "Needs acknowledgment",
      why: "open blocker",
    });
    const base = {
      item,
      agentContext: null,
      pendingApprovals: [],
      generated_at: "2026-07-16T02:00:00.000Z",
      freshness: null,
    };
    const never = renderToStaticMarkup(
      <CommsDetail
        detail={{
          ...base,
          notify: {
            escalation_window_ms: 900_000,
            states: {},
            overdue: {
              [item.id]: {
                overdue_by_ms: 60_000,
                delivery_attempts: 0,
                last_delivery_at: null,
              },
            },
            lane: {
              status: "configured",
              last_attempt_at: null,
              last_delivery_at: null,
              last_error: null,
            },
          },
        }}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
      />
    );
    expect(never).toContain("Never delivered to your phone");

    const delivered = renderToStaticMarkup(
      <CommsDetail
        detail={{
          ...base,
          notify: {
            escalation_window_ms: 900_000,
            states: {},
            overdue: {
              [item.id]: {
                overdue_by_ms: 60_000,
                delivery_attempts: 1,
                last_delivery_at: "2026-07-16T01:00:00.000Z",
              },
            },
            lane: {
              status: "delivery_ok",
              last_attempt_at: "2026-07-16T01:00:00.000Z",
              last_delivery_at: "2026-07-16T01:00:00.000Z",
              last_error: null,
            },
          },
        }}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
      />
    );
    expect(delivered).toContain("Phone alert sent");
    expect(delivered).toContain("not acknowledged");
  });

  test("Telegram detail uses its own source mark and never renders a Gmail reply link", () => {
    const item = thread("telegram-thread", {
      why: "new Telegram message",
      snippet: "synthetic message",
      source: "telegram-chat",
    });
    item.observation!.object_kind = "telegram-chat";
    const html = renderToStaticMarkup(
      <CommsDetail
        detail={{
          item,
          agentContext: null,
          pendingApprovals: [],
          generated_at: "2026-07-16T02:00:00.000Z",
          freshness: null,
        }}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
      />
    );
    expect(html).toContain("synthetic message");
    expect(html).not.toContain("Open Gmail");

    const email = thread("email-thread", {
      why: "new email",
      snippet: "synthetic email",
    });
    const emailHtml = renderToStaticMarkup(
      <CommsDetail
        detail={{
          item: email,
          agentContext: null,
          pendingApprovals: [],
          generated_at: "2026-07-16T02:00:00.000Z",
          freshness: null,
        }}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
      />
    );
    expect(emailHtml).toContain("Open Gmail");
  });

  test("reply body cannot substitute a session and archive has an empty body", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api: Api = {
      get: async () => ({}) as never,
      post: async (path, body) => {
        calls.push({ path, body });
        return { ok: true } as never;
      },
      wsUrl: () => "",
    };
    await postAskReply(api, "ask/a", "Use staging");
    await postAskArchive(api, "ask/a");
    expect(calls).toEqual([
      { path: "/api/inbox/ask%2Fa/reply", body: { message: "Use staging" } },
      { path: "/api/inbox/ask%2Fa/archive", body: {} },
    ]);
  });

  test("ack posts no client content or timestamp", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api: Api = {
      get: async () => ({}) as never,
      post: async (path, body) => {
        calls.push({ path, body });
        return { ok: true, recorded: true } as never;
      },
      wsUrl: () => "",
    };
    await postAskAck(api, "ask/a");
    expect(calls).toEqual([{ path: "/api/inbox/ask%2Fa/ack", body: undefined }]);
  });

  test("an unresumable active ask still offers archive without noisy terminal chrome", () => {
    const item = agentAsk("ask-unbound", {
      title: "Claude needs clarification",
      why: "open blocker",
    });
    const html = renderToStaticMarkup(
      <CommsDetail
        detail={{
          item,
          agentContext: {
            subject: "Claude needs clarification",
            summary: "The original session cannot be resumed safely.",
            turns: [],
            canReply: false,
          },
          replyability: null,
          pendingApprovals: [],
          generated_at: "2026-07-16T02:00:00.000Z",
          freshness: null,
        }}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
      />
    );
    expect(html).toContain("Archive");
    expect(html).toContain("can’t be resumed safely");
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain("uppercase");
  });
});

describe("native Gmail reply composer", () => {
  test("shows only for server-replyable Gmail detail and otherwise renders the safety fallback", () => {
    const replyable = renderToStaticMarkup(
      <CommsDetail
        detail={gmailDetail(true)}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
        onReviewReply={async () => {}}
      />
    );
    expect(replyable).toContain("Review &amp; send");
    expect(replyable).toContain("Recipients, subject, account, and Gmail thread");
    expect(replyable).not.toContain("can’t be replied to safely here");

    const refused = renderToStaticMarkup(
      <CommsDetail
        detail={gmailDetail(false)}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
        onReviewReply={async () => {}}
      />
    );
    expect(refused).toContain("This message can’t be replied to safely here. Open it in Gmail.");
    expect(refused).not.toContain("Review &amp; send");
  });

  test("API wrappers construct only the documented request fields", async () => {
    const calls: { method: "GET" | "POST"; path: string; body?: unknown }[] = [];
    const api: Api = {
      get: async (path) => {
        calls.push({ method: "GET", path });
        return { commands: [], count: 0, generated_at: "now" } as never;
      },
      post: async (path, body) => {
        calls.push({ method: "POST", path, body });
        return { ok: true } as never;
      },
      wsUrl: () => "",
    };
    await fetchOutbox(api);
    await postReplyCheck(api, "gmail/row", "  exact body  ");
    await postReplySend(api, "gmail/row", {
      command_id: "cmd",
      digest: "digest",
      body: "  exact body  ",
      // @ts-expect-error — destination fields are stripped even if a caller tries to add them.
      account: "attacker-selected",
      thread_id: "attacker-thread",
    });
    expect(calls).toEqual([
      { method: "GET", path: "/api/outbox" },
      {
        method: "POST",
        path: "/api/inbox/gmail%2Frow/reply-check",
        body: { body: "  exact body  " },
      },
      {
        method: "POST",
        path: "/api/inbox/gmail%2Frow/reply-send",
        body: { command_id: "cmd", digest: "digest", body: "  exact body  " },
      },
    ]);
  });

  test("confirmation snapshot is immutable and requires arm before confirm", () => {
    const snapshot = immutableReplySnapshot("gmail-row", "  exact body  ", {
      ok: true,
      command_id: "cmd-1",
      digest: "a".repeat(64),
      preview: {
        to: ["sender@example.test"],
        subject: "Re: Current subject",
        body: "  exact body  ",
        thread_label: "Gmail thread",
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.preview)).toBe(true);
    expect(Object.isFrozen(snapshot.preview.to)).toBe(true);
    expect(snapshot.body).toBe("  exact body  ");
    expect(canSubmitReply("unarmed", false)).toBe(false);
    const armed = advanceReplyConfirmation("unarmed");
    expect(armed).toBe("armed");
    expect(canSubmitReply(armed, false)).toBe(true);
    expect(canSubmitReply(armed, true)).toBe(false);

    const html = renderToStaticMarkup(
      <ReplyConfirmDialog snapshot={snapshot} onConfirm={() => {}} onClose={() => {}} />
    );
    expect(html).toContain("Arm send");
    expect(html).not.toContain("Confirm send");
    expect(html).toContain("sender@example.test");
    expect(html).toContain("  exact body  ");
    expect(html).toContain("Gmail thread");
  });
});

describe("Gmail send status and recovery", () => {
  const command = (state: OutboxCommand["state"]): OutboxCommand => ({
    command_id: `cmd-${state}`,
    state,
    thread_ref: "gmail:native-thread-1",
    native_message_id: null,
    native_thread_id: "native-thread-1",
    last_attempt_at: "2026-07-21T00:00:00.000Z",
  });

  test("renders only the approved human-facing labels and tooltips", () => {
    const expected = {
      attempting: ["Sending…", "Sending through Gmail"],
      sent: ["Sent ✓", "Accepted by Gmail"],
      reconciled: ["Sent ✓", "Found in Gmail Sent"],
      outcome_unknown: ["Confirming…", "Checking Gmail Sent before any retry"],
      failed: ["Failed", "Gmail did not accept the send"],
    } as const;
    for (const [state, [label, tooltip]] of Object.entries(expected)) {
      expect(presentSendState(state as OutboxCommand["state"])).toMatchObject({ label, tooltip });
      const html = renderToStaticMarkup(
        <SendStatusStrip command={command(state as OutboxCommand["state"])} />
      );
      expect(html).toContain(label);
      expect(html).toContain(tooltip);
      expect(html).not.toContain("outcome_unknown");
      expect(html).not.toContain("reconciled");
      expect(html).not.toContain("PDP");
      expect(html).not.toContain("TOCTOU");
    }
  });

  test("failed live state offers a fresh-check action; durable reload confirmation never retries", () => {
    const failed = renderToStaticMarkup(
      <SendStatusStrip
        command={command("failed")}
        canTryAgain
        recoveryError="Review the current message again."
        onTryAgain={() => {}}
      />
    );
    expect(failed).toContain("Try again");
    expect(failed).toContain("Review the current message again.");

    const reloaded = renderToStaticMarkup(
      <CommsDetail
        detail={gmailDetail(true)}
        onScopedConfirm={() => {}}
        onReply={async () => {}}
        onArchive={async () => {}}
        onReviewReply={async () => {}}
        outboxCommand={command("outcome_unknown")}
      />
    );
    expect(reloaded).toContain("Confirming…");
    expect(reloaded).not.toContain("Try again");
    expect(reloaded).not.toContain("outcome_unknown");
  });

  test("sent section is collapsed and uses the same status presenter", () => {
    const html = renderToStaticMarkup(
      <SentSection commands={[command("sent"), command("reconciled")]} />
    );
    expect(html).toContain("<details");
    expect(html).not.toContain('open="');
    expect(html).toContain("Sent (2)");
    expect(html).toContain("Accepted by Gmail");
    expect(html).toContain("Found in Gmail Sent");
    expect(html).not.toContain("reconciled");
  });

  test("retry timing respects server timestamps and stops after three confirmed submissions", () => {
    const now = Date.parse("2026-07-21T00:00:00.000Z");
    expect(retryDelayMs("2026-07-21T00:00:02.500Z", now)).toBe(2500);
    expect(retryDelayMs("2026-07-20T00:00:00.000Z", now)).toBe(0);
    expect(MAX_CONFIRMED_SEND_ATTEMPTS).toBe(3);
    expect(canRetryConfirmed(1)).toBe(true);
    expect(canRetryConfirmed(2)).toBe(true);
    expect(canRetryConfirmed(3)).toBe(false);
    const deferred = new ApiError(429, "deferred", {
      retry_after: "2026-07-21T00:01:00.000Z",
    });
    expect(deferredRetryAfter(deferred)).toBe("2026-07-21T00:01:00.000Z");
  });

  test("inbox and outbox polling failures retain their own independent last-good values", () => {
    const inbox = fixtureView();
    const durable = { commands: [command("sent")], count: 1, generated_at: "now" };
    expect(retainLastGood(inbox, { ok: false })).toBe(inbox);
    expect(retainLastGood(durable, { ok: false })).toBe(durable);
    expect(retainLastGood(inbox, { ok: true, value: fixtureView() })).not.toBe(inbox);
    expect(gmailThreadRef(gmailDetail(true))).toBe("gmail:native-thread-1");
  });
});

describe("detail request sequencing", () => {
  test("a slower A response cannot replace B after B is selected", async () => {
    const gate = new LatestDetailRequest();
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const a = new Promise<string>((resolve) => (resolveA = resolve));
    const b = new Promise<string>((resolve) => (resolveB = resolve));
    const accepted: string[] = [];
    const reject = () => {
      throw new Error("unexpected rejection");
    };

    gate.select("A");
    const loadA = gate.load(
      "A",
      () => a,
      (value) => accepted.push(value),
      reject
    );
    gate.select("B");
    const loadB = gate.load(
      "B",
      () => b,
      (value) => accepted.push(value),
      reject
    );
    resolveB("detail-B");
    await loadB;
    resolveA("detail-A");
    await loadA;
    expect(accepted).toEqual(["detail-B"]);
  });
});

describe("human acknowledgment evidence", () => {
  const item = agentAsk("ask-ack", {
    title: "Delivered ask",
    why: "open blocker",
  });
  const detail = {
    item,
    agentContext: null,
    pendingApprovals: [],
    generated_at: "2026-07-16T02:00:00.000Z",
    freshness: null,
    notify: {
      escalation_window_ms: 900_000,
      states: {
        [item.id]: {
          delivery_attempts: 1,
          last_delivery_at: "2026-07-16T01:00:00.000Z",
          acked: false,
          last_ack_at: null,
        },
      },
      overdue: {},
      lane: {
        status: "delivery_ok" as const,
        last_attempt_at: "2026-07-16T01:00:00.000Z",
        last_delivery_at: "2026-07-16T01:00:00.000Z",
        last_error: null,
      },
    },
  };

  test("requires selected, visible, focused, delivered-unacked detail", () => {
    const check = (overrides: Partial<Parameters<typeof shouldAcknowledgeDeliveredAsk>[0]> = {}) =>
      shouldAcknowledgeDeliveredAsk({
        id: item.id,
        selectedId: item.id,
        detail,
        visibilityState: "visible",
        hasFocus: true,
        ...overrides,
      });
    expect(check()).toBe(true);
    expect(check({ visibilityState: "hidden" })).toBe(false);
    expect(check({ hasFocus: false })).toBe(false);
    expect(check({ selectedId: "another" })).toBe(false);
    expect(check({ detail: null })).toBe(false);
    expect(
      check({
        detail: {
          ...detail,
          notify: { ...detail.notify, states: {} },
        },
      })
    ).toBe(false);
    expect(
      check({
        detail: {
          ...detail,
          notify: {
            ...detail.notify,
            states: {
              [item.id]: {
                ...detail.notify.states[item.id],
                acked: true,
              },
            },
          },
        },
      })
    ).toBe(false);
  });
});

describe("ScopedConfirmDialog", () => {
  const projection: DisplayProjection = {
    handle: "cap-123",
    operation: "Bash",
    summary: "Bash · cmd:git",
    digest: "a".repeat(64),
    expiresAt: "2026-07-14T09:10:00.000Z",
  };

  test("renders the display projection AND the request digest the human binds to", () => {
    const html = renderToStaticMarkup(
      <ScopedConfirmDialog projection={projection} onDecide={() => {}} onClose={() => {}} />
    );
    expect(html).toContain("Bash · cmd:git"); // display projection summary
    expect(html).toContain("a".repeat(64)); // the canonical request digest
    expect(html).toContain("authority required");
  });
});

describe("scoped-confirm decision POST", () => {
  test("posts ONLY { handle, digest, decision } — no other fields leave the client", async () => {
    let captured: { path: string; body: unknown } | null = null;
    const api: Api = {
      get: async () => ({}) as never,
      post: async (path, body) => {
        captured = { path, body };
        return { ok: true } as never;
      },
      wsUrl: () => "",
    };
    // The decision resource IS the handle: the client posts to /api/inbox/<handle>/decision so the server
    // can bind the URL id to the handle. Deliberately hand it extra fields; postDecision must strip
    // everything but the three contract fields.
    await postDecision(api, "cap-123", {
      handle: "cap-123",
      digest: "d1",
      decision: "approve",
      // @ts-expect-error — a caller cannot smuggle request payload through the decision body.
      operation: "Bash",
      command: "git push",
    });
    expect(captured).not.toBeNull();
    expect(captured!.path).toBe("/api/inbox/cap-123/decision");
    expect(Object.keys(captured!.body as object).sort()).toEqual(["decision", "digest", "handle"]);
    expect(captured!.body).toEqual({ handle: "cap-123", digest: "d1", decision: "approve" });
  });
});

describe("content-free notifications", () => {
  test("the payload carries no comms content and a well-formed deep link", () => {
    const item = agentAsk("ask-blocker", {
      title: "SECRET client merger terms",
      why: "open blocker",
      protected: true,
    });
    const n = contentFreeNotification(item);
    expect(n.deepLink).toMatch(CONTENT_FREE_DEEPLINK_RE);
    expect(n.deepLink).toContain("ask-blocker");
    // Never leaks the ask title / any snippet into the banner.
    expect(`${n.title} ${n.body}`).not.toContain("SECRET client merger terms");
  });

  test("fires for a newly-appeared blocking ask, not for one already seen", () => {
    const view = fixtureView();
    const fired: InboxNotification[] = [];
    const fire = vi.fn((n: InboxNotification) => fired.push(n));

    // First appearance → one banner (the protected blocker ask).
    notifyNewBlockingAsks(new Set(), view, fire);
    expect(fired.length).toBe(1);
    expect(fired[0].deepLink).toBe("aios://inbox/ask-blocker");

    // Already seen → silent.
    fire.mockClear();
    notifyNewBlockingAsks(new Set(["ask-blocker"]), view, fire);
    expect(fire).not.toHaveBeenCalled();
  });

  test("permission 'default': the TRIGGERING ask still banners once permission is granted", async () => {
    const created: { title: string; options?: NotificationOptions }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = "granted";
        return "granted" as NotificationPermission;
      });
      constructor(title: string, options?: NotificationOptions) {
        created.push({ title, options });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    try {
      const n = contentFreeNotification(
        agentAsk("ask-blocker", { title: "t", why: "open blocker", protected: true })
      );
      desktopNotify(n);
      expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
      // The seen-set already contains the ask by now — the grant callback must fire it itself.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(created).toHaveLength(1);
      expect(created[0].title).toBe("AIOS · needs you");
      expect(created[0].options?.tag).toBe(n.deepLink);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("permission 'denied': no banner and no permission re-prompt", async () => {
    const created: string[] = [];
    class FakeNotification {
      static permission: NotificationPermission = "denied";
      static requestPermission = vi.fn(async () => "denied" as NotificationPermission);
      constructor(title: string) {
        created.push(title);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    try {
      desktopNotify(contentFreeNotification(agentAsk("a1", { title: "t", why: "w" })));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
