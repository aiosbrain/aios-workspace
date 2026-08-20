// Oracle suite for the capability-handle broker (I-03 / AIO-384) — and, specifically, THE
// mutation oracle for the inbox-authorization nightly campaign (AIO-994). The previous oracle
// travelled to aiosbrain/aios-workspace-gui with the AIO-612 cut and the substituted umbrella
// suite never imported this module, so every mutant survived (26/26, score 0.00 vs a 90% floor).
// This suite imports the compiled dist/ output DIRECTLY — the campaign mutates
// dist/operator-loop/inbox/capability.js, so importing src or a re-export that might be cut
// again would recreate the defect. If this file is ever moved or deleted, the tracked-file
// assertions in test/mutation-config.test.mjs fail loudly.
//
// The assertions are deliberately exhaustive deepEquals over every envelope and journal event:
// with Stryker's command runner the ONLY kill signal is this suite's exit code, so a mutant
// that flips a string literal, empties an object literal, or removes an optional call must
// change something asserted here.
import assert from "node:assert/strict";
import test from "node:test";

import {
  brokerDecision,
  createInMemoryJournal,
  notifyDeepLink,
} from "../../dist/operator-loop/inbox/capability.js";

const NOW = 1755640000000; // fixed clock: 2025-08-19T21:46:40.000Z
const AT = new Date(NOW).toISOString();

const projection = Object.freeze({
  handle: "cap_7f3a",
  operation: "outbox.send",
  summary: "Send the drafted reply to Sam",
  digest: "sha256:a1b2c3",
  expiresAt: "2026-08-19T22:00:00.000Z",
});

test("createInMemoryJournal starts empty and records appends in order", () => {
  const journal = createInMemoryJournal();
  assert.deepEqual(journal.events, []);
  const first = { kind: "user-intent", handle: "h1", at: AT };
  const second = { kind: "pdp-decision", handle: "h2", at: AT, data: { decision: "approve" } };
  journal.append(first);
  journal.append(second);
  assert.equal(journal.events.length, 2);
  assert.equal(journal.events[0], first);
  assert.equal(journal.events[1], second);
});

test("brokerDecision returns the exact envelope: handle + decision + verbatim digest", () => {
  const envelope = brokerDecision(projection, "approve", { now: NOW });
  assert.deepEqual(envelope, {
    handle: "cap_7f3a",
    decision: "approve",
    digest: "sha256:a1b2c3",
    brokeredAt: AT,
  });
});

test("brokerDecision journals user-intent then pdp-decision, content-free and digest-bound", () => {
  const journal = createInMemoryJournal();
  brokerDecision(projection, "approve", { appendInboxEvent: journal.append, now: NOW });
  assert.deepEqual(journal.events, [
    {
      kind: "user-intent",
      handle: "cap_7f3a",
      at: AT,
      data: { intent: "surface", operation: "outbox.send", digest: "sha256:a1b2c3" },
    },
    {
      kind: "pdp-decision",
      handle: "cap_7f3a",
      at: AT,
      data: { decision: "approve", digest: "sha256:a1b2c3" },
    },
  ]);
});

test("brokerDecision carries a deny verdict verbatim into envelope and journal", () => {
  const journal = createInMemoryJournal();
  const envelope = brokerDecision(projection, "deny", {
    appendInboxEvent: journal.append,
    now: NOW,
  });
  assert.equal(envelope.decision, "deny");
  assert.deepEqual(journal.events[1].data, { decision: "deny", digest: "sha256:a1b2c3" });
});

test("brokerDecision never leaks the summary or expiry into any journal event", () => {
  const journal = createInMemoryJournal();
  brokerDecision(projection, "approve", { appendInboxEvent: journal.append, now: NOW });
  const serialized = JSON.stringify(journal.events);
  assert.ok(!serialized.includes(projection.summary));
  assert.ok(!serialized.includes(projection.expiresAt));
});

test("brokerDecision without a journal still brokers (append is optional)", () => {
  const envelope = brokerDecision(projection, "approve", { now: NOW });
  assert.equal(envelope.handle, "cap_7f3a");
  assert.equal(envelope.brokeredAt, AT);
});

test("brokerDecision with no options defaults to the real clock", () => {
  const before = Date.now();
  const envelope = brokerDecision(projection, "approve");
  const after = Date.now();
  const brokered = Date.parse(envelope.brokeredAt);
  assert.ok(
    Number.isFinite(brokered),
    `brokeredAt must be a valid ISO timestamp: ${envelope.brokeredAt}`
  );
  assert.ok(brokered >= before - 1000 && brokered <= after + 1000);
});

test("brokerDecision honours an explicit now over the wall clock", () => {
  // `opts.now ?? Date.now()` — a mutant degrading ?? to a logical operator or
  // dropping the left side yields the wall clock instead of the injected one.
  const envelope = brokerDecision(projection, "approve", { now: NOW });
  assert.equal(envelope.brokeredAt, AT);
  assert.notEqual(envelope.brokeredAt, new Date(Date.now()).toISOString());
});

test("notifyDeepLink returns the exact content-free notification with the lane marker", () => {
  const notification = notifyDeepLink(
    { handle: "cap_9d2e", deepLink: "aios://asks/cap_9d2e" },
    { now: NOW }
  );
  assert.deepEqual(notification, {
    handle: "cap_9d2e",
    deepLink: "aios://asks/cap_9d2e",
    at: AT,
    lane: "notify-deep-link",
  });
});

test("notifyDeepLink journals exactly one content-free surface event on the fallback lane", () => {
  const journal = createInMemoryJournal();
  notifyDeepLink(
    { handle: "cap_9d2e", deepLink: "aios://asks/cap_9d2e" },
    { appendInboxEvent: journal.append, now: NOW }
  );
  assert.deepEqual(journal.events, [
    {
      kind: "user-intent",
      handle: "cap_9d2e",
      at: AT,
      data: { intent: "surface", lane: "notify-deep-link" },
    },
  ]);
  // Content-free means content-free: the deep link is for the notification the
  // human receives, never for the journal.
  assert.ok(!JSON.stringify(journal.events).includes("aios://asks/cap_9d2e"));
});

test("notifyDeepLink without a journal or clock still notifies with a valid timestamp", () => {
  const before = Date.now();
  const notification = notifyDeepLink({ handle: "h", deepLink: "aios://x" });
  const at = Date.parse(notification.at);
  assert.equal(notification.lane, "notify-deep-link");
  assert.ok(Number.isFinite(at) && at >= before - 1000 && at <= Date.now() + 1000);
});
