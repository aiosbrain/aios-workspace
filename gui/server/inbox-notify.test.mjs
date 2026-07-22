import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as realLoop from "../../dist/operator-loop/index.js";
import {
  DEFAULT_FAILURE_RETRY_MS,
  createTelegramNotifier,
  isBlockingInboxItem,
} from "./inbox-notify.mjs";
import {
  DEFAULT_NOTIFY_LOCK_STALE_MS,
  TELEGRAM_NOTIFY_LOCK_BASENAME,
  acquireTelegramNotifyLock,
} from "./inbox-notify-lock.mjs";

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "inbox-notify-"));
}

function askItem(id, overrides = {}) {
  return {
    id,
    origin: "agent-event",
    source: "claude-code",
    account: null,
    bucket: "needs-you",
    protected: true,
    why: "open blocker",
    attention_state: "surfaced",
    action_state: "none",
    ts: "2026-07-21T00:00:00.000Z",
    ask: {
      id,
      status: "open",
      createdAt: "2026-07-21T00:00:00.000Z",
      title: "SECRET ask title",
      body: "SECRET ask body",
    },
    ...overrides,
  };
}

function loopFor(items) {
  return {
    ...realLoop,
    buildInbox: () => ({ items, ranker_version: "test", generated_at: new Date().toISOString() }),
  };
}

const configuredEnv = {
  AIOS_TELEGRAM_BOT_TOKEN: "fixture-bot-value",
  AIOS_TELEGRAM_CHAT_ID: "chat-secret-sentinel",
};

test("blocking predicate matches only open actionable agent asks", () => {
  assert.equal(isBlockingInboxItem(askItem("a")), true);
  assert.equal(isBlockingInboxItem(askItem("b", { protected: false, bucket: "fyi" })), false);
  assert.equal(isBlockingInboxItem(askItem("c", { origin: "thread-state" })), false);
  assert.equal(isBlockingInboxItem(askItem("d", { ask: { id: "d", status: "resolved" } })), false);
});

