import test from "node:test";
import assert from "node:assert/strict";
import { createInboxRefresher } from "./inbox-refresh.mjs";

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
  assert.equal(runs, 0, "the injected run begins on the promise microtask");
  assert.equal(refresher.snapshot().last_success_at, null);
  release();
  await first;

  assert.equal(runs, 1);
  assert.equal(refresher.snapshot().status, "ready");
  assert.equal(refresher.snapshot().last_success_at, "2026-07-16T01:00:04.000Z");
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
