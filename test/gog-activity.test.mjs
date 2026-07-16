#!/usr/bin/env node
// test/gog-activity.test.mjs — AIO-355: unit tests for the gog → activity.jsonl
// writer (normalization + idempotent append), plus an integration smoke test that
// SKIPS (never fails) when `gog` isn't installed/authenticated on this machine.
//
// Fixtures below are shaped from real `gog calendar events --today --json
// --results-only` / `gog gmail search <query> --json --results-only -z UTC`
// output (captured 2026-07-13) — see the gog-activity SKILL.md for the exact
// commands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isoFromCalendarTime,
  isoFromGmailDate,
  normalizeCalendarEvent,
  normalizeEmailThread,
  loadExistingRefs,
  appendActivity,
  fetchTodayEvents,
  fetchNeedingReplyThreads,
  gogAvailable,
  DEFAULT_TIER,
  enrichCalendarEvent,
  enrichEmailThread,
  appendObservations,
  observationDedupKey,
  observationLineKey,
  OBSERVATIONS_SCHEMA_VERSION,
  acquireGogActivityLock,
} from "../scaffold/.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs";
import { projectObservations } from "../dist/operator-loop/index.js";

// ── fixtures (trimmed, real gog --json shapes) ──────────────────────────────

const TIMED_EVENT = {
  id: "ki57062rqurcrjpeha2c02e14k_20260712T230000Z",
  summary: "1:1 with Alex",
  start: { dateTime: "2026-07-13T07:00:00+08:00", timeZone: "Etc/GMT-8" },
  end: { dateTime: "2026-07-13T07:30:00+08:00", timeZone: "Etc/GMT-8" },
  attendees: [
    { displayName: "Alex Rivera", email: "alex@example.com", responseStatus: "accepted" },
  ],
  status: "confirmed",
};

const ALLDAY_EVENT = {
  id: "e7504f58bdff4d2ba968a672ec943243",
  summary: "Book blood test",
  start: { date: "2026-07-13" },
  end: { date: "2026-07-14" },
  status: "confirmed",
};

const NO_ID_EVENT = { summary: "Malformed — no id", start: { date: "2026-07-13" } };

const UNREAD_THREAD = {
  id: "19f599b0a9e295ee",
  date: "2026-07-13 03:52",
  from: "Jennifer Curtis <jennifer.acurtis@mills-reeve.com>",
  subject: "Automatic reply: Confidential [M&R-CLIENTDMS.FID1896237]",
  labels: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
  messageCount: 1,
};

const NO_ID_THREAD = { date: "2026-07-13 03:52", subject: "Malformed — no id" };

test("cross-process pull lock excludes a live owner and safely reclaims a dead one", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "gog-lock-"));
  const releaseFirst = acquireGogActivityLock(repo, {
    pid: 111,
    token: "first",
    probe: () => {},
  });
  assert.equal(typeof releaseFirst, "function");
  assert.equal(acquireGogActivityLock(repo, { pid: 222, token: "second", probe: () => {} }), null);

  const dead = new Error("dead");
  dead.code = "ESRCH";
  const releaseReclaimed = acquireGogActivityLock(repo, {
    pid: 222,
    token: "second",
    probe: () => {
      throw dead;
    },
  });
  assert.equal(typeof releaseReclaimed, "function");
  releaseFirst(); // stale owner cannot delete the replacement token
  assert.equal(acquireGogActivityLock(repo, { pid: 333, token: "third", probe: () => {} }), null);
  releaseReclaimed();
  assert.equal(
    typeof acquireGogActivityLock(repo, { pid: 333, token: "third", probe: () => {} }),
    "function"
  );
});

// ── normalization ────────────────────────────────────────────────────────────

test("isoFromCalendarTime: dateTime passes through as ISO", () => {
  assert.equal(
    isoFromCalendarTime({ dateTime: "2026-07-13T07:00:00+08:00" }),
    "2026-07-12T23:00:00.000Z"
  );
});

