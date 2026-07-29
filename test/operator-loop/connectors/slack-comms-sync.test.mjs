import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendNewRecords,
  existingRefs,
  messageRef,
  normalizeSlackMessage,
  parseArgs,
  slackTsToIso,
  stripSlackMarkup,
  withinLookback,
  DEFAULT_LOOKBACK_HOURS,
} from "../../../scripts/connectors/slack-comms-sync.mjs";

function workspace() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "aios-slack-comms-")));
}

// Fixtures shaped like `slack read --target … --json` output (raw conversations.history
// message objects, as printed by .claude/skills/slack-personal/slack.py).
const INBOUND = {
  type: "message",
  user: "U0TEAMMATE",
  user_profile: { display_name: "chetan", real_name: "Chetan Kumar" },
  text: "Hey <@U0SELF> can you look at <https://example.com/pr/12|PR 12> in <#C0ENG|eng> today?",
  ts: "1782907200.000100",
};

const OUTBOUND = {
  type: "message",
  user: "U0SELF",
  user_profile: { display_name: "john" },
  text: "On it &amp; will report back",
  ts: "1782907500.000200",
};

const JOIN_NOISE = {
  type: "message",
  subtype: "channel_join",
  user: "U0TEAMMATE",
  text: "<@U0TEAMMATE> has joined the channel",
  ts: "1782907600.000300",
};

test("slackTsToIso converts Slack timestamps and rejects junk", () => {
  assert.equal(slackTsToIso("1782907200.000100"), "2026-07-01T12:00:00.000Z");
  assert.equal(slackTsToIso("not-a-ts"), null);
  assert.equal(slackTsToIso(undefined), null);
});

test("stripSlackMarkup renders mentions, channel refs, links and entities readably", () => {
  assert.equal(stripSlackMarkup("hi <@U0SELF>"), "hi @U0SELF");
  assert.equal(stripSlackMarkup("hi <@U0SELF|john>"), "hi @john");
  assert.equal(stripSlackMarkup("see <#C0ENG|eng>"), "see #eng");
  assert.equal(stripSlackMarkup("<https://x.test|the link>"), "the link");
  assert.equal(stripSlackMarkup("<https://x.test>"), "https://x.test");
  assert.equal(stripSlackMarkup("a &amp; b"), "a & b");
  assert.equal(stripSlackMarkup("multi\n  line"), "multi line");
});

test("normalizeSlackMessage maps an inbound message onto the CommsActivityRecord contract", () => {
  const record = normalizeSlackMessage(INBOUND, { channel: "#eng", selfUserId: "U0SELF" });

  assert.deepEqual(record, {
    source: "slack",
    channel: "#eng",
    occurredAt: "2026-07-01T12:00:00.000Z",
    ref: "slack:#eng:1782907200.000100",
    direction: "inbound",
    summary: "chetan in #eng: Hey @U0SELF can you look at PR 12 in #eng today?",
  });
  // tier/access are deliberately absent — the channel→tier map in comms-config is authoritative.
  assert.equal("tier" in record, false);
  assert.equal("access" in record, false);
});

test("normalizeSlackMessage marks the authenticated user's own messages outbound", () => {
  assert.equal(
    normalizeSlackMessage(OUTBOUND, { channel: "#eng", selfUserId: "U0SELF" }).direction,
    "outbound"
  );
  // Unknown identity degrades to inbound rather than guessing.
  assert.equal(normalizeSlackMessage(OUTBOUND, { channel: "#eng" }).direction, "inbound");
});

test("normalizeSlackMessage drops join noise, empty text, bad ts and missing channel", () => {
  assert.equal(normalizeSlackMessage(JOIN_NOISE, { channel: "#eng" }), null);
  assert.equal(normalizeSlackMessage({ ...INBOUND, text: "   " }, { channel: "#eng" }), null);
  assert.equal(normalizeSlackMessage({ ...INBOUND, ts: "nope" }, { channel: "#eng" }), null);
  assert.equal(normalizeSlackMessage(INBOUND, { channel: "" }), null);
  assert.equal(normalizeSlackMessage(null, { channel: "#eng" }), null);
});

test("messageRef is collision-proof across channels sharing a ts", () => {
  assert.notEqual(messageRef("#eng", "1782907200.000100"), messageRef("#ops", "1782907200.000100"));
});

