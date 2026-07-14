// Inbox identity seam (AIO-428) — reply PDP participant identity is I-06's real enriched-observation
// contract, not a local stub.
//
// The reply PDP's `ParticipantIdentity` now EXTENDS `AccountTenantIdentity` (exported from
// observations.ts); `isResolvedIdentityScope` is the one shared "resolved scope" predicate. This
// test drives `decideReply`/`evaluateReply` from IDENTITIES DERIVED FROM REAL enriched observations
// and their dual-read projection (`buildObservation` → `projectObservations`), proving the seam:
//   • the same address observed under two DISTINCT account/tenant scopes stays two distinct
//     identities all the way into the PDP roster — a recipient from scope B never matches a scope-A
//     thread (recipient-set expansion, never allow); and
//   • a legacy/unresolved projected participant (account/tenant unresolved, as a legacy-origin
//     projected item carries) is default-denied as an unknown participant.
//
// Runs against the compiled barrel (dist/operator-loop/index.js) — `npm run build:loop` first.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildObservation,
  projectObservations,
  isResolvedIdentityScope,
  decideReply,
  evaluateReply,
  createMemoryJournalSink,
  REPLY_RULE_IDS,
} from "../../dist/operator-loop/index.js";

// --- real observation fixtures ----------------------------------------------------------------

/** A real enriched observation of an email thread, with one participant at `address`. */
function obs(account, tenant, nativeId, address) {
  return buildObservation({
    connection_id: `gog:${account}`,
    account,
    tenant,
    object_kind: "email",
    native_id: nativeId,
    thread_id: nativeId,
    participants: [{ id: address, display: "Person", role: "from" }],
    snippet: "subject line",
  });
}

/** The legacy activity.jsonl twin — carries NO account/tenant (projects as a legacy-origin item). */
function legacyEmail(nativeId) {
  return {
    source: "email",
    tier: "admin",
    occurredAt: "2026-07-14T09:00:00.000Z",
    ref: `gmail:${nativeId}`,
    channel: null,
    direction: "inbound",
    summary: "Email needing reply",
  };
}

/** Build a reply-policy identity FROM a projected item (real account/tenant scope) + an address. */
function identityFromItem(item, address, verified = true) {
  return { account: item.account, tenant: item.tenant, address, verified };
}

const SHARED = "shared@corp.test"; // one address, observed under two scopes below
const THREAD_A = "THREAD-A";
const THREAD_B = "THREAD-B";

// Two DISTINCT account/tenant scopes observing the SAME address.
const projected = projectObservations({
  enriched: [
    obs("acct-A", "tenant-A", THREAD_A, SHARED),
    obs("acct-B", "tenant-B", THREAD_B, SHARED),
  ],
});
const itemA = [...projected.values()].find((i) => i.native_id === THREAD_A);
const itemB = [...projected.values()].find((i) => i.native_id === THREAD_B);

function threadCtxFromItem(item, address) {
  return {
    thread_ref: `gmail:${item.native_id}`,
    participants: [identityFromItem(item, address)],
    channel_type: "email",
  };
}

function replyRequest(item, recipients) {
  const thread_ref = `gmail:${item.native_id}`;
  return {
    thread_ref,
    evidence: [{ id: "e1", kind: "thread-message", origin_thread: thread_ref, tier: "admin" }],
    recipients,
    channel: { channel_type: "email", thread_ref },
    attachments: [],
    quoted_refs: [],
    delegations: [],
  };
}

function run(request, thread) {
  const sink = createMemoryJournalSink();
  const decision = decideReply(request, { thread, journal: sink });
  return { decision, sink };
}

// --- the fixtures are real (sanity) -----------------------------------------------------------

test("projection yields two distinct items for the same address in two account/tenant scopes", () => {
  assert.equal(projected.size, 2, "two scopes → two items, never collapsed");
  assert.ok(itemA && itemB, "both projected items resolved");
  assert.equal(itemA.account, "acct-A");
  assert.equal(itemB.account, "acct-B");
  // …but they carry the SAME channel address (the collision the scope keeps distinct).
  assert.equal(itemA.participants[0].id, SHARED);
  assert.equal(itemB.participants[0].id, SHARED);
});