test("isoFromCalendarTime: all-day date anchors at UTC midnight", () => {
  assert.equal(isoFromCalendarTime({ date: "2026-07-13" }), "2026-07-13T00:00:00.000Z");
});

test("isoFromCalendarTime: missing/malformed → null", () => {
  assert.equal(isoFromCalendarTime(null), null);
  assert.equal(isoFromCalendarTime({}), null);
});

test("isoFromGmailDate: 'YYYY-MM-DD HH:MM' (UTC) → ISO", () => {
  assert.equal(isoFromGmailDate("2026-07-13 03:52"), "2026-07-13T03:52:00.000Z");
});

test("isoFromGmailDate: missing/malformed → null", () => {
  assert.equal(isoFromGmailDate(""), null);
  assert.equal(isoFromGmailDate(undefined), null);
});

test("normalizeCalendarEvent: timed event → comms activity record contract", () => {
  const rec = normalizeCalendarEvent(TIMED_EVENT);
  assert.deepEqual(rec, {
    source: "calendar",
    tier: DEFAULT_TIER,
    occurredAt: "2026-07-12T23:00:00.000Z",
    ref: "cal:ki57062rqurcrjpeha2c02e14k_20260712T230000Z",
    channel: null,
    direction: null,
    summary: 'Meeting: "1:1 with Alex" with Alex Rivera',
  });
});

test("normalizeCalendarEvent: all-day event, no attendees", () => {
  const rec = normalizeCalendarEvent(ALLDAY_EVENT);
  assert.equal(rec.occurredAt, "2026-07-13T00:00:00.000Z");
  assert.equal(rec.summary, 'Meeting: "Book blood test"');
});

test("normalizeCalendarEvent: respects an explicit tier override", () => {
  const rec = normalizeCalendarEvent(TIMED_EVENT, { tier: "team" });
  assert.equal(rec.tier, "team");
});

test("normalizeCalendarEvent: no id → null (not written)", () => {
  assert.equal(normalizeCalendarEvent(NO_ID_EVENT), null);
  assert.equal(normalizeCalendarEvent(null), null);
});

test("normalizeEmailThread: unread thread → comms activity record contract", () => {
  const rec = normalizeEmailThread(UNREAD_THREAD);
  assert.deepEqual(rec, {
    source: "email",
    tier: DEFAULT_TIER,
    occurredAt: "2026-07-13T03:52:00.000Z",
    ref: "gmail:19f599b0a9e295ee",
    channel: null,
    direction: "inbound",
    summary:
      'Email needing reply: "Automatic reply: Confidential [M&R-CLIENTDMS.FID1896237]" from Jennifer Curtis <jennifer.acurtis@mills-reeve.com>',
  });
});

test("normalizeEmailThread: no id → null (not written)", () => {
  assert.equal(normalizeEmailThread(NO_ID_THREAD), null);
  assert.equal(normalizeEmailThread(null), null);
});

// ── idempotent append ────────────────────────────────────────────────────────

function tmpActivityPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-gog-activity-"));
  return path.join(dir, "1-inbox", "comms", "activity.jsonl");
}

test("appendActivity: writes new records to a fresh file", () => {
  const file = tmpActivityPath();
  const records = [normalizeCalendarEvent(TIMED_EVENT), normalizeEmailThread(UNREAD_THREAD)];
  const { written, skipped } = appendActivity(file, records);
  assert.equal(written, 2);
  assert.equal(skipped, 0);
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).ref, "cal:ki57062rqurcrjpeha2c02e14k_20260712T230000Z");
  assert.equal(JSON.parse(lines[1]).ref, "gmail:19f599b0a9e295ee");
});

