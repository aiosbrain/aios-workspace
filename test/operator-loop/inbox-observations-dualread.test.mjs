#!/usr/bin/env node
// test/operator-loop/inbox-observations-dualread.test.mjs — I-06 / AIO-387.
//
// The dual-read acceptance for the enriched adapter-observation record:
//   • legacy-only, enriched-only, and mixed streams project identically-keyed items;
//   • MULTI-ACCOUNT COLLISION: the same native message via two accounts → TWO items, not one
//     (the corrected dedup key `(connection/account/tenant, object_kind, native_id)`);
//   • dedup: re-pulling the same page → zero duplicate items;
//   • transactional cursor: a "crash" between record write and cursor advance re-pulls without
//     duplicates (the cursor rides on each record — no cursor-ahead-of-data window);
//   • revision: an edited-then-deleted message yields revision events, not new items.
//
// Runs against the compiled barrel (dist/operator-loop/index.js), like the sibling inbox tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildObservation,
  observationDedupKey,
  observationObjectKey,
  observationLineKey,
  appendObservations,
  writeObservation,
  readObservations,
  readCursor,
  observationsPath,
  legacyToObjectRef,
  projectObservations,
  OBSERVATIONS_SCHEMA_VERSION,
} from "../../dist/operator-loop/index.js";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "aios-inbox-obs-"));
}

// A native email thread observed by account A / account B (same tenant, same connector).
function emailObs(account, nativeId, extra = {}) {
  return buildObservation({
    connection_id: `gog:${account}`,
    account,
    tenant: "personal",
    object_kind: "email",
    native_id: nativeId,
    thread_id: nativeId,
    participants: [{ id: "sender@example.com", display: "Sender", role: "from" }],
    snippet: "subject line",
    ...extra,
  });
}

// The legacy activity.jsonl twin of an email thread (the shape gog-activity-pull.mjs writes).
function legacyEmail(nativeId) {
  return {
    source: "email",
    tier: "admin",
    occurredAt: "2026-07-13T03:52:00.000Z",
    ref: `gmail:${nativeId}`,
    channel: null,
    direction: "inbound",
    summary: `Email needing reply: "subject" from Sender`,
  };
}

// ── dedup key semantics ─────────────────────────────────────────────────────

test("dedup key includes account/tenant — two accounts, same native id, distinct keys", () => {
  const a = emailObs("alice@example.com", "THREAD1");
  const b = emailObs("bob@example.com", "THREAD1");
  assert.notEqual(observationDedupKey(a), observationDedupKey(b));
  // …but the scope-free object identity is the same (used only for legacy reconciliation).
  assert.equal(observationObjectKey(a), observationObjectKey(b));
});

// ── projection: legacy-only / enriched-only / mixed ─────────────────────────

test("enriched-only stream projects one item per (account, object)", () => {
  const items = projectObservations({ enriched: [emailObs("alice@example.com", "T1")] });
  assert.equal(items.size, 1);
  const [item] = [...items.values()];
  assert.equal(item.origin, "enriched");
  assert.equal(item.account, "alice@example.com");
  assert.equal(item.object_kind, "email");
  assert.equal(item.native_id, "T1");
});

test("legacy-only stream projects one item (account/tenant unknown)", () => {
  const items = projectObservations({ legacy: [legacyEmail("T1")] });
  assert.equal(items.size, 1);
  const [item] = [...items.values()];
  assert.equal(item.origin, "legacy");
  assert.equal(item.account, null);
  assert.equal(item.object_kind, "email");
  assert.equal(item.native_id, "T1");
});

test("mixed stream: a legacy record + its enriched twin collapse to ONE item", () => {
  const items = projectObservations({
    enriched: [emailObs("alice@example.com", "T1")],
    legacy: [legacyEmail("T1")],
  });
  assert.equal(items.size, 1, "legacy twin is absorbed into the enriched item");
  const [item] = [...items.values()];
  assert.equal(item.origin, "enriched", "the enriched (identity-bearing) record owns the item");
  assert.equal(item.account, "alice@example.com");
});

// ── MULTI-ACCOUNT COLLISION (the corrected key) ─────────────────────────────

test("multi-account collision: same native message via two accounts → TWO items, not one", () => {
  const items = projectObservations({
    enriched: [emailObs("alice@example.com", "SHARED"), emailObs("bob@example.com", "SHARED")],
  });
  assert.equal(items.size, 2, "two accounts must not collapse into one item");
  const accounts = [...items.values()].map((i) => i.account).sort();
  assert.deepEqual(accounts, ["alice@example.com", "bob@example.com"]);
});

test("multi-account collision survives a legacy twin for one account (still two items)", () => {
  const items = projectObservations({
    enriched: [emailObs("alice@example.com", "SHARED"), emailObs("bob@example.com", "SHARED")],
    legacy: [legacyEmail("SHARED")], // twin of ONE account's pull — absorbed, not a 3rd item
  });
  assert.equal(items.size, 2);
});

