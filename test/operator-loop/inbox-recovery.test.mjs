// I-05 / AIO-386 · G3b — Telegram notify lane + recovery view.
//
// The interrupt lane (notify-telegram) can fail in five ways; in EVERY one the ask must stay durably
// queued and surface in `aios inbox --overdue`. This suite fakes the Bot API at the HTTP boundary
// with recorded fixtures (the injected `TelegramTransport`) — no network, no real bot — matching the
// injected-transport convention of the comms sender. Fixture seeding is self-contained: each test
// creates a temp workspace, appends fixture asks via the asks-store API, and appends
// `delivery-attempted` events (older than the escalation window) via the I-02 `appendInboxEvent`
// interface — that seeded state IS the "overdue" input. Everything is imported from the compiled
// `dist/operator-loop/index.js`, and `sender.ts` / `comms-sender.test.mjs` are never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  // asks store (durable queue)
  appendCreate,
  readAsks,
  // journal (durable I-02 substrate)
  appendInboxEvent,
  readJournalSegments,
  rebuildReadModel,
  // I-05 notify lane
  projectNotification,
  formatNotificationText,
  deepLinkForAsk,
  askIdFromDeepLink,
  DEEP_LINK_RE,
  loadTelegramConfig,
  fetchTelegramTransport,
  sendNotification,
  recordHumanAck,
  createDurableNotifyJournal,
  // I-05 recovery view
  buildOverdue,
  overdueView,
  foldNotificationState,
  renderOverdueText,
  buildOverdueView,
  DEFAULT_ESCALATION_WINDOW_MS,
} from "../../dist/operator-loop/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_MS = DEFAULT_ESCALATION_WINDOW_MS;

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-recovery-"));
}

// A deterministic clock: "now" and helper offsets around the escalation window.
const NOW = new Date("2026-07-14T12:00:00.000Z");
const minsAgo = (m) => new Date(NOW.getTime() - m * 60_000);
const iso = (d) => d.toISOString();

// Seed one blocking ask created `createdMinsAgo` ago; returns the stored record.
function seedAsk(
  root,
  { createdMinsAgo = 30, title = "Approve deploy?", source = "claude-code" } = {}
) {
  return appendCreate(root, {
    kind: "approval",
    severity: "blocker",
    title,
    source,
    tier: "admin",
    createdAt: iso(minsAgo(createdMinsAgo)),
  });
}

// Seed a `delivery-attempted` journal event `attemptMinsAgo` ago for an ask (the "overdue" input).
function seedDelivery(root, askId, attemptMinsAgo = 25) {
  return appendInboxEvent(root, {
    kind: "delivery-attempted",
    correlation_id: askId,
    ts: iso(minsAgo(attemptMinsAgo)),
    payload: {
      lane: "telegram",
      count: 1,
      repo_label: "aios-workspace",
      at: iso(minsAgo(attemptMinsAgo)),
    },
  });
}

// Recorded Bot-API fixtures, faked at the HTTP boundary.
const FIXTURE = {
  ok: async () => ({ ok: true, status: 200 }),
  offline: async () => ({ ok: true, status: 200, description: "queued (recipient offline)" }),
  revoked: async () => ({ ok: false, status: 401, description: "Unauthorized" }),
  networkError: async () => ({ ok: false, description: "transport-error:FetchError" }),
};

// ── the five recovery fixtures — no fixture loses an ask ────────────────────────────────────────────

