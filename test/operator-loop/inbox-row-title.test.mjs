// Inbox row rendering — what a row SAYS (audit S3-1 / S3-2).
//
// The queue used to render `item.id` + `item.why` and nothing else, so 137 items read as 137
// opaque keys: a uuid for agent rows, a ~70-char composite JSON key for thread rows. Meanwhile
// `ask.title` and the observation's sender + snippet were sitting on the same object, unused.
// `why` is the RANKER's explain string — it is not a description, and its DM branch is the
// fallthrough for email threads, calendar events and agent asks alike, so it called everything a
// "DM". These tests pin the content contract: a row shows what it is about, `why` only on request.

import test from "node:test";
import assert from "node:assert/strict";
import {
  inboxRowTitle,
  inboxRowRef,
  renderInboxText,
  TITLE_MAX,
} from "../../dist/operator-loop/index.js";

const agentRow = (over = {}) => ({
  id: "3e38db57-c86f-4203-988e-32db361bdbd9",
  origin: "agent-event",
  source: "cli",
  account: null,
  bucket: "needs-you",
  protected: true,
  why: "DM needs-reply; act 0.40, age 6.7d, tier?/imp 0.00 → IMPORTANT",
  attention_state: "surfaced",
  action_state: "none",
  ts: "2026-07-21T12:15:57.425Z",
  ask: { id: "3e38db57-c86f-4203-988e-32db361bdbd9", title: "Complete the cost setup" },
  ...over,
});

const threadRow = (over = {}) => ({
  id: '["gog:primary","primary","personal","email","19fa2f011027c727"]',
  origin: "thread-state",
  source: "email",
  account: "primary",
  bucket: "thread",
  protected: false,
  why: "DM, no needs-reply, importance 0.00/tier? → AWARENESS",
  attention_state: "surfaced",
  action_state: "none",
  ts: "2026-07-27T09:37:00.000Z",
  observation: {
    key: "k",
    connection_id: "gog:primary",
    account: "primary",
    tenant: "personal",
    object_kind: "email",
    native_id: "19fa2f011027c727",
    thread_id: "19fa2f011027c727",
    participants: [{ id: "sam@example.test", display: "Sam Rivera", role: "from" }],
    snippet: "Are we still on for the review?",
    deleted: false,
    revisions: [],
    ts: "2026-07-27T09:37:00.000Z",
    origin: "enriched",
  },
  ...over,
});

const view = (items) => ({
  items,
  ranker_version: "inbox-ranker-1.0.0-shadow",
  generated_at: "2026-07-28T00:00:00.000Z",
  staleness: { stale: false, newest_observation_ts: null, slo_ms: 300000, age_ms: null },
});

test("an agent row shows the ask title, not the uuid", () => {
  assert.equal(inboxRowTitle(agentRow()), "Complete the cost setup");
});

test("a thread row shows sender and snippet, not the composite key", () => {
  assert.equal(inboxRowTitle(threadRow()), "Sam Rivera — Are we still on for the review?");
});

test("a thread row falls back through display → id → snippet → kind", () => {
  const noDisplay = threadRow();
  noDisplay.observation.participants = [{ id: "sam@example.test", display: "", role: "from" }];
  assert.equal(inboxRowTitle(noDisplay), "sam@example.test — Are we still on for the review?");

  const noWho = threadRow();
  noWho.observation.participants = [];
  assert.equal(inboxRowTitle(noWho), "Are we still on for the review?");

  const bare = threadRow();
  bare.observation.participants = [];
  bare.observation.snippet = null;
  assert.equal(inboxRowTitle(bare), "email 19fa2f011027c727");
});

test("a health row describes the adapter, not the ranker", () => {
  const row = agentRow({
    ask: undefined,
    health: { adapter: "gog", state: "degraded", detail: "token expired", restarts: 3 },
  });
  assert.equal(inboxRowTitle(row), "gog: degraded — token expired");
});

test("titles are flattened and clipped", () => {
  const long = agentRow({ ask: { id: "a".repeat(36), title: `${"x".repeat(200)}` } });
  const out = inboxRowTitle(long);
  assert.equal(out.length, TITLE_MAX);
  assert.ok(out.endsWith("…"));

  const wrapped = agentRow({ ask: { id: "b", title: "line one\n  line two" } });
  assert.equal(inboxRowTitle(wrapped), "line one line two");
});

test("a row with neither ask nor observation degrades, never throws", () => {
  assert.equal(inboxRowTitle(agentRow({ ask: undefined })), "(no title)");
});

test("the row ref is the 8-char ask prefix `aios asks` prints", () => {
  assert.equal(inboxRowRef(agentRow()), "3e38db57");
});

test("the row ref for a thread is the native id, not the composite key", () => {
  const ref = inboxRowRef(threadRow());
  assert.ok(!ref.includes("gog:primary"), `composite key leaked into the ref: ${ref}`);
  assert.ok("19fa2f011027c727".startsWith(ref.replace("…", "")));
});

test("rendered rows carry the title and hide `why` by default", () => {
  const text = renderInboxText(view([agentRow(), threadRow()]), {
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.ok(text.includes("Complete the cost setup"));
  assert.ok(text.includes("Sam Rivera — Are we still on for the review?"));
  assert.ok(!text.includes("act 0.40"), "ranker debug should not be the row's description");
  assert.ok(!text.includes('["gog:primary"'), "composite key should not be rendered");
});

test("--why puts the ranker's reasoning back, on its own line", () => {
  const text = renderInboxText(view([agentRow()]), {
    why: true,
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.ok(text.includes("Complete the cost setup"));
  assert.ok(text.includes("why: DM needs-reply; act 0.40"));
});

test("--raw honours --why too", () => {
  const text = renderInboxText(view([agentRow()]), { raw: true, why: true });
  assert.ok(text.includes("why: DM needs-reply"));
});
