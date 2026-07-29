// Unit tests for the Gmail → comms activity JSONL connector (scripts/connectors/gog-comms-sync.mjs).
// Covers ONLY the pure mapping/normalization layer and the idempotent-append logic — the real
// `gog` CLI is never invoked (fetchMessages takes an injectable runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendRecords,
  directionFor,
  existingRefs,
  fetchMessages,
  gmailWindowQuery,
  gogArgs,
  mapMessage,
  mapMessages,
  parseArgs,
  selectNew,
  senderLabel,
  toIso,
  truncate,
  SUMMARY_MAX,
} from "../../../scripts/connectors/gog-comms-sync.mjs";

function tmp() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "aios-gog-comms-")));
}

// Fixtures mirror real `gog gmail messages search --json -z UTC` output.
const INBOUND = {
  id: "19fab0e75ce2f444",
  threadId: "19fa12edb1148fcf",
  date: "2026-07-28 23:27",
  from: "Adam Guzman-Poole <adam@example.com>",
  subject: "Re: Updated invitation: Love and Support",
  labels: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
};

const OUTBOUND = {
  id: "19f939446a5d77c0",
  threadId: "19f93935b3a22b2c",
  date: "2026-07-24 10:03",
  from: "john@john-ellison.com",
  subject: "Re: close-out: data deletion + written confirmation",
  labels: ["SENT"],
};

test("mapMessage: emits the CommsActivityRecord contract the comms source parses", () => {
  const rec = mapMessage(INBOUND, { tier: "team" });
  assert.deepEqual(rec, {
    source: "email",
    tier: "team",
    occurredAt: "2026-07-28T23:27:00.000Z",
    ref: "19fab0e75ce2f444",
    direction: "inbound",
    summary: "Adam Guzman-Poole: Re: Updated invitation: Love and Support",
  });
  // Email is channel-less: the source resolves tier from the record itself, so no channel key.
  assert.ok(!("channel" in rec));
});

test("mapMessage: tier is explicit (default-deny) and honours the --tier flag", () => {
  assert.equal(mapMessage(INBOUND).tier, "team");
  assert.equal(mapMessage(INBOUND, { tier: "admin" }).tier, "admin");
  assert.equal(mapMessage(INBOUND, { tier: "external" }).tier, "external");
});

test("mapMessage: SENT label yields outbound; bare address is used as the sender label", () => {
  const rec = mapMessage(OUTBOUND);
  assert.equal(rec.direction, "outbound");
  assert.equal(
    rec.summary,
    "john@john-ellison.com: Re: close-out: data deletion + written confirmation"
  );
});

test("mapMessage: missing subject still produces a non-empty summary (source requires one)", () => {
  const rec = mapMessage({ ...INBOUND, subject: "   " });
  assert.equal(rec.summary, "Adam Guzman-Poole: (no subject)");
});

test("mapMessage: returns null for records with no stable id or no parseable date", () => {
  assert.equal(mapMessage({ ...INBOUND, id: "" }), null);
  assert.equal(mapMessage({ ...INBOUND, date: "not-a-date" }), null);
  assert.equal(mapMessage({ ...INBOUND, date: undefined }), null);
  assert.equal(mapMessage(null), null);
});

test("mapMessages: drops unmappable entries, keeps order", () => {
  const recs = mapMessages([INBOUND, { id: "" }, OUTBOUND]);
  assert.deepEqual(
    recs.map((r) => r.ref),
    [INBOUND.id, OUTBOUND.id]
  );
});

test("toIso / senderLabel / truncate / directionFor", () => {
  assert.equal(toIso("2026-07-28 23:27"), "2026-07-28T23:27:00.000Z");
  assert.equal(toIso("2026-07-28 23:27:11"), "2026-07-28T23:27:11.000Z");
  assert.equal(toIso("2026-07-28T23:27:00Z"), "2026-07-28T23:27:00.000Z");
  assert.equal(toIso(""), null);

  assert.equal(senderLabel("Jane Doe <jane@x.com>"), "Jane Doe");
  assert.equal(senderLabel('"Doe, Jane" <jane@x.com>'), "Doe, Jane");
  assert.equal(senderLabel("<jane@x.com>"), "jane@x.com");
  assert.equal(senderLabel("jane@x.com"), "jane@x.com");
  assert.equal(senderLabel(undefined), "unknown sender");

  const long = truncate("x".repeat(500));
  assert.equal(long.length, SUMMARY_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(truncate("a\n b   c"), "a b c");

  assert.equal(directionFor(["INBOX"]), "inbound");
  assert.equal(directionFor(["sent"]), "outbound");
  assert.equal(directionFor(undefined), "inbound");
});

test("existingRefs: reads refs from an existing file, tolerates junk lines", () => {
  const file = path.join(tmp(), "activity.jsonl");
  writeFileSync(
    file,
    [JSON.stringify({ ref: "a" }), "", "{not json", JSON.stringify({ ref: "b" }), ""].join("\n")
  );
  assert.deepEqual([...existingRefs(file)].sort(), ["a", "b"]);
  assert.equal(existingRefs(path.join(tmp(), "missing.jsonl")).size, 0);
});

test("selectNew: skips refs already on disk and duplicates within the batch", () => {
  const { fresh, skipped } = selectNew(
    [{ ref: "a" }, { ref: "b" }, { ref: "b" }, { ref: "c" }],
    new Set(["a"])
  );
  assert.deepEqual(
    fresh.map((r) => r.ref),
    ["b", "c"]
  );
  assert.equal(skipped, 2);
});

test("appendRecords: idempotent — a second identical run appends nothing", () => {
  const file = path.join(tmp(), "nested", "activity.jsonl");
  const records = mapMessages([INBOUND, OUTBOUND]);

  const first = appendRecords(file, records);
  assert.deepEqual(first, { wrote: 2, skipped: 0 });

  const second = appendRecords(file, records);
  assert.deepEqual(second, { wrote: 0, skipped: 2 });

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).ref),
    [INBOUND.id, OUTBOUND.id]
  );
});