test("Telegram disabled — no wire call, no journal event, ask stays queued + overdue", async () => {
  const root = ws();
  try {
    const ask = seedAsk(root);
    const cfg = { enabled: false, token: null, chatId: null };
    let transportCalls = 0;
    const res = await sendNotification(
      projectNotification({ ask_id: ask.id, count: 1, repo_label: "aios-workspace" }),
      cfg,
      {
        transport: async () => (transportCalls++, { ok: true }),
        appendEvent: (e) => appendInboxEvent(root, e),
        now: NOW,
      }
    );
    assert.equal(res.status, "disabled");
    assert.equal(transportCalls, 0, "disabled lane must not touch the wire");
    assert.equal(
      readJournalSegments(root).events.length,
      0,
      "disabled lane writes no journal event"
    );

    // Ask still durably queued and overdue (fallback to created_at past the window).
    assert.equal(readAsks(root).asks.find((a) => a.id === ask.id)?.status, "open");
    const view = buildOverdue(root, { now: NOW });
    assert.ok(
      view.items.some((i) => i.ask_id === ask.id),
      "disabled → ask still surfaces overdue"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token revoked — Bot API rejects, no delivery-attempted, ask stays queued + overdue", async () => {
  const root = ws();
  try {
    const ask = seedAsk(root);
    const cfg = { enabled: true, token: "revoked-token", chatId: "123" };
    const res = await sendNotification(
      projectNotification({ ask_id: ask.id, count: 1, repo_label: "aios-workspace" }),
      cfg,
      { transport: FIXTURE.revoked, appendEvent: createDurableNotifyJournal(root), now: NOW }
    );
    assert.equal(res.status, "failed");
    assert.equal(res.reason, "Unauthorized");
    // A rejected send is NOT a delivery attempt — nothing is journaled.
    assert.equal(readJournalSegments(root).events.length, 0);
    assert.equal(readAsks(root).asks[0].status, "open");
    assert.ok(buildOverdue(root, { now: NOW }).items.some((i) => i.ask_id === ask.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API-success-without-ack — delivery-attempted written, no ack → overdue after the window", async () => {
  const root = ws();
  try {
    const ask = seedAsk(root, { createdMinsAgo: 40 });
    const cfg = { enabled: true, token: "t", chatId: "123" };
    // Deliver 25 min ago (older than the 15m window); the human never taps Open.
    const res = await sendNotification(
      projectNotification({ ask_id: ask.id, count: 1, repo_label: "aios-workspace" }),
      cfg,
      { transport: FIXTURE.ok, appendEvent: createDurableNotifyJournal(root), now: minsAgo(25) }
    );
    assert.equal(res.status, "delivery_attempted");
    const { events } = readJournalSegments(root);
    assert.equal(events.filter((e) => e.kind === "delivery-attempted").length, 1);
    assert.equal(events.filter((e) => e.kind === "human-ack").length, 0);

    const view = buildOverdue(root, { now: NOW });
    const row = view.items.find((i) => i.ask_id === ask.id);
    assert.ok(row, "delivered-but-unacked ask is overdue");
    assert.equal(row.delivery_attempts, 1);
    assert.ok(row.overdue_by_ms > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coordinator restart — journal is durable on disk; overdue survives a fresh re-read", async () => {
  const root = ws();
  try {
    const ask = seedAsk(root);
    seedDelivery(root, ask.id, 25);
    // "Before restart": compute the view.
    const before = buildOverdue(root, { now: NOW });
    assert.ok(before.items.some((i) => i.ask_id === ask.id));
    // "After restart": a brand-new read of the same on-disk asks + journal — nothing in memory carried
    // over. Same ask still surfaces (durable-queue claim). Deep-equal proves nothing was lost.
    const after = buildOverdue(root, { now: NOW });
    assert.deepEqual(after.items, before.items, "restart re-read is identical — no ask lost");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("phone offline — Bot API accepts (queues), delivery-attempted written, still overdue unacked", async () => {
  const root = ws();
  try {
    const ask = seedAsk(root, { createdMinsAgo: 40 });
    const cfg = { enabled: true, token: "t", chatId: "123" };
    const res = await sendNotification(
      projectNotification({ ask_id: ask.id, count: 1, repo_label: "aios-workspace" }),
      cfg,
      {
        transport: FIXTURE.offline,
        appendEvent: createDurableNotifyJournal(root),
        now: minsAgo(20),
      }
    );
    // A phone-offline delivery is still ACCEPTED by the Bot API (Telegram queues it) → delivery_attempted.
    assert.equal(res.status, "delivery_attempted");
    assert.ok(buildOverdue(root, { now: NOW }).items.some((i) => i.ask_id === ask.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no fixture loses an ask — all five scenarios keep the ask durably queued", async () => {
  // A compact matrix pass: each scenario, seeded identically, always yields status==open + overdue.
  for (const scenario of ["disabled", "revoked", "success", "offline"]) {
    const root = ws();
    try {
      const ask = seedAsk(root, { createdMinsAgo: 40 });
      const deps = { appendEvent: createDurableNotifyJournal(root), now: minsAgo(25) };
      if (scenario === "disabled") {
        await sendNotification(
          projectNotification({ ask_id: ask.id, count: 1, repo_label: "r" }),
          { enabled: false, token: null, chatId: null },
          deps
        );
      } else {
        const cfg = { enabled: true, token: "t", chatId: "1" };
        const tr =
          scenario === "revoked"
            ? FIXTURE.revoked
            : scenario === "offline"
              ? FIXTURE.offline
              : FIXTURE.ok;
        await sendNotification(
          projectNotification({ ask_id: ask.id, count: 1, repo_label: "r" }),
          cfg,
          { ...deps, transport: tr }
        );
      }
      assert.equal(readAsks(root).asks[0].status, "open", `${scenario}: ask stays queued`);
      assert.ok(
        buildOverdue(root, { now: NOW }).items.some((i) => i.ask_id === ask.id),
        `${scenario}: ask surfaces overdue`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ── ack semantics — the two events are distinguishable in the read model ────────────────────────────

test("ack semantics — Bot API 200 → only delivery-attempted; callback tap → human-ack", async () => {
  const root = ws();
  try {
    const ask = seedAsk(root);
    const deps = { appendEvent: createDurableNotifyJournal(root), now: minsAgo(25) };
    await sendNotification(
      projectNotification({ ask_id: ask.id, count: 1, repo_label: "aios-workspace" }),
      { enabled: true, token: "t", chatId: "1" },
      { ...deps, transport: FIXTURE.ok }
    );
    // After delivery only: read model shows an attempt, NOT acked.
    let state = foldNotificationState(readJournalSegments(root).events).get(ask.id);
    assert.equal(state.delivery_attempts, 1);
    assert.equal(state.acked, false, "a Bot API 200 is not a human ack");
    assert.ok(buildOverdue(root, { now: NOW }).items.some((i) => i.ask_id === ask.id));

    // The human taps Open (content-free callback) → human-ack, at/after the delivery.
    recordHumanAck(ask.id, { appendEvent: createDurableNotifyJournal(root), now: minsAgo(10) });
    const kinds = readJournalSegments(root).events.map((e) => e.kind);
    assert.deepEqual(kinds, ["delivery-attempted", "human-ack"], "two distinct journal events");
    state = foldNotificationState(readJournalSegments(root).events).get(ask.id);
    assert.equal(state.acked, true, "human-ack after delivery clears the escalation");
    assert.ok(
      !buildOverdue(root, { now: NOW }).items.some((i) => i.ask_id === ask.id),
      "acked → not overdue"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── content-free by construction ───────────────────────────────────────────────────────────────────

test("content-free — a projection built from a secret-laden ask carries no body/sender/evidence", () => {
  // A fixture corpus of asks whose titles/bodies hold exactly what must NEVER reach the phone:
  // message bodies, protected-thread sender names, evidence snippets.
  const CORPUS = [
    {
      id: "ask_1",
      title: "Re: quarterly revenue $4.2M — approve wire?",
      body: "wire the funds to acct 5591",
    },
    {
      id: "ask_2",
      title: "alice@protected.example needs sign-off",
      body: "SECRET_BODY_TEXT payload",
    },
    {
      id: "ask_3",
      title: "Board deck v3 leak risk",
      body: "evidence: 3-log/decision-log.md#d9 confidential",
    },
  ];
  const SECRETS = [
    "quarterly revenue $4.2M",
    "wire the funds",
    "acct 5591",
    "alice@protected.example",
    "SECRET_BODY_TEXT",
    "decision-log",
    "confidential",
  ];
  for (const ask of CORPUS) {
    // The projection is built ONLY from the id + a count + the REPO label — never the ask's content.
    // `projectNotification`'s input type has no body/title/sender field, so this is the only call shape.
    const p = projectNotification({ ask_id: ask.id, count: 2, repo_label: "aios-workspace" });
    const serialized = JSON.stringify(p) + " " + formatNotificationText(p);
    for (const secret of SECRETS) {
      assert.ok(!serialized.includes(secret), `projection/text leaked "${secret}" from ${ask.id}`);
    }
    // Structural guarantee: exactly the four content-free fields, no more.
    assert.deepEqual(Object.keys(p).sort(), ["ask_id", "count", "deep_link", "repo_label"]);
  }
  // The example the spec cites is exactly reproduced from count + label alone.
  assert.equal(
    formatNotificationText(
      projectNotification({ ask_id: "a", count: 1, repo_label: "aios-workspace" })
    ),
    "1 blocking ask · repo aios-workspace · open on your Mac"
  );
});

// ── deep-link format contract ──────────────────────────────────────────────────────────────────────

test("deep-link — matches the format contract regex and resolves to the seeded ask id", () => {
  const askId = "ask_9f3a-42";
  const link = deepLinkForAsk(askId);
  assert.match(link, DEEP_LINK_RE);
  assert.equal(askIdFromDeepLink(link), askId, "the link resolves back to the exact ask id");
  // The projection's deep_link honors the same contract.
  const p = projectNotification({ ask_id: askId, count: 1, repo_label: "r" });
  assert.match(p.deep_link, DEEP_LINK_RE);
  assert.equal(askIdFromDeepLink(p.deep_link), askId);
});

// ── production wire shape (regression: 400 BUTTON_URL_INVALID) ────────────────────────────────────

test("fetchTelegramTransport — deep link rides in the text, NEVER as a button (custom schemes 400)", async () => {
  // Telegram's Bot API rejects inline-keyboard button URLs that aren't http(s)/tg:// with
  // 400 BUTTON_URL_INVALID — an `aios://` button would fail EVERY production send. Capture the
  // real wire body by stubbing global fetch (no network: the stub answers before any socket).
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const transport = fetchTelegramTransport("TEST_TOKEN");
    const p = projectNotification({ ask_id: "ask_wire-1", count: 1, repo_label: "aios-workspace" });
    const res = await transport({
      chat_id: "42",
      text: formatNotificationText(p),
      deep_link: p.deep_link,
    });
    assert.equal(res.ok, true);
    assert.equal(captured.length, 1);
    const body = captured[0].body;
    // No reply_markup at all — a fortiori no button with a non-https URL.
    assert.equal(body.reply_markup, undefined, "must not attach an inline keyboard");
    const buttons = JSON.stringify(body.reply_markup ?? {});
    assert.ok(
      !/"url"\s*:\s*"(?!https:)/.test(buttons),
      "no non-https button URL may reach the wire"
    );
    // The deep link is delivered in the message text instead.
    assert.ok(body.text.includes(p.deep_link), "deep link must ride in the message text");
    assert.ok(body.text.includes("1 blocking ask"), "content-free summary text is preserved");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── overdueView purity + ordering, and the CLI surface ──────────────────────────────────────────────

test("overdueView — acked asks are excluded, resolved asks are excluded, most-overdue first", () => {
  const asks = [
    {
      id: "a",
      title: "t",
      severity: "blocker",
      source: "s",
      status: "open",
      createdAt: iso(minsAgo(60)),
    },
    {
      id: "b",
      title: "t",
      severity: "blocker",
      source: "s",
      status: "open",
      createdAt: iso(minsAgo(30)),
    },
    {
      id: "c",
      title: "t",
      severity: "blocker",
      source: "s",
      status: "resolved",
      createdAt: iso(minsAgo(90)),
    },
    {
      id: "d",
      title: "t",
      severity: "blocker",
      source: "s",
      status: "open",
      createdAt: iso(minsAgo(90)),
    },
  ];
  const events = [
    { seq: 1, kind: "delivery-attempted", correlation_id: "d", ts: iso(minsAgo(60)), payload: {} },
    { seq: 2, kind: "human-ack", correlation_id: "d", ts: iso(minsAgo(2)), payload: {} }, // d acked → excluded
  ];
  const rows = overdueView({ asks, events, now: NOW, escalationWindowMs: WINDOW_MS });
  assert.deepEqual(
    rows.map((r) => r.ask_id),
    ["a", "b"],
    "resolved (c) + acked (d) excluded; a older than b"
  );
});

test("overdueView — an unparseable createdAt is treated as OLDEST (immediately overdue), never hidden", () => {
  // Fail-safe regression: falling back to `now` for a bad timestamp would reset the reference time on
  // EVERY evaluation, so the ask could never age past the window — hidden from recovery forever.
  const asks = [
    {
      id: "bad-ts",
      title: "t",
      severity: "blocker",
      source: "s",
      status: "open",
      createdAt: "not-a-timestamp",
    },
    {
      id: "fresh",
      title: "t",
      severity: "blocker",
      source: "s",
      status: "open",
      createdAt: iso(minsAgo(1)), // inside the window → correctly NOT overdue
    },
  ];
  const rows = overdueView({ asks, events: [], now: NOW, escalationWindowMs: WINDOW_MS });
  assert.deepEqual(
    rows.map((r) => r.ask_id),
    ["bad-ts"],
    "the bad-timestamp ask surfaces immediately; the fresh ask stays out"
  );
  assert.ok(rows[0].overdue_by_ms > 0, "overdue_by_ms is positive (epoch reference)");
  // A later evaluation still surfaces it — the reference time must not track `now`.
  const later = overdueView({
    asks,
    events: [],
    now: new Date(NOW.getTime() + 60 * 60_000),
    escalationWindowMs: WINDOW_MS,
  });
  assert.ok(
    later.some((r) => r.ask_id === "bad-ts"),
    "the ask is never dropped on subsequent evaluations"
  );
  // A parseable delivery attempt supersedes the broken createdAt as the reference time.
  const delivered = overdueView({
    asks: [asks[0]],
    events: [
      {
        seq: 1,
        kind: "delivery-attempted",
        correlation_id: "bad-ts",
        ts: iso(minsAgo(1)),
        payload: {},
      },
    ],
    now: NOW,
    escalationWindowMs: WINDOW_MS,
  });
  assert.deepEqual(delivered, [], "a recent delivery attempt takes over as the reference time");
});

test("`aios inbox --overdue` exits 0, prints one line per overdue ask; --json round-trips deep-equal", async () => {
  const { cmdInbox } = await import(path.join(HERE, "..", "..", "scripts", "inbox.mjs"));
  const root = ws();
  // The CLI uses the real system clock (no injected `now`), so seed relative to real time.
  const realMinsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  try {
    const a1 = appendCreate(root, {
      kind: "approval",
      severity: "blocker",
      title: "Ship it?",
      source: "claude-code",
      tier: "admin",
      createdAt: realMinsAgo(40),
    });
    const a2 = appendCreate(root, {
      kind: "approval",
      severity: "blocker",
      title: "Merge?",
      source: "codex",
      tier: "admin",
      createdAt: realMinsAgo(40),
    });
    appendInboxEvent(root, {
      kind: "delivery-attempted",
      correlation_id: a1.id,
      ts: realMinsAgo(25),
      payload: { lane: "telegram" },
    });
    appendInboxEvent(root, {
      kind: "delivery-attempted",
      correlation_id: a2.id,
      ts: realMinsAgo(22),
      payload: { lane: "telegram" },
    });

    // Capture stdout; a clean return (no throw / no process exit) is the exit-0 contract for cmdInbox.
    const out = [];
    const orig = console.log;
    console.log = (...a) => out.push(a.join(" "));
    try {
      await cmdInbox(root, {}, ["--overdue"]);
      const text = out.join("\n");
      // One line per overdue ask (plus the header line).
      assert.ok(text.includes(a1.id) && text.includes(a2.id), "each overdue ask id is printed");
      const askLines = text.split("\n").filter((l) => l.includes("aios://") || /ask id/.test(l));
      // Header + exactly two ask rows.
      const rows = text.split("\n").filter((l) => l.includes(a1.id) || l.includes(a2.id));
      assert.equal(rows.length, 2, "exactly one line per overdue ask");

      // --json parses and re-serializes deep-equal.
      out.length = 0;
      await cmdInbox(root, {}, ["--overdue", "--json"]);
      const json = out.join("\n");
      const parsed = JSON.parse(json);
      assert.equal(parsed.items.length, 2);
      assert.equal(JSON.stringify(parsed, null, 2), json, "--json output re-serializes deep-equal");
      void askLines;
    } finally {
      console.log = orig;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── I-02 read model stays untouched by the notify lane (no phantom items) ───────────────────────────

test("notify-lane events do not materialize read-model items or change the digest", () => {
  const empty = ws();
  const seeded = ws();
  try {
    // Baseline: an empty journal projects zero items with a stable digest.
    const base = rebuildReadModel(empty);
    assert.equal(base.counts.items, 0);

    // Append ONLY notify-lane events for two asks, then rebuild. They carry no read-model state
    // effect, so no phantom `ItemState` is created and the projected digest equals the empty digest.
    appendInboxEvent(seeded, {
      kind: "delivery-attempted",
      correlation_id: "ask_x",
      ts: iso(minsAgo(25)),
      payload: { lane: "telegram" },
    });
    appendInboxEvent(seeded, {
      kind: "human-ack",
      correlation_id: "ask_x",
      ts: iso(minsAgo(10)),
      payload: { lane: "telegram" },
    });
    appendInboxEvent(seeded, {
      kind: "delivery-attempted",
      correlation_id: "ask_y",
      ts: iso(minsAgo(20)),
      payload: { lane: "telegram" },
    });
    const after = rebuildReadModel(seeded);
    assert.equal(after.counts.items, 0, "notify events must not create phantom read-model items");
    assert.equal(after.digest, base.digest, "notify events must not perturb the read-model digest");
    // The events are still durably present (recovery reads them directly from the journal).
    assert.equal(readJournalSegments(seeded).events.length, 3);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(seeded, { recursive: true, force: true });
  }
});

// ── loadTelegramConfig — disabled unless BOTH token and chat id are present (never logs them) ────────

test("loadTelegramConfig — enabled only with token + chat id; explicit disable wins", () => {
  assert.equal(loadTelegramConfig({}).enabled, false);
  assert.equal(
    loadTelegramConfig({ AIOS_TELEGRAM_BOT_TOKEN: "t" }).enabled,
    false,
    "token alone is not enough"
  );
  const on = loadTelegramConfig({ AIOS_TELEGRAM_BOT_TOKEN: "t", AIOS_TELEGRAM_CHAT_ID: "1" });
  assert.equal(on.enabled, true);
  const off = loadTelegramConfig({
    AIOS_TELEGRAM_BOT_TOKEN: "t",
    AIOS_TELEGRAM_CHAT_ID: "1",
    AIOS_TELEGRAM_DISABLED: "1",
  });
  assert.equal(off.enabled, false, "explicit disable overrides");
});

// ── renderOverdueText / buildOverdueView shape (pure) ───────────────────────────────────────────────

test("renderOverdueText / buildOverdueView — stable machine surface + one row per item", () => {
  const asks = [
    {
      id: "a",
      title: "t",
      severity: "blocker",
      source: "claude-code",
      status: "open",
      createdAt: iso(minsAgo(60)),
    },
  ];
  const view = buildOverdueView({ asks, events: [], now: NOW, escalationWindowMs: WINDOW_MS });
  assert.deepEqual(Object.keys(view).sort(), ["escalation_window_ms", "generated_at", "items"]);
  assert.equal(view.items.length, 1);
  const txt = renderOverdueText(view);
  assert.ok(txt.includes("a"), "renders the overdue ask id");
  // An empty view renders a header + an explicit (none) line, still exit-0-safe.
  const empty = renderOverdueText(buildOverdueView({ asks: [], events: [], now: NOW }));
  assert.ok(/none/.test(empty));
});
