// Comms section component tests (I-14 / AIO-395, the G6a gate).
//
// Rendered with react-dom/server (no jsdom dependency — same node environment as the existing client lib
// tests), which is enough to assert structure/snapshots and enumerate every ask-card state. Interaction
// contracts (the scoped-confirm POST body, the content-free notification) are asserted against the pure
// functions the components call, so "no other fields leave the client" is a real, precise check.

import { describe, test, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CommsQueue, refreshLabel } from "./CommsQueue";
import { CommsDetail } from "./CommsDetail";
import { LatestDetailRequest } from "./detail-request";
import { AskCard } from "./AskCard";
import { ScopedConfirmDialog } from "./ScopedConfirmDialog";
import { postAskArchive, postAskReply, postDecision } from "./api";
import {
  contentFreeNotification,
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
} from "./types";
import type { Api } from "../../lib/api";

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
    staleness: {
      stale: false,
      newest_observation_ts: "2026-07-14T08:30:00.000Z",
      slo_ms: 300000,
      age_ms: 120000,
    },
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
    view.staleness = {
      ...view.staleness,
      stale: true,
      newest_observation_ts: "2099-01-01T00:00:00.000Z",
    };
    view.refresh = {
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
          pendingApprovals: [],
          generated_at: "2026-07-16T02:00:00.000Z",
          staleness: fixtureView().staleness,
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
});
