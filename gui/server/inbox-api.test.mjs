import test from "node:test";
import assert from "node:assert/strict";
import { buildNotifyView, isActiveInboxItem, projectActiveInboxView } from "./inbox-api.mjs";

const ask = (status, attention_state = "surfaced", bucket = "needs-you") => ({
  origin: "agent-event",
  bucket,
  attention_state,
  ask: { status },
});

test("active inbox excludes resolved, archived, closed, and done asks", () => {
  assert.equal(isActiveInboxItem(ask("open")), true);
  assert.equal(isActiveInboxItem(ask("resolved")), false);
  assert.equal(isActiveInboxItem(ask("open", "resolved")), false);
  assert.equal(isActiveInboxItem(ask("open", "archived")), false);
  assert.equal(isActiveInboxItem(ask("open", "surfaced", "done")), false);
});

test("active inbox retains non-done communication threads", () => {
  assert.equal(isActiveInboxItem({ origin: "thread-state", bucket: "thread" }), true);
  assert.equal(isActiveInboxItem({ origin: "thread-state", bucket: "done" }), false);
  assert.equal(
    isActiveInboxItem({ origin: "agent-event", bucket: "needs-you", health: { state: "failed" } }),
    true,
    "non-ask health/action rows remain visible"
  );
});

test("public inbox exposes ingestion freshness and never legacy occurrence staleness", () => {
  const freshness = { status: "ready", last_success_at: "2026-07-16T01:00:00.000Z" };
  const projected = projectActiveInboxView(
    {
      items: [ask("open")],
      ranker_version: "ranker-v1",
      generated_at: "2026-07-16T01:00:01.000Z",
      staleness: { stale: false, newest_observation_ts: "2099-01-01T00:00:00.000Z", age_ms: -1 },
    },
    { refresh: freshness }
  );
  assert.equal("staleness" in projected, false);
  assert.equal(JSON.stringify(projected).includes("2099"), false);
  assert.equal(projected.freshness, freshness);
});

test("notify projection failure is isolated from the ranked queue", () => {
  const notify = buildNotifyView(
    {
      readJournalSegments() {
        throw new Error("SECRET damaged journal body");
      },
      foldNotificationState() {
        throw new Error("unreachable");
      },
      buildOverdue() {
        throw new Error("unreachable");
      },
    },
    "/tmp/fixture",
    new Set(["ask-1"]),
    null
  );
  assert.equal(notify, null);
});

test("notify projection transforms and filters the overdue items array", () => {
  const notify = buildNotifyView(
    {
      readJournalSegments() {
        return { events: [] };
      },
      foldNotificationState() {
        return new Map();
      },
      buildOverdue() {
        return {
          escalation_window_ms: 900_000,
          items: [
            {
              ask_id: "ask-1",
              overdue_by_ms: 60_000,
              delivery_attempts: 0,
              last_delivery_at: null,
            },
            {
              ask_id: "not-visible",
              overdue_by_ms: 120_000,
              delivery_attempts: 1,
              last_delivery_at: "2026-07-21T00:00:00.000Z",
            },
          ],
        };
      },
    },
    "/tmp/fixture",
    new Set(["ask-1"]),
    {
      status: "configured",
      last_attempt_at: null,
      last_delivery_at: null,
      last_error: null,
    }
  );
  assert.deepEqual(notify.overdue, {
    "ask-1": {
      overdue_by_ms: 60_000,
      delivery_attempts: 0,
      last_delivery_at: null,
    },
  });
  assert.equal(notify.overdue["not-visible"], undefined);
});