test("appendRecords: a later run appends only the genuinely new record", () => {
  const file = path.join(tmp(), "activity.jsonl");
  appendRecords(file, mapMessages([INBOUND]));
  const res = appendRecords(file, mapMessages([INBOUND, OUTBOUND]));
  assert.deepEqual(res, { wrote: 1, skipped: 1 });
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});

test("appendRecords: --dry-run writes nothing but still reports counts", () => {
  const file = path.join(tmp(), "activity.jsonl");
  const res = appendRecords(file, mapMessages([INBOUND]), { dryRun: true });
  assert.deepEqual(res, { wrote: 1, skipped: 0 });
  assert.equal(existingRefs(file).size, 0);
});

test("gmailWindowQuery: rounds the hour window UP to whole days, never short", () => {
  assert.equal(gmailWindowQuery("in:inbox", 168), "in:inbox newer_than:7d");
  assert.equal(gmailWindowQuery("in:inbox", 1), "in:inbox newer_than:1d");
  assert.equal(gmailWindowQuery("in:inbox", 25), "in:inbox newer_than:2d");
});

test("gogArgs: builds a read-only, UTC, JSON, non-interactive gog invocation", () => {
  const args = gogArgs({ query: "in:inbox", hours: 24, max: 50, account: "john@x.com" });
  assert.deepEqual(args, [
    "gmail",
    "messages",
    "search",
    "in:inbox newer_than:1d",
    "--json",
    "--no-input",
    "-z",
    "UTC",
    "--max",
    "50",
    "-a",
    "john@x.com",
  ]);
  assert.ok(!gogArgs({ query: "in:inbox", hours: 24, max: 50, account: null }).includes("-a"));
});

test("fetchMessages: parses the injected runner's JSON and fails loudly otherwise", () => {
  const opts = { query: "in:inbox", hours: 24, max: 10, account: null };
  const ok = fetchMessages(opts, () => JSON.stringify({ messages: [INBOUND] }));
  assert.deepEqual(ok, [INBOUND]);

  assert.throws(() => fetchMessages(opts, () => "not json"), /non-JSON output/);
  assert.throws(
    () => fetchMessages(opts, () => JSON.stringify({ threads: [] })),
    /no `messages` array/
  );
  assert.throws(
    () =>
      fetchMessages(opts, () => {
        const e = new Error("spawn gog ENOENT");
        e.code = "ENOENT";
        throw e;
      }),
    /`gog` CLI not found on PATH/
  );
});

test("parseArgs: defaults, overrides, and loud rejection of bad values", () => {
  const d = parseArgs([]);
  assert.equal(d.out, "1-inbox/comms/activity.jsonl");
  assert.equal(d.query, "in:inbox");
  assert.equal(d.hours, 168);
  assert.equal(d.tier, "team");
  assert.equal(d.dryRun, false);

  const o = parseArgs([
    "--out",
    "/tmp/x.jsonl",
    "--query",
    "is:unread",
    "--since",
    "24",
    "--tier",
    "admin",
    "-n",
  ]);
  assert.equal(o.out, "/tmp/x.jsonl");
  assert.equal(o.query, "is:unread");
  assert.equal(o.hours, 24);
  assert.equal(o.tier, "admin");
  assert.equal(o.dryRun, true);

  assert.throws(() => parseArgs(["--tier", "public"]), /admin\|team\|external/);
  assert.throws(() => parseArgs(["--hours", "0"]), /positive number of hours/);
  assert.throws(() => parseArgs(["--max", "abc"]), /positive int/);
  assert.throws(() => parseArgs(["--out"]), /--out requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
});
