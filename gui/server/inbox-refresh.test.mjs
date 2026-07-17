import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  TRUSTED_GOG_ADAPTER,
  connectorEnvironment,
  createInboxRefresher,
  installInboxRefreshShutdown,
  runTrustedGogAdapter,
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
  await new Promise((resolve) => setTimeout(resolve, 7));
  assert.equal(refresher.refresh(), first, "in-flight guard survives SIGTERM");
  assert.deepEqual(child.signals, ["SIGTERM"]);
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
  installInboxRefreshShutdown({ refresher, server, webSocketServer, processRef });
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
  assert.equal(state.error, "Gmail and Calendar refresh failed.");
  assert.doesNotMatch(JSON.stringify(state), /secret-token|message-content/);
  assert.equal(state.sources.telegram, "outbound_only");
});
