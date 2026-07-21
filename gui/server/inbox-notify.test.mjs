import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as realLoop from "../../dist/operator-loop/index.js";
import {
  DEFAULT_FAILURE_RETRY_MS,
  createTelegramNotifier,
  isBlockingInboxItem,
} from "./inbox-notify.mjs";
import {
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
  assert.equal(
    isBlockingInboxItem(askItem("d", { ask: { id: "d", status: "resolved" } })),
    false
  );
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
      loadLoop: async () =>
        loopFor([askItem("fyi", { protected: false, bucket: "fyi" })]),
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

test("per-tick send cap drains remaining asks on the next tick", async () => {
  const repo = workspace();
  try {
    const calls = [];
    const notifier = createTelegramNotifier({
      repo,
      loadLoop: async () =>
        loopFor([
          askItem("ask-1"),
          askItem("ask-2"),
          askItem("ask-3"),
          askItem("ask-4"),
        ]),
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