test("eligible ask sends content-free text once and dedupes across notifier restart", async () => {
  const repo = workspace();
  try {
    const calls = [];
    const transport = async (request) => {
      calls.push(request);
      return { ok: true, status: 200 };
    };
    const loop = loopFor([askItem("ask-one")]);
    const first = createTelegramNotifier({
      repo,
      loadLoop: async () => loop,
      env: configuredEnv,
      transport,
    });
    await first.tick();
    await first.tick();
    const restarted = createTelegramNotifier({
      repo,
      loadLoop: async () => loop,
      env: configuredEnv,
      transport,
    });
    await restarted.tick();

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /1 blocking ask/);
    assert.equal(calls[0].chat_id, "chat-secret-sentinel", "transport receives its destination");
    const serialized = JSON.stringify(calls[0]);
    for (const secret of ["SECRET ask title", "SECRET ask body", "fixture-bot-value"]) {
      assert.equal(serialized.includes(secret), false);
    }
    for (const secret of [
      "SECRET ask title",
      "SECRET ask body",
      "fixture-bot-value",
      "chat-secret-sentinel",
    ]) {
      assert.equal(JSON.stringify(first.snapshot()).includes(secret), false);
      assert.equal(calls[0].text.includes(secret), false);
    }
    const events = realLoop.readJournalSegments(repo).events;
    assert.equal(events.filter((event) => event.kind === "delivery-attempted").length, 1);
    assert.equal(events[0].correlation_id, "ask-one");
    assert.equal(first.snapshot().status, "delivery_ok");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("two notifier processes racing on one repo make one transport call", async () => {
  const repo = workspace();
  try {
    let enter;
    let release;
    const entered = new Promise((resolve) => (enter = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    let calls = 0;
    const transport = async () => {
      calls++;
      enter();
      await gate;
      return { ok: true, status: 200 };
    };
    const loop = loopFor([askItem("ask-race")]);
    const a = createTelegramNotifier({
      repo,
      loadLoop: async () => loop,
      env: configuredEnv,
      transport,
    });
    const b = createTelegramNotifier({
      repo,
      loadLoop: async () => loop,
      env: configuredEnv,
      transport,
    });

    const first = a.tick();
    await entered;
    const second = b.tick();
    await second;
    release();
    await first;

    assert.equal(calls, 1);
    assert.equal(
      realLoop
        .readJournalSegments(repo)
        .events.filter((event) => event.kind === "delivery-attempted").length,
      1
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("disabled and non-blocking queues are silent", async () => {
  const repo = workspace();
  try {
    let calls = 0;
    const transport = async () => {
      calls++;
      return { ok: true, status: 200 };
    };
    const disabled = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("disabled")]),
      env: { ...configuredEnv, AIOS_TELEGRAM_DISABLED: "1" },
      transport,
    });
    await disabled.tick();
    assert.equal(disabled.snapshot().status, "disabled");

    const fyi = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("fyi", { protected: false, bucket: "fyi" })]),
      env: configuredEnv,
      transport,
    });
    await fyi.tick();
    assert.equal(calls, 0);
    assert.equal(realLoop.readJournalSegments(repo).events.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("candidate is rechecked immediately before transport", async () => {
  const repo = workspace();
  try {
    let reads = 0;
    let calls = 0;
    const open = askItem("ask-closed-before-send");
    const closed = askItem("ask-closed-before-send", {
      ask: { id: "ask-closed-before-send", status: "archived" },
    });
    const loop = {
      ...realLoop,
      buildInbox: () => ({
        items: reads++ === 0 ? [open] : [closed],
        ranker_version: "test",
        generated_at: new Date().toISOString(),
      }),
    };
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loop,
      env: configuredEnv,
      transport: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
    });

    await notifier.tick();
    assert.equal(calls, 0);
    assert.equal(realLoop.readJournalSegments(repo).events.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("per-tick send cap drains remaining asks on the next tick", async () => {
  const repo = workspace();
  try {
    const calls = [];
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () =>
        loopFor([askItem("ask-1"), askItem("ask-2"), askItem("ask-3"), askItem("ask-4")]),
      env: configuredEnv,
      maxSendsPerTick: 2,
      transport: async (request) => {
        calls.push(request.deep_link);
        return { ok: true, status: 200 };
      },
    });
    await notifier.tick();
    assert.equal(calls.length, 2);
    await notifier.tick();
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls).size, 4);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("failed send journals nothing, uses retry backoff, and exposes a generic error", async () => {
  const repo = workspace();
  try {
    let current = new Date("2026-07-21T00:00:00.000Z");
    let calls = 0;
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("ask-fail")]),
      env: configuredEnv,
      now: () => new Date(current),
      transport: async () => {
        calls++;
        return { ok: false, status: 401, description: "fixture-bot-value" };
      },
    });
    await notifier.tick();
    await notifier.tick();
    assert.equal(calls, 1);
    assert.equal(realLoop.readJournalSegments(repo).events.length, 0);
    assert.deepEqual(notifier.snapshot(), {
      status: "failed",
      last_attempt_at: "2026-07-21T00:00:00.000Z",
      last_delivery_at: null,
      last_error: "telegram delivery failed",
    });
    current = new Date(current.getTime() + DEFAULT_FAILURE_RETRY_MS + 1);
    await notifier.tick();
    assert.equal(calls, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("mixed send outcomes report a degraded lane without hiding the successful delivery", async () => {
  const repo = workspace();
  try {
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("ask-a"), askItem("ask-b")]),
      env: configuredEnv,
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      transport: async (request) => ({
        ok: request.deep_link.endsWith("ask-a"),
        status: request.deep_link.endsWith("ask-a") ? 200 : 503,
      }),
    });

    await notifier.tick();
    assert.deepEqual(notifier.snapshot(), {
      status: "degraded",
      last_attempt_at: "2026-07-21T00:00:00.000Z",
      last_delivery_at: "2026-07-21T00:00:00.000Z",
      last_error: "some telegram deliveries failed",
    });
    assert.equal(
      realLoop
        .readJournalSegments(repo)
        .events.filter((event) => event.kind === "delivery-attempted").length,
      1
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("missing compiled loop degrades to unavailable without rejecting", async () => {
  const repo = workspace();
  try {
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => null,
      env: configuredEnv,
    });
    await assert.doesNotReject(() => notifier.tick());
    assert.equal(notifier.snapshot().status, "unavailable");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stop waits for an in-flight tick", async () => {
  const repo = workspace();
  try {
    let enter;
    let release;
    const entered = new Promise((resolve) => (enter = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("ask-stop")]),
      env: configuredEnv,
      transport: async () => {
        enter();
        await gate;
        return { ok: true, status: 200 };
      },
      schedule: () => ({ unref() {} }),
      cancelSchedule: () => {},
    });
    notifier.start();
    await entered;
    let stopped = false;
    const stopping = notifier.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lock fails closed for a live owner, reclaims a dead owner, and releases by token", () => {
  const repo = workspace();
  try {
    const first = acquireTelegramNotifyLock(repo, {
      pid: 41_001,
      token: "first",
      probe: () => {},
    });
    assert.equal(typeof first, "function");
    const busy = acquireTelegramNotifyLock(repo, {
      pid: 41_002,
      token: "busy",
      probe: () => {},
    });
    assert.equal(busy, null);

    const second = acquireTelegramNotifyLock(repo, {
      pid: 41_002,
      token: "second",
      probe: () => {
        const error = new Error("dead");
        error.code = "ESRCH";
        throw error;
      },
    });
    assert.equal(typeof second, "function");
    first();
    assert.equal(existsSync(path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME)), true);
    second();
    assert.equal(existsSync(path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The GUI notifier starts automatically with the server. `loadTelegramConfig` also accepts bare
// TELEGRAM_* names, which in a shared environment routinely belong to a DIFFERENT bot (Hermes is
// the workspace's Telegram gateway) — honouring them would push AIOS ask alerts through someone
// else's bot the first time `npm run gui` ran.
test("unscoped TELEGRAM_* credentials never activate the GUI lane, and the status says why", async () => {
  const repo = workspace();
  try {
    let calls = 0;
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("ask-unscoped")]),
      env: { TELEGRAM_BOT_TOKEN: "someone-elses-bot", TELEGRAM_CHAT_ID: "someone-elses-chat" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      transport: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
    });

    await notifier.tick();
    assert.equal(calls, 0, "an unscoped token must never reach the wire");
    assert.equal(realLoop.readJournalSegments(repo).events.length, 0);
    const snapshot = notifier.snapshot();
    assert.equal(snapshot.status, "disabled");
    assert.match(snapshot.last_error, /AIOS_TELEGRAM_BOT_TOKEN/);
    // Content-free: the guidance names env vars, never the credentials themselves.
    assert.doesNotMatch(snapshot.last_error, /someone-elses/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repeated failures back off exponentially instead of hot-looping the Bot API", async () => {
  const repo = workspace();
  try {
    let current = new Date("2026-07-21T00:00:00.000Z");
    let calls = 0;
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor([askItem("ask-backoff")]),
      env: configuredEnv,
      now: () => new Date(current),
      transport: async () => {
        calls++;
        return { ok: false, status: 401 };
      },
    });

    await notifier.tick();
    assert.equal(calls, 1);

    // First retry opens after 1x the base window.
    current = new Date(current.getTime() + DEFAULT_FAILURE_RETRY_MS + 1);
    await notifier.tick();
    assert.equal(calls, 2);

    // The second retry must NOT open after another 1x — the window has doubled.
    current = new Date(current.getTime() + DEFAULT_FAILURE_RETRY_MS + 1);
    await notifier.tick();
    assert.equal(calls, 2, "backoff did not grow after the second consecutive failure");

    current = new Date(current.getTime() + DEFAULT_FAILURE_RETRY_MS + 1);
    await notifier.tick();
    assert.equal(calls, 3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A latched failure reports a broken lane forever and trains the operator to ignore the one
// indicator that says outbound alerting is down.
test("lane status clears once the failed ask is gone and nothing is outstanding", async () => {
  const repo = workspace();
  try {
    let items = [askItem("ask-transient")];
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => loopFor(items),
      env: configuredEnv,
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      transport: async () => ({ ok: false, status: 503 }),
    });

    await notifier.tick();
    assert.equal(notifier.snapshot().status, "failed");

    // The operator answers the ask: it stops being a blocking item, so nothing is waiting to go out.
    items = [];
    await notifier.tick();
    const snapshot = notifier.snapshot();
    assert.equal(snapshot.status, "configured");
    assert.equal(snapshot.last_error, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Liveness alone is not proof of ownership: after an unclean exit the OS may recycle the recorded
// pid for an unrelated process. A probe-only policy would then hold the lock forever, silently
// killing every alert and every acknowledgment until a human deleted the file.
test("a live-pid lock is reclaimed once it outlives any legitimate hold", () => {
  const repo = workspace();
  try {
    const held = acquireTelegramNotifyLock(repo, {
      pid: 42_001,
      token: "incumbent",
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });
    assert.equal(typeof held, "function");

    // Same live pid, inside the window → the incumbent still wins.
    assert.equal(
      acquireTelegramNotifyLock(repo, {
        pid: 42_002,
        token: "early",
        probe: () => {},
        now: () => new Date("2026-07-21T00:01:00.000Z"),
      }),
      null
    );

    // Same live pid, past the stale threshold → reclaimed rather than deadlocked forever.
    const reclaimed = acquireTelegramNotifyLock(repo, {
      pid: 42_002,
      token: "reclaimer",
      probe: () => {},
      now: () => new Date("2026-07-21T00:30:00.000Z"),
    });
    assert.equal(typeof reclaimed, "function");

    // The preempted owner must not unlink its successor's lock.
    held();
    assert.equal(existsSync(path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME)), true);
    reclaimed();
    assert.equal(existsSync(path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME)), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A future-dated lock must not become permanently unbreakable, but neither may it be stolen from a
// healthy holder. A forward jump that was later reset and a BACKWARD correction are indistinguishable
// from the file's timestamps alone, so the two cases are separated by continuous observation.
//
// mtime is set explicitly rather than raced against the wall clock: `mtimeMs` has sub-millisecond
// precision while `Date.now()` truncates to whole ms.
test("a future acquired_at falls back to mtime for aging", () => {
  const repo = workspace();
  const lockFile = path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME);
  try {
    const held = acquireTelegramNotifyLock(repo, {
      pid: 43_001,
      token: "from-the-future",
      now: () => new Date(Date.now() + 365 * 24 * 60 * 60_000),
    });
    assert.equal(typeof held, "function");

    // acquired_at is disbelieved; mtime is genuinely fresh, so a live incumbent keeps the lock.
    assert.equal(
      acquireTelegramNotifyLock(repo, { pid: 43_002, token: "early", probe: () => {} }),
      null
    );

    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockFile, old, old);
    const reclaimed = acquireTelegramNotifyLock(repo, {
      pid: 43_002,
      token: "reclaimer",
      probe: () => {},
    });
    assert.equal(typeof reclaimed, "function", "stale mtime must be reclaimable");
    reclaimed();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Regression: treating an unageable lock as instantly reclaimable let a BACKWARD clock correction —
// which makes a healthy holder's stamps look future-dated — steal the lock mid-send, producing two
// concurrent notifiers and duplicate alerts.
test("both timestamps future: not stolen on sight, reclaimable only after sustained observation", () => {
  const repo = workspace();
  const lockFile = path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME);
  const future = new Date(Date.now() + 365 * 24 * 60 * 60_000);
  const T0 = new Date("2026-07-21T00:00:00.000Z");
  try {
    const held = acquireTelegramNotifyLock(repo, {
      pid: 44_001,
      token: "holder",
      now: () => future,
    });
    assert.equal(typeof held, "function");
    utimesSync(lockFile, future, future); // neither timestamp is now believable

    // First sighting: a live holder must NOT be preempted, however unbelievable its stamps.
    assert.equal(
      acquireTelegramNotifyLock(repo, {
        pid: 44_002,
        token: "racer",
        probe: () => {},
        now: () => T0,
      }),
      null,
      "an unageable lock must not be stolen from a live holder on first sight"
    );

    // Still inside the window — a transient clock anomaly resolves long before this elapses.
    assert.equal(
      acquireTelegramNotifyLock(repo, {
        pid: 44_002,
        token: "racer",
        probe: () => {},
        now: () => new Date(T0.getTime() + 60_000),
      }),
      null
    );

    // Sustained past the window: a genuinely corrupt stamp must not wedge the lane forever.
    const rescued = acquireTelegramNotifyLock(repo, {
      pid: 44_002,
      token: "rescuer",
      probe: () => {},
      now: () => new Date(T0.getTime() + DEFAULT_NOTIFY_LOCK_STALE_MS + 1),
    });
    assert.equal(typeof rescued, "function", "an unageable lock must eventually free the lane");
    rescued();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// EPERM means the pid exists but belongs to another user — a holder, not a corpse. It must still be
// subject to the age rule, or a hung process under another account wedges the lane permanently.
test("an EPERM owner is treated as alive but is still aged out when stale", () => {
  const fresh = workspace();
  const stale = workspace();
  const eperm = () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  };
  try {
    // Fresh hold by a foreign-user process: legitimately keeps the lock.
    assert.equal(
      typeof acquireTelegramNotifyLock(fresh, { pid: 45_001, token: "other" }),
      "function"
    );
    assert.equal(
      acquireTelegramNotifyLock(fresh, { pid: 45_002, token: "early", probe: eperm }),
      null,
      "a live foreign-user holder must keep a fresh lock"
    );

    // Same situation an hour later: the foreign process is hung, and EPERM must not exempt it from
    // aging. (Aging prefers the record's own `acquired_at`, so that is what has to be old.)
    assert.equal(
      typeof acquireTelegramNotifyLock(stale, {
        pid: 45_001,
        token: "other",
        now: () => new Date(Date.now() - 60 * 60_000),
      }),
      "function"
    );
    const reclaimed = acquireTelegramNotifyLock(stale, {
      pid: 45_002,
      token: "reclaimer",
      probe: eperm,
    });
    assert.equal(
      typeof reclaimed,
      "function",
      "a hung foreign-user holder must not wedge the lane"
    );
    reclaimed();
    assert.equal(existsSync(path.join(stale, TELEGRAM_NOTIFY_LOCK_BASENAME)), false);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

// The ack path was made non-blocking, but the SEND path appends the same `delivery-attempted`
// record through the same shared journal lock — and does it while holding the cross-process notify
// coordinator. Left on the journal's default backoff (`sleepSync`/Atomics.wait) a contended journal
// would park the whole server thread, stalling HTTP, WebSocket agent streams and ack retries alike.
test("send path never parks the thread on a contended journal", async () => {
  const repo = workspace();
  try {
    let held = true;
    let yields = 0;
    let sends = 0;
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => ({
        ...loopFor([askItem("ask-journal")]),
        inboxJournalLockHeld: () => held,
      }),
      env: configuredEnv,
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      // Every wait is an async yield, never a synchronous park.
      delay: async () => {
        yields++;
        if (yields >= 3) held = false; // the other writer finishes mid-wait
      },
      transport: async () => {
        sends++;
        return { ok: true, status: 200 };
      },
    });

    await notifier.tick();
    assert.ok(yields > 0, "a contended journal must be waited on, not ignored");
    assert.equal(sends, 1, "the send proceeds once the journal frees up");
    assert.equal(
      realLoop.readJournalSegments(repo).events.filter((e) => e.kind === "delivery-attempted")
        .length,
      1,
      "the delivery record must be durably journalled"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// If the journal is STILL contended after the wait budget, sending anyway would mean the Bot API
// accepted a message we cannot record — and the ask would be alerted again later. Defer instead,
// and prove the deferral is BACKED OFF rather than hot-looping the next tick.
test("a journal contended past the wait budget defers the send rather than duplicating it", async () => {
  const repo = workspace();
  try {
    let sends = 0;
    let held = true;
    let current = new Date("2026-07-21T00:00:00.000Z");
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () => ({
        ...loopFor([askItem("ask-stuck")]),
        inboxJournalLockHeld: () => held,
      }),
      env: configuredEnv,
      now: () => new Date(current),
      delay: async () => {},
      transport: async () => {
        sends++;
        return { ok: true, status: 200 };
      },
    });

    await notifier.tick();
    assert.equal(sends, 0, "must not send a message it cannot record");
    assert.equal(realLoop.readJournalSegments(repo).events.length, 0);
    // The lane must not read as healthy while alerts are silently not going out.
    const snapshot = notifier.snapshot();
    assert.equal(snapshot.status, "degraded");
    assert.match(snapshot.last_error, /journal busy/);
    // Content-free: no ask id, title, body or credential in the operator-facing error.
    assert.doesNotMatch(snapshot.last_error, /ask-stuck|SECRET|chat-secret-sentinel/);

    // The journal frees up, but the ask was deferred WITH backoff — an immediate tick must not fire.
    held = false;
    await notifier.tick();
    assert.equal(sends, 0, "deferral must schedule a backoff, not hot-loop the next tick");

    // Past the backoff window it sends.
    current = new Date(current.getTime() + DEFAULT_FAILURE_RETRY_MS + 1);
    await notifier.tick();
    assert.equal(sends, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