// ── dedup: re-pull produces zero duplicate items ────────────────────────────

test("dedup: re-pulling the same page produces zero duplicate items", async () => {
  const root = ws();
  try {
    const a = emailObs("alice@example.com", "T1");
    const first = appendObservations(root, [a]);
    assert.equal(first.written, 1);
    const second = appendObservations(root, [a]); // identical re-pull
    assert.equal(second.written, 0, "re-pull writes no new line");
    assert.equal(second.skipped, 1);
    const { observations } = readObservations(root);
    assert.equal(observations.length, 1);
    assert.equal(projectObservations({ enriched: observations }).size, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── transactional cursor: crash between record write and cursor advance ─────

test("transactional cursor: crash-window re-pull yields no duplicates", async () => {
  const root = ws();
  try {
    // The cursor rides on the record. Write observation at cursor "c1".
    const a = emailObs("alice@example.com", "T1", { cursor: "c1" });
    await writeObservation(root, a);
    // "Crash" here — there is no separate cursor file to be ahead of the data.
    // Restart: the adapter reads the last durable cursor and resumes from it.
    assert.equal(readCursor(root, "gog:alice@example.com"), "c1");
    // Re-pull returns the overlapping record at c1 again → idempotent (deduped by line key).
    const rePull = appendObservations(root, [
      emailObs("alice@example.com", "T1", { cursor: "c1" }),
    ]);
    assert.equal(rePull.written, 0, "overlapping re-pull adds no duplicate line");
    const { observations } = readObservations(root);
    assert.equal(observations.length, 1);
    assert.equal(projectObservations({ enriched: observations }).size, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transactional cursor: a torn tail line is dropped, cursor reflects last DURABLE record", () => {
  const root = ws();
  try {
    const file = observationsPath(root);
    appendObservations(root, [emailObs("alice@example.com", "T1", { cursor: "c1" })]);
    // Simulate a crash mid-append: an unterminated partial JSON line (no trailing newline).
    appendFileSync(file, '{"schema_version":1,"connection_id":"gog:alice@example.com","cur');
    const { observations, tornTail, cursors } = readObservations(root);
    assert.equal(tornTail, true, "partial tail line recovered, not a corrupt fold");
    assert.equal(observations.length, 1);
    assert.equal(cursors.get("gog:alice@example.com"), "c1", "cursor = last durable record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── revisions: edit then delete → revision events, not new items ────────────

test("revision: an edited then deleted message yields revision events, not new items", () => {
  const account = "alice@example.com";
  const create = emailObs(account, "T1", {
    revision: { op: "create", revision: 0 },
    snippet: "v0",
  });
  const edit = emailObs(account, "T1", { revision: { op: "edit", revision: 1 }, snippet: "v1" });
  const del = emailObs(account, "T1", { revision: { op: "delete", revision: 2 } });

  const items = projectObservations({ enriched: [create, edit, del] });
  assert.equal(items.size, 1, "revisions of one object stay ONE item");
  const [item] = [...items.values()];
  assert.equal(item.revisions.length, 3);
  assert.deepEqual(
    item.revisions.map((r) => r.op),
    ["create", "edit", "delete"]
  );
  assert.equal(item.deleted, true, "a delete revision marks the item deleted");
  assert.equal(item.snippet, "v1", "the last non-delete edit is the current snippet");
});

test("revisions with the same dedup key + op collapse (idempotent line key)", () => {
  const a = emailObs("alice@example.com", "T1", { revision: { op: "edit", revision: 1 } });
  const b = emailObs("alice@example.com", "T1", { revision: { op: "edit", revision: 1 } });
  assert.equal(observationLineKey(a), observationLineKey(b));
});

// ── legacy ref mapping ──────────────────────────────────────────────────────

test("legacyToObjectRef maps cal:/gmail:/slack: refs to object identities", () => {
  assert.deepEqual(legacyToObjectRef({ source: "email", ref: "gmail:abc" }), {
    object_kind: "email",
    native_id: "abc",
  });
  assert.deepEqual(legacyToObjectRef({ source: "calendar", ref: "cal:xyz" }), {
    object_kind: "calendar-event",
    native_id: "xyz",
  });
  assert.deepEqual(legacyToObjectRef({ source: "slack", ref: "slack:C1:12345.678" }), {
    object_kind: "message",
    native_id: "C1:12345.678",
  });
  assert.equal(legacyToObjectRef({ ref: "" }), null);
});

// ── schema version is stamped ───────────────────────────────────────────────

test("buildObservation stamps the schema version", () => {
  const o = emailObs("alice@example.com", "T1");
  assert.equal(o.schema_version, OBSERVATIONS_SCHEMA_VERSION);
});