// --- same address, distinct scopes stay distinct into the PDP ---------------------------------

test("same address in the reply's own scope is a verified participant → ALLOW", () => {
  const recipient = identityFromItem(itemA, SHARED);
  const { decision, sink } = run(replyRequest(itemA, [recipient]), threadCtxFromItem(itemA, SHARED));
  assert.equal(decision.verdict, "allow");
  assert.equal(decision.rule_id, REPLY_RULE_IDS.ALLOW_ORIGIN_CONFINED);
  assert.equal(sink.events.length, 1);
});

test("same address, WRONG account/tenant scope is NOT a thread participant → needs_promotion, never allow", () => {
  // Roster is scope A; the recipient is the SAME address resolved in scope B. Distinct identity.
  const recipientB = identityFromItem(itemB, SHARED);
  const { decision } = run(replyRequest(itemA, [recipientB]), threadCtxFromItem(itemA, SHARED));
  assert.notEqual(decision.verdict, "allow", "a cross-scope same-address recipient must never allow");
  assert.equal(decision.verdict, "needs_promotion");
  assert.equal(decision.rule_id, REPLY_RULE_IDS.DENY_RECIPIENT_EXPANSION);
});

test("the shared predicate agrees: both projected enriched scopes are resolved identities", () => {
  assert.equal(isResolvedIdentityScope(identityFromItem(itemA, SHARED)), true);
  assert.equal(isResolvedIdentityScope(identityFromItem(itemB, SHARED)), true);
  // A cross-scope recipient is resolved yet still not equal to the other scope's roster key —
  // resolution alone does not admit it; only the (account, tenant, address) triple does.
});

// --- legacy / unresolved participants default-deny --------------------------------------------

test("a legacy-origin projected participant has an UNRESOLVED scope (account/tenant null)", () => {
  const legacyProjected = projectObservations({ legacy: [legacyEmail("LEGACY-1")] });
  const [legacyItem] = [...legacyProjected.values()];
  assert.equal(legacyItem.origin, "legacy");
  assert.equal(legacyItem.account, null);
  assert.equal(legacyItem.tenant, null);
  // The shared predicate rejects the unresolved scope.
  assert.equal(isResolvedIdentityScope(identityFromItem(legacyItem, SHARED)), false);
});

test("a legacy/unresolved participant as a recipient → default-deny (unknown participant)", () => {
  const legacyProjected = projectObservations({ legacy: [legacyEmail("LEGACY-1")] });
  const [legacyItem] = [...legacyProjected.values()];
  const legacyRecipient = identityFromItem(legacyItem, SHARED); // account/tenant = null
  const { decision, sink } = run(
    replyRequest(itemA, [legacyRecipient]),
    threadCtxFromItem(itemA, SHARED)
  );
  assert.equal(decision.verdict, "deny");
  assert.equal(decision.rule_id, REPLY_RULE_IDS.DENY_UNKNOWN_PARTICIPANT);
  assert.ok(decision.promotion_path, "denial names a promotion path");
  assert.equal(sink.events.length, 1);
});

test("an unresolved participant in the thread roster never becomes a verified target → recipient denied", () => {
  // The thread roster itself carries an unresolved (legacy) participant; a real recipient can't
  // match it, so origin-confinement can't be satisfied against a legacy roster entry.
  const unresolvedThread = {
    thread_ref: `gmail:${itemA.native_id}`,
    participants: [{ account: null, tenant: null, address: SHARED, verified: true }],
    channel_type: "email",
  };
  const recipient = identityFromItem(itemA, SHARED);
  const { decision } = run(replyRequest(itemA, [recipient]), unresolvedThread);
  assert.notEqual(decision.verdict, "allow", "a legacy roster entry never authorizes a reply");
  assert.equal(decision.rule_id, REPLY_RULE_IDS.DENY_RECIPIENT_EXPANSION);
});

// --- determinism holds through the seam -------------------------------------------------------

test("determinism: identity-seam decisions are pure (same request + thread → identical object)", () => {
  const req = replyRequest(itemA, [identityFromItem(itemB, SHARED)]);
  const thread = threadCtxFromItem(itemA, SHARED);
  assert.deepEqual(evaluateReply(req, thread), evaluateReply(req, thread));
});
