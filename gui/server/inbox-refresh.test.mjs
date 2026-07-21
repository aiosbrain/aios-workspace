import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  TRUSTED_GOG_ADAPTER,
  TRUSTED_SLACK_ADAPTER,
  connectorEnvironment,
  createInboxRefresher,
  installInboxRefreshShutdown,
  runTrustedGogAdapter,
  runTrustedSlackAdapter,
  slackConnectorEnvironment,
} from "./inbox-refresh.mjs";

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  signals = [];
  closeOnKill = true;

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGKILL" && this.closeOnKill) setImmediate(() => this.emit("close", null));
    return true;
  }
}

test("connector execution is toolkit-owned and receives only an allowlisted environment", async () => {
  let invocation;
  const child = new FakeChild();
  const result = runTrustedGogAdapter("/tmp/untrusted-selected-repo", {
    env: {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      GOG_ACCOUNT: "owner@example.test",
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
    },
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      setImmediate(() => child.emit("close", 0));
      return child;
    },
    isEnabled: () => true,
  });

  assert.equal((await result).kind, "ready");
  assert.equal(invocation.args[0], TRUSTED_GOG_ADAPTER);
  assert.equal(invocation.args[1], "--repo");
  assert.equal(invocation.args[2], "/tmp/untrusted-selected-repo");
  assert.doesNotMatch(invocation.args[0], /untrusted-selected-repo/);
  assert.equal(invocation.options.env.HOME, "/safe/home");
  assert.equal(invocation.options.env.GOG_ACCOUNT, "owner@example.test");
  assert.notEqual(invocation.options.env.PATH, "/safe/bin");
  assert.match(invocation.options.env.PATH, /\/usr\/bin/);
  assert.equal("AWS_SECRET_ACCESS_KEY" in invocation.options.env, false);
  assert.equal("NODE_OPTIONS" in invocation.options.env, false);
  assert.equal(invocation.options.detached, true);
  const minimal = connectorEnvironment({ SECRET: "no", PATH: "/untrusted/bin" });
  assert.deepEqual(Object.keys(minimal), ["PATH"]);
  assert.notEqual(minimal.PATH, "/untrusted/bin");
});

test("a workspace without the installation marker cannot trigger connector execution", async () => {
  let spawned = false;
  const result = await runTrustedGogAdapter("/definitely/no/installed/descriptor", {
    spawnProcess() {
      spawned = true;
      return new FakeChild();
    },
  });
  assert.equal(result.kind, "unavailable");
  assert.equal(spawned, false);
});

test("Slack refresh runs only the toolkit adapter with a Slack-specific environment", async () => {
  let invocation;
  const child = new FakeChild();
  const result = runTrustedSlackAdapter("/tmp/untrusted-selected-repo", {
    env: {
      HOME: "/safe/home",
      SLACK_USER_TOKEN: "fixture-token",
      AIOS_BRAIN_URL: "https://brain.example.test",
      AIOS_API_KEY: "fixture-brain-key",
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
    },
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      setImmediate(() => child.emit("close", 0));
      return child;
    },
    isEnabled: () => true,
  });

  assert.deepEqual(await result, { kind: "ready", slack: "ready" });
  assert.equal(invocation.args[0], TRUSTED_SLACK_ADAPTER);
  assert.equal(invocation.args[2], "/tmp/untrusted-selected-repo");
  assert.equal(invocation.options.env.SLACK_USER_TOKEN, "fixture-token");
  assert.equal(invocation.options.env.AIOS_API_KEY, "fixture-brain-key");
  assert.equal("AWS_SECRET_ACCESS_KEY" in invocation.options.env, false);
  assert.equal("NODE_OPTIONS" in invocation.options.env, false);
  const minimal = slackConnectorEnvironment({ SECRET: "no", PATH: "/untrusted/bin" });
  assert.deepEqual(Object.keys(minimal), ["PATH"]);
});

test("inbox refresh is non-overlapping and freshness advances only after a successful pull", async () => {
  let release;
  let runs = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const times = [new Date("2026-07-16T01:00:00Z"), new Date("2026-07-16T01:00:04Z")];
  const refresher = createInboxRefresher({
    repo: "/tmp/workspace",
    now: () => times.shift() ?? new Date("2026-07-16T01:00:04Z"),
    run: async () => {
      runs += 1;
      await pending;
      return { kind: "ready", gmail: "ready", calendar: "ready" };
    },
  });

  const first = refresher.refresh();
  const second = refresher.refresh();
  assert.equal(first, second);
  assert.equal(refresher.snapshot().last_success_at, null);
  release();
  await first;

  assert.equal(runs, 1);
  assert.equal(refresher.snapshot().status, "ready");
  assert.equal(refresher.snapshot().last_success_at, "2026-07-16T01:00:04.000Z");
});

