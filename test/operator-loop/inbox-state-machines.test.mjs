// Inbox state machines (I-02 / AIO-383) — the three orthogonal machines. Enumerates EVERY legal
// transition (accepted, version bumps) and EVERY illegal transition (rejected with a typed error),
// plus optimistic-version rejection, and the two domain-spec representability rulings: a reopened
// thread with a failed action, and a stale approval distinguishable from a denial.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MACHINES,
  ATTENTION_STATES,
  ACTION_STATES,
  SOURCE_STATES,
  applyTransition,
  initialValue,
  isLegalTransition,
  legalEdges,
  illegalEdges,
  IllegalTransitionError,
  OptimisticLockError,
  UnknownStateError,
  foldEvents,
} from "../../dist/operator-loop/index.js";

const MACHINE_NAMES = ["attention_state", "action_state", "source_state"];

test("every LEGAL transition is accepted and bumps the optimistic version by one", () => {
  for (const machine of MACHINE_NAMES) {
    const edges = legalEdges(machine);
    assert.ok(edges.length > 0, `${machine} has legal edges`);
    for (const [from, to] of edges) {
      const next = applyTransition(machine, { state: from, version: 3 }, to);
      assert.equal(next.state, to, `${machine}: ${from} → ${to} lands in ${to}`);
      assert.equal(next.version, 4, `${machine}: ${from} → ${to} bumps version`);
    }
  }
});

test("every ILLEGAL transition is rejected with a typed IllegalTransitionError", () => {
  for (const machine of MACHINE_NAMES) {
    const bad = illegalEdges(machine);
    assert.ok(bad.length > 0, `${machine} has illegal edges to reject`);
    for (const [from, to] of bad) {
      assert.equal(isLegalTransition(machine, from, to), false);
      assert.throws(
        () => applyTransition(machine, { state: from, version: 0 }, to),
        (e) => e instanceof IllegalTransitionError && e.from === from && e.to === to,
        `${machine}: ${from} → ${to} must be rejected`
      );
    }
  }
});

test("optimistic version: a stale expectedVersion is rejected BEFORE legality is checked", () => {
  // Pick a legal edge; supplying the wrong expectedVersion rejects even though the edge is legal.
  const [from, to] = legalEdges("attention_state")[0];
  assert.throws(
    () =>
      applyTransition("attention_state", { state: from, version: 5 }, to, { expectedVersion: 4 }),
    (e) => e instanceof OptimisticLockError && e.expected === 4 && e.actual === 5
  );
  // Correct expectedVersion passes.
  const ok = applyTransition("attention_state", { state: from, version: 5 }, to, {
    expectedVersion: 5,
  });
  assert.equal(ok.version, 6);
});

test("unknown states are rejected with UnknownStateError", () => {
  assert.throws(
    () => applyTransition("attention_state", { state: "banana", version: 0 }, "surfaced"),
    (e) => e instanceof UnknownStateError
  );
  assert.throws(
    () => applyTransition("attention_state", initialValue("attention_state"), "banana"),
    (e) => e instanceof UnknownStateError
  );
});

test("initial states + machine registry are the documented ones", () => {
  assert.equal(MACHINES.attention_state.initial, "unseen");
  assert.equal(MACHINES.action_state.initial, "none");
  assert.equal(MACHINES.source_state.initial, "active");
  assert.deepEqual([...ATTENTION_STATES].sort(), [
    "acknowledged",
    "archived",
    "resolved",
    "snoozed",
    "surfaced",
    "unseen",
  ]);
  // The domain-spec distinction: action carries BOTH `expired` (stale) and `denied`.
  assert.ok(ACTION_STATES.includes("expired"));
  assert.ok(ACTION_STATES.includes("denied"));
  assert.ok(SOURCE_STATES.includes("deleted"));
});

test("reopen is a transition, not a state: resolved/archived → surfaced are legal edges", () => {
  assert.equal(isLegalTransition("attention_state", "resolved", "surfaced"), true);
  assert.equal(isLegalTransition("attention_state", "archived", "surfaced"), true);
  // there is no `reopened` state
  assert.equal(ATTENTION_STATES.includes("reopened"), false);
});

test("a stale approval attempt is DISTINGUISHABLE from a denial", () => {
  const expired = applyTransition(
    "action_state",
    { state: "awaiting_approval", version: 0 },
    "expired"
  );
  const denied = applyTransition(
    "action_state",
    { state: "awaiting_approval", version: 0 },
    "denied"
  );
  assert.equal(expired.state, "expired");
  assert.equal(denied.state, "denied");
  assert.notEqual(expired.state, denied.state, "stale ≠ denial");
  // both can be re-proposed
  assert.equal(isLegalTransition("action_state", "expired", "proposed"), true);
  assert.equal(isLegalTransition("action_state", "denied", "proposed"), true);
});

// ── integration: a reopened thread with a failed action is representable via the fold ─────────────

function ev(seq, kind, correlation_id, payload) {
  return {
    schema_version: 2,
    id: `e${seq}`,
    seq,
    ts: `2026-07-14T00:00:${String(seq).padStart(2, "0")}.000Z`,
    kind,
    correlation_id,
    causation_id: null,
    payload,
  };
}

test("orthogonality: a reopened thread (attention=surfaced) with a failed action is representable", () => {
  const cid = "c1";
  const events = [
    ev(1, "observation-correlation", cid, { source: "email", native_id: "n1" }),
    ev(2, "user-intent", cid, { intent: "surface" }),
    // drive the action machine to `failed`
    ev(3, "user-intent", cid, { intent: "propose" }),
    ev(4, "user-intent", cid, { intent: "submit" }),
    ev(5, "pdp-decision", cid, { decision: "approve" }),
    ev(6, "action-attempt", cid, {}),
    ev(7, "outcome", cid, { result: "failed" }),
    // resolve then REOPEN the attention machine independently
    ev(8, "user-intent", cid, { intent: "resolve" }),
    ev(9, "user-intent", cid, { intent: "reopen" }),
  ];
  const state = foldEvents(events);
  assert.equal(state.warnings.length, 0, `no fold warnings: ${JSON.stringify(state.warnings)}`);
  const item = state.items.get(cid);
  assert.ok(item);
  assert.equal(item.attention.state, "surfaced", "attention reopened → surfaced");
  assert.equal(item.action.state, "failed", "action independently at failed");
  // versions advanced on both machines independently
  assert.ok(item.attention.version >= 3);
  assert.ok(item.action.version >= 4);
});

test("fold surfaces an illegal journal transition as a warning (never throws, never drops)", () => {
  const cid = "c2";
  const events = [
    ev(1, "observation-correlation", cid, { source: "email" }),
    // acknowledge before surfacing is illegal (unseen → acknowledged)
    ev(2, "user-intent", cid, { intent: "acknowledge" }),
  ];
  const state = foldEvents(events);
  assert.equal(
    state.items.get(cid).attention.state,
    "unseen",
    "illegal transition left state intact"
  );
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0].reason, /attention_state/);
});