test("appendActivity: re-running with the same records is a no-op (idempotent by ref)", () => {
  const file = tmpActivityPath();
  const records = [normalizeCalendarEvent(TIMED_EVENT), normalizeEmailThread(UNREAD_THREAD)];
  appendActivity(file, records);
  const second = appendActivity(file, records);
  assert.equal(second.written, 0);
  assert.equal(second.skipped, 2);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "no duplicate lines after a second identical run");
});

test("appendActivity: only genuinely new records are appended on a partial re-run", () => {
  const file = tmpActivityPath();
  appendActivity(file, [normalizeCalendarEvent(TIMED_EVENT)]);
  const NEW_THREAD = { ...UNREAD_THREAD, id: "brandnew123" };
  const { written, skipped } = appendActivity(file, [
    normalizeCalendarEvent(TIMED_EVENT), // already on disk
    normalizeEmailThread(NEW_THREAD), // new
  ]);
  assert.equal(written, 1);
  assert.equal(skipped, 1);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("appendActivity: dedupes within a single batch too (same ref fetched twice in one run)", () => {
  const file = tmpActivityPath();
  const { written, skipped } = appendActivity(file, [
    normalizeCalendarEvent(TIMED_EVENT),
    normalizeCalendarEvent(TIMED_EVENT),
  ]);
  assert.equal(written, 1);
  assert.equal(skipped, 1);
});

test("loadExistingRefs: tolerates malformed lines already on disk", () => {
  const file = tmpActivityPath();
  appendActivity(file, [normalizeCalendarEvent(TIMED_EVENT)]);
  appendFileSync(file, "not json\n"); // hand-corrupt: a stray non-JSON line
  const refs = loadExistingRefs(file);
  assert.ok(refs.has("cal:ki57062rqurcrjpeha2c02e14k_20260712T230000Z"));
});

// ── dual emission (AIO-387): legacy stream byte-identical + enriched stream ──

function tmpObservationsPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-gog-obs-"));
  return path.join(dir, ".aios", "loop", "inbox", "observations.ndjson");
}

// The legacy activity.jsonl bytes MUST be unchanged by dual emission. Frozen golden = the exact
// record objects the normalization contract has always produced (see the deepEqual tests above),
// serialized one-per-line. If dual emission ever perturbs the legacy writer, this diff is non-empty.
test("golden: legacy activity.jsonl is byte-identical (dual emission does not touch it)", () => {
  const file = tmpActivityPath();
  const records = [normalizeCalendarEvent(TIMED_EVENT), normalizeEmailThread(UNREAD_THREAD)];
  appendActivity(file, records);
  const golden =
    JSON.stringify({
      source: "calendar",
      tier: "admin",
      occurredAt: "2026-07-12T23:00:00.000Z",
      ref: "cal:ki57062rqurcrjpeha2c02e14k_20260712T230000Z",
      channel: null,
      direction: null,
      summary: 'Meeting: "1:1 with Alex" with Alex Rivera',
    }) +
    "\n" +
    JSON.stringify({
      source: "email",
      tier: "admin",
      occurredAt: "2026-07-13T03:52:00.000Z",
      ref: "gmail:19f599b0a9e295ee",
      channel: null,
      direction: "inbound",
      summary:
        'Email needing reply: "Automatic reply: Confidential [M&R-CLIENTDMS.FID1896237]" from Jennifer Curtis <jennifer.acurtis@mills-reeve.com>',
    }) +
    "\n";
  assert.equal(
    readFileSync(file, "utf8"),
    golden,
    "legacy activity.jsonl golden-diff must be empty"
  );
});

test("enrichCalendarEvent: timed event → versioned observation with identity + participants", () => {
  const obs = enrichCalendarEvent(TIMED_EVENT, { account: "john@example.com", tenant: "personal" });
  assert.equal(obs.schema_version, OBSERVATIONS_SCHEMA_VERSION);
  assert.equal(obs.connection_id, "gog:john@example.com");
  assert.equal(obs.account, "john@example.com");
  assert.equal(obs.tenant, "personal");
  assert.equal(obs.object_kind, "calendar-event");
  assert.equal(obs.native_id, "ki57062rqurcrjpeha2c02e14k_20260712T230000Z");
  assert.equal(obs.snippet, "1:1 with Alex");
  assert.deepEqual(obs.participants, [
    { id: "alex@example.com", display: "Alex Rivera", role: "attendee" },
  ]);
  assert.equal(obs.revision.op, "create");
});

test("enrichEmailThread: unread thread → versioned observation with sender participant", () => {
  const obs = enrichEmailThread(UNREAD_THREAD, { account: "john@example.com" });
  assert.equal(obs.object_kind, "email");
  assert.equal(obs.native_id, "19f599b0a9e295ee");
  assert.equal(obs.thread_id, "19f599b0a9e295ee");
  assert.deepEqual(obs.participants, [
    { id: "jennifer.acurtis@mills-reeve.com", display: "Jennifer Curtis", role: "from" },
  ]);
});

test("enrich*: no id → null (not written), mirroring the legacy normalizers", () => {
  assert.equal(enrichCalendarEvent(NO_ID_EVENT), null);
  assert.equal(enrichEmailThread(NO_ID_THREAD), null);
  assert.equal(enrichCalendarEvent(null), null);
});

test("dual emission: the writer's legacy + enriched twins collapse to one item in dual-read", () => {
  const legacy = [normalizeCalendarEvent(TIMED_EVENT), normalizeEmailThread(UNREAD_THREAD)];
  const enriched = [
    enrichCalendarEvent(TIMED_EVENT, { account: "john@example.com" }),
    enrichEmailThread(UNREAD_THREAD, { account: "john@example.com" }),
  ];
  const items = projectObservations({ legacy, enriched });
  assert.equal(items.size, 2, "two objects, each legacy record absorbed into its enriched twin");
  assert.ok([...items.values()].every((i) => i.origin === "enriched"));
});

test("dual emission: enriched stream appends idempotently (crash re-pull writes no duplicate)", () => {
  const file = tmpObservationsPath();
  const obs = [enrichEmailThread(UNREAD_THREAD, { account: "john@example.com" })];
  const first = appendObservations(file, obs);
  assert.equal(first.written, 1);
  const second = appendObservations(file, obs); // re-pull
  assert.equal(second.written, 0);
  assert.equal(second.skipped, 1);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("dual emission: two accounts observing the same thread → distinct dedup keys (two items)", () => {
  const a = enrichEmailThread(UNREAD_THREAD, { account: "alice@example.com" });
  const b = enrichEmailThread(UNREAD_THREAD, { account: "bob@example.com" });
  assert.notEqual(observationDedupKey(a), observationDedupKey(b));
  assert.notEqual(observationLineKey(a), observationLineKey(b));
  assert.equal(projectObservations({ enriched: [a, b] }).size, 2);
});

// ── integration (skip-if-no-gog) ─────────────────────────────────────────────

test("integration: gog calendar/gmail fetch (skipped when `gog` is not on PATH/authenticated)", (t) => {
  if (!gogAvailable()) {
    t.skip(
      "gog not found on PATH — install/authenticate it to run this check (see gog-workspace skill)"
    );
    return;
  }
  let events, threads;
  try {
    events = fetchTodayEvents({ max: 3 });
    threads = fetchNeedingReplyThreads({ max: 3 });
  } catch (e) {
    t.skip(`gog invocation failed (likely not authenticated): ${e.message}`);
    return;
  }
  assert.ok(Array.isArray(events), "fetchTodayEvents returns an array");
  assert.ok(Array.isArray(threads), "fetchNeedingReplyThreads returns an array");
  for (const e of events) {
    const rec = normalizeCalendarEvent(e);
    if (rec) assert.equal(rec.source, "calendar");
  }
  for (const th of threads) {
    const rec = normalizeEmailThread(th);
    if (rec) assert.equal(rec.source, "email");
  }
});