test("withinLookback keeps only records inside the window", () => {
  const now = new Date("2026-07-02T00:00:00Z");
  const records = [
    { ref: "a", occurredAt: "2026-07-01T12:00:00.000Z" }, // inside
    { ref: "b", occurredAt: "2026-06-01T12:00:00.000Z" }, // older than 168h
    { ref: "c", occurredAt: "2026-07-03T00:00:00.000Z" }, // future
    { ref: "d", occurredAt: "not-a-date" },
  ];
  assert.deepEqual(
    withinLookback(records, { hours: DEFAULT_LOOKBACK_HOURS, now }).map((r) => r.ref),
    ["a"]
  );
});

test("appendNewRecords is idempotent: a second run writes nothing and skips every ref", () => {
  const root = workspace();
  const file = path.join(root, "1-inbox", "comms", "activity.jsonl");
  const records = [
    normalizeSlackMessage(INBOUND, { channel: "#eng", selfUserId: "U0SELF" }),
    normalizeSlackMessage(OUTBOUND, { channel: "#eng", selfUserId: "U0SELF" }),
  ];

  const first = appendNewRecords(file, records);
  assert.deepEqual({ written: first.written, skipped: first.skipped }, { written: 2, skipped: 0 });

  const second = appendNewRecords(file, records);
  assert.deepEqual(
    { written: second.written, skipped: second.skipped },
    { written: 0, skipped: 2 }
  );

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).ref),
    ["slack:#eng:1782907200.000100", "slack:#eng:1782907500.000200"]
  );
});

test("appendNewRecords dedupes within a single batch and skips ref-less records", () => {
  const root = workspace();
  const file = path.join(root, "activity.jsonl");
  const record = normalizeSlackMessage(INBOUND, { channel: "#eng", selfUserId: "U0SELF" });

  const result = appendNewRecords(file, [record, { ...record }, { source: "slack" }]);
  assert.deepEqual(
    { written: result.written, skipped: result.skipped },
    { written: 1, skipped: 2 }
  );
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("appendNewRecords preserves existing lines and never glues onto a missing newline", () => {
  const root = workspace();
  const file = path.join(root, "activity.jsonl");
  writeFileSync(file, JSON.stringify({ source: "email", ref: "email-1", summary: "x" })); // no \n

  const record = normalizeSlackMessage(INBOUND, { channel: "#eng", selfUserId: "U0SELF" });
  assert.equal(appendNewRecords(file, [record]).written, 1);

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).ref, "email-1");
  assert.equal(JSON.parse(lines[1]).ref, record.ref);
});

test("appendNewRecords --dry-run computes the result without creating the file", () => {
  const root = workspace();
  const file = path.join(root, "nested", "activity.jsonl");
  const record = normalizeSlackMessage(INBOUND, { channel: "#eng", selfUserId: "U0SELF" });

  const result = appendNewRecords(file, [record], { dryRun: true });
  assert.equal(result.written, 1);
  assert.equal(existingRefs(file).size, 0);
});

test("existingRefs tolerates blank and corrupt lines", () => {
  const root = workspace();
  const file = path.join(root, "activity.jsonl");
  writeFileSync(file, `{"ref":"a"}\n\nnot json\n{"ref":"b"}\n{"summary":"no ref"}\n`);
  assert.deepEqual([...existingRefs(file)].sort(), ["a", "b"]);
});

test("parseArgs handles repeatable + comma-separated channels and flag defaults", () => {
  const opts = parseArgs(["--channel", "#eng,#ops", "--channel", "@a@b.com", "--dry-run"]);
  assert.deepEqual(opts.channels, ["#eng", "#ops", "@a@b.com"]);
  assert.equal(opts.hours, DEFAULT_LOOKBACK_HOURS);
  assert.equal(opts.out, "1-inbox/comms/activity.jsonl");
  assert.equal(opts.dryRun, true);

  const custom = parseArgs(["--channel", "#eng", "--hours", "24", "--out", "/tmp/a.jsonl"]);
  assert.equal(custom.hours, 24);
  assert.equal(custom.out, "/tmp/a.jsonl");

  // Duplicate channels collapse.
  assert.deepEqual(parseArgs(["--channel", "#eng", "--channel", "#eng"]).channels, ["#eng"]);
});

test("parseArgs rejects bad usage loudly with exit code 2", () => {
  for (const argv of [
    ["--channel"],
    ["--hours", "0"],
    ["--hours", "-3"],
    ["--limit", "abc"],
    ["--nope"],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (e) => e.code === 2,
      `expected usage error for ${argv}`
    );
  }
});