test("timeout waits through TERM to KILL and cannot overlap a SIGTERM-ignoring child", async () => {
  const child = new FakeChild();
  let runs = 0;
  const refresher = createInboxRefresher({
    repo: "/tmp/workspace",
    run: ({ signal }) => {
      runs += 1;
      return runTrustedGogAdapter("/tmp/workspace", {
        signal,
        timeoutMs: 5,
        termGraceMs: 5,
        spawnProcess: () => child,
        isEnabled: () => true,
      });
    },
  });

  const first = refresher.refresh();
  // Poll (bounded) instead of a fixed sleep: on a loaded CI runner a 5ms timer can lag well past a
  // fixed wait, making the SIGTERM assertion flaky. The invariant is order, not wall time.
  const deadline = Date.now() + 5_000;
  let settled = false;
  void first.then(() => (settled = true));
  while (child.signals.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(child.signals[0], "SIGTERM", "TERM is sent first");
  // Only probe the in-flight guard while the pull is genuinely still in flight (a loaded runner may
  // have already walked TERM→KILL→close by now); `runs === 1` below still proves no overlap.
  if (!settled) {
    assert.equal(refresher.refresh(), first, "in-flight guard survives SIGTERM");
  }
  await first;
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(runs, 1);
  assert.equal(refresher.snapshot().status, "failed");
});

test("timeout signals the detached connector process group, including gog descendants", async () => {
  const child = new FakeChild();
  child.pid = 4321;
  child.closeOnKill = false;
  const groupSignals = [];
  const result = runTrustedGogAdapter("/tmp/workspace", {
    timeoutMs: 5,
    termGraceMs: 5,
    platform: "darwin",
    isEnabled: () => true,
    spawnProcess: () => child,
    killProcess(pid, signal) {
      groupSignals.push([pid, signal]);
      if (signal === "SIGKILL") setImmediate(() => child.emit("close", null));
    },
  });
  assert.equal((await result).kind, "failed");
  assert.deepEqual(groupSignals, [
    [-4321, "SIGTERM"],
    [-4321, "SIGKILL"],
  ]);
  assert.deepEqual(child.signals, []);
});

test("stop aborts and awaits the active pull; shutdown closes the server afterwards", async () => {
  let closed = false;
  let socketTerminated = false;
  const child = new FakeChild();
  const processRef = new EventEmitter();
  const refresher = createInboxRefresher({
    repo: "/tmp/workspace",
    run: ({ signal }) =>
      runTrustedGogAdapter("/tmp/workspace", {
        signal,
        timeoutMs: 60_000,
        termGraceMs: 5,
        spawnProcess: () => child,
        isEnabled: () => true,
      }),
  });
  const server = {
    close() {
      assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
      closed = true;
    },
  };
  const webSocketServer = {
    clients: new Set([
      {
        terminate() {
          socketTerminated = true;
        },
      },
    ]),
    close() {},
  };
  const pull = refresher.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  installInboxRefreshShutdown({ stoppables: [refresher], server, webSocketServer, processRef });
  processRef.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(closed, false);
  await pull;
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(closed, true);
  assert.equal(socketTerminated, true);
});

test("failed refresh stays visible without leaking connector diagnostics", async () => {
  const refresher = createInboxRefresher({
    repo: "/tmp/workspace",
    run: async () => {
      throw new Error("secret-token-and-message-content");
    },
  });
  await refresher.refresh();
  const state = refresher.snapshot();
  assert.equal(state.status, "failed");
  assert.equal(state.last_success_at, null);
  assert.equal(state.error, "Inbox refresh failed.");
  assert.doesNotMatch(JSON.stringify(state), /secret-token|message-content/);
  assert.equal(state.sources.telegram, "outbound_only");
  assert.equal(state.sources.slack, "failed");
});

test("total ingestion failure (Gmail AND Calendar) reports failed and never advances freshness", async () => {
  const child = new FakeChild();
  const result = runTrustedGogAdapter("/tmp/workspace", {
    spawnProcess() {
      setImmediate(() => {
        child.stderr.emit("data", "gmail fetch failed: 401\ncalendar fetch failed: 401\n");
        child.emit("close", 0);
      });
      return child;
    },
    isEnabled: () => true,
  });
  const adapterResult = await result;
  assert.equal(adapterResult.kind, "failed", "both sources down is a FAILURE, not degraded");

  const refresher = createInboxRefresher({
    repo: "/tmp/workspace",
    run: async () => adapterResult,
  });
  await refresher.refresh();
  const state = refresher.snapshot();
  assert.equal(state.status, "failed");
  assert.equal(state.sources.gmail, "failed");
  assert.equal(state.sources.calendar, "failed");
  assert.equal(state.last_success_at, null, "no source succeeded — freshness must not advance");
});

test("partial failure stays degraded and advances freshness (one source really succeeded)", async () => {
  const child = new FakeChild();
  const result = runTrustedGogAdapter("/tmp/workspace", {
    spawnProcess() {
      setImmediate(() => {
        child.stderr.emit("data", "gmail fetch failed: 401\n");
        child.emit("close", 0);
      });
      return child;
    },
    isEnabled: () => true,
  });
  const adapterResult = await result;
  assert.equal(adapterResult.kind, "degraded");
  assert.equal(adapterResult.gmail, "failed");
  assert.equal(adapterResult.calendar, "ready");

  const refresher = createInboxRefresher({
    repo: "/tmp/workspace",
    now: () => new Date("2026-07-17T02:00:00Z"),
    run: async () => adapterResult,
  });
  await refresher.refresh();
  const state = refresher.snapshot();
  assert.equal(state.status, "degraded");
  assert.equal(state.last_success_at, "2026-07-17T02:00:00.000Z");
  assert.equal(state.error, "Some inbox sources could not refresh.");
});
