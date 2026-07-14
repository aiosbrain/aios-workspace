// Runtime-issued capability handle spike (I-03 / AIO-384, G2b) — EXIT proof.
//
// The two-authority split under test:
//   • coordinator side (compiled): brokerDecision / notifyDeepLink / createInMemoryJournal
//       imported from ../../dist/operator-loop/index.js
//   • owning-runtime side (durable store): issueHandle / consumeAndExecute / readCapabilities
//       imported from ../../gui/server/runtime-adapters/capability-store.mjs
//
// EXIT (verbatim from the spec): tamper rejection + replay-rejection-after-runtime-restart proven.
// Restart is simulated in-test by re-importing the store module with a fresh URL (a new module
// instance with zero in-memory state) and re-folding the durable NDJSON tombstone from disk.
//
// Run: node --test test/operator-loop/inbox-capability.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  brokerDecision,
  notifyDeepLink,
  createInMemoryJournal,
} from "../../dist/operator-loop/index.js";
import {
  issueHandle,
  consumeAndExecute,
  reconcile,
  readCapabilities,
  loadRecord,
  makeIssueRecord,
  retryEligibility,
  capabilityDigest,
  CAPABILITY_STORE_REL,
} from "../../gui/server/runtime-adapters/capability-store.mjs";
import {
  ws as fxWs,
  sampleRequest as fxRequest,
  brokeredFor,
  seedIssued,
  seedCrashWindow,
  mutatedValue,
  FIXTURE_IDENTITY,
  FIXTURE_AUDIENCE,
  FIXTURE_EPOCH,
} from "../../gui/server/runtime-adapters/__fixtures__/capability-fixtures.mjs";

const IDENTITY = "/repo/aios-workspace@feat/inbox";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-capability-"));
}
function sampleRequest(over = {}) {
  return {
    operation: "Bash",
    normalizedArgs: { command: "git status" },
    targetResources: ["cmd:git"],
    repoWorktreeIdentity: IDENTITY,
    ...over,
  };
}
// A fresh counter-backed executor: proves consume→execute happens EXACTLY once (0 on rejection).
function counter() {
  const c = { n: 0 };
  return { c, execute: () => (c.n += 1) };
}

test("round-trip: approve → consume → execute once → native-receipt journalled", () => {
  const root = ws();
  try {
    const journal = createInMemoryJournal();
    const { handle, displayProjection } = issueHandle(root, sampleRequest());

    const brokered = brokerDecision(displayProjection, "approve", {
      appendInboxEvent: journal.append,
    });
    // Coordinator never mutates request fields — it echoes the digest it was shown.
    assert.equal(brokered.digest, displayProjection.digest);

    const { c, execute } = counter();
    const receipt = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute,
      appendEvent: journal.append,
    });

    assert.equal(receipt.kind, "native-receipt");
    assert.equal(receipt.ok, true);
    assert.equal(c.n, 1, "executed exactly once");
    // journal saw user-intent, pdp-decision, and native-receipt.
    assert.deepEqual(
      journal.events.map((e) => e.kind),
      ["user-intent", "pdp-decision", "native-receipt"]
    );
    // durable tombstone on disk
    assert.equal(readCapabilities(root).get(handle).state, "consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXIT (a): tamper — a mutated digest is rejected before execution, counter stays 0", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");

    // Coordinator mutates the envelope's digest (e.g. tries to bind approval to different args).
    const tampered = {
      ...brokered,
      digest: capabilityDigest(sampleRequest({ normalizedArgs: { command: "rm -rf /" } })),
    };

    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, tampered, { identity: IDENTITY, execute });

    assert.equal(rej.kind, "rejected");
    assert.equal(rej.reason, "digest-mismatch");
    assert.equal(c.n, 0, "no execution on tamper");
    // The legitimate handle is NOT spent by a tamper attempt — a correct broker still consumes it.
    assert.equal(loadRecord(root, handle).state, "pending");
    const good = consumeAndExecute(root, handle, brokered, { identity: IDENTITY, execute });
    assert.equal(good.kind, "native-receipt");
    assert.equal(c.n, 1, "exactly-once after the correct broker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXIT (b): replay-after-runtime-restart — consumed handle rejected via durable tombstone", async () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");

    const first = counter();
    const r1 = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: first.execute,
    });
    assert.equal(r1.kind, "native-receipt");
    assert.equal(first.c.n, 1);

    // The tombstone must be a real, durable line on disk (not just in-memory state).
    const raw = readFileSync(path.join(root, CAPABILITY_STORE_REL), "utf8");
    assert.match(raw, /"op":"consume"/);

    // Simulate a FULL runtime restart: import a fresh module instance (zero in-memory state) and
    // re-fold the store from disk. The consumed tombstone must still reject a replay.
    const fresh = await import("../../gui/server/runtime-adapters/capability-store.mjs?restart=1");
    assert.equal(fresh.loadRecord(root, handle).state, "consumed", "tombstone survived restart");

    const second = counter();
    const r2 = fresh.consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: second.execute,
    });
    assert.equal(r2.kind, "rejected");
    assert.equal(r2.reason, "replay-consumed");
    assert.equal(second.c.n, 0, "no re-execution after restart replay");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deny → typed denial, handle spent (cannot later be approved)", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const journal = createInMemoryJournal();
    const brokered = brokerDecision(displayProjection, "deny", {
      appendInboxEvent: journal.append,
    });

    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute,
      appendEvent: journal.append,
    });
    assert.equal(rej.kind, "rejected");
    assert.equal(rej.reason, "denied");
    assert.equal(c.n, 0);

    // A denied handle is tombstoned — a later approve attempt replays into the tombstone.
    const approve = brokerDecision(displayProjection, "approve");
    const retry = consumeAndExecute(root, handle, approve, { identity: IDENTITY, execute });
    assert.equal(retry.reason, "replay-consumed");
    assert.equal(c.n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TTL expiry → expired, distinguishable from denial", () => {
  const root = ws();
  try {
    const t0 = Date.now();
    const { handle, displayProjection } = issueHandle(root, sampleRequest(), {
      now: t0,
      ttlMs: 1000,
    });
    const brokered = brokerDecision(displayProjection, "approve", { now: t0 });

    const later = t0 + 5000; // past TTL
    assert.equal(loadRecord(root, handle, later).state, "expired");

    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute,
      now: later,
    });
    assert.equal(rej.reason, "expired");
    assert.notEqual(rej.reason, "denied");
    assert.equal(c.n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity mismatch (wrong repo/worktree) is rejected, no execution", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");
    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, brokered, {
      identity: "/some/other/repo@main",
      execute,
    });
    assert.equal(rej.reason, "identity-mismatch");
    assert.equal(c.n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown handle is rejected", () => {
  const root = ws();
  try {
    const rej = consumeAndExecute(
      root,
      "not-a-real-handle",
      { handle: "not-a-real-handle", decision: "approve", digest: "x" },
      { identity: IDENTITY }
    );
    assert.equal(rej.reason, "unknown-handle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome_unknown: consumed-then-execute-throws is retry-flagged, still not re-executable", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");
    const boom = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: () => {
        throw new Error("side effect failed");
      },
    });
    assert.equal(boom.kind, "outcome");
    assert.equal(boom.outcome, "outcome_unknown");
    // Still consumed — a retry replays into the tombstone rather than double-executing.
    const retry = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: () => 1,
    });
    assert.equal(retry.reason, "replay-consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KILL fallback: notifyDeepLink is content-free and demoable standalone", () => {
  const journal = createInMemoryJournal();
  const n = notifyDeepLink(
    { handle: "h-123", deepLink: "aios://runtime/prompt/h-123" },
    { appendInboxEvent: journal.append }
  );

  assert.equal(n.lane, "notify-deep-link");
  assert.equal(n.handle, "h-123");
  assert.equal(n.deepLink, "aios://runtime/prompt/h-123");
  // Content-free: no operation / args / resources / summary ever cross this seam.
  assert.deepEqual(Object.keys(n).sort(), ["at", "deepLink", "handle", "lane"]);
  for (const forbidden of [
    "operation",
    "normalizedArgs",
    "args",
    "targetResources",
    "summary",
    "input",
  ]) {
    assert.equal(forbidden in n, false, `fallback payload must not carry ${forbidden}`);
  }
  // No capability store is touched by the fallback lane — it needs no durable consume.
  assert.equal(existsSync(path.join(tmpdir(), CAPABILITY_STORE_REL)), false);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// I-07 (AIO-388) — Capability fixture matrix.
//
// The seven adversarial fixture families the domain spec enumerates, hardening the I-03 round-trip into
// a defended contract. Every family is RED-GREEN: it fails against unhardened I-03 and passes against the
// hardening patches in capability-store.mjs (documented in the PR body). Two cross-cutting invariants:
//   • the FIELD-COVERAGE meta-test enumerates every persisted PendingApproval field so none ships unattacked;
//   • the EXECUTION-COUNTER meta-test proves every handle across the matrix executes exactly-once or zero.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// Execution ledger: every family records the side-effect count it observed for its handle(s). The final
// meta-test asserts every entry is 0 or 1 — no fixture in the whole matrix ever double-executes.
const EXEC_LEDGER = [];
const ledger = (family, handle, count) => void EXEC_LEDGER.push({ family, handle, count });

// ── Family 1: field mutation — every persisted field, one at a time, rejected before execution ──────
// The record schema is derived live, so a NEW field added to makeIssueRecord auto-enters the attack loop
// and the coverage meta-test below fails until it's accounted for.
const SCHEMA_FIELDS = Object.keys(makeIssueRecord(fxRequest()));
const FIELD_MUTATION_ATTACKED = new Set();

for (const field of SCHEMA_FIELDS) {
  test(`I-07 family 1 (field mutation): '${field}' tampered on disk → rejected, counter 0`, () => {
    // Seed a store whose issue line has ONE field mutated but the ORIGINAL integrity + digest intact —
    // modelling an attacker who edits the durable record yet cannot forge its issue-time hash.
    const { root, record } = seedIssued(fxRequest(), {
      mutate: (r) => {
        r[field] = mutatedValue(field, r[field]);
      },
    });
    try {
      const brokered = brokeredFor(record); // human-approved handle + digest
      const { c, execute } = counter();
      // Deliberately pass NO identity/audience/epoch so integrity is the SOLE gate under test for each
      // field (identity/audience/epoch mutations are also caught by their own families' checks).
      const r = consumeAndExecute(root, record.handle, brokered, { execute });
      assert.notEqual(r.kind, "native-receipt", `mutating '${field}' must not execute`);
      assert.equal(c.n, 0, `mutating '${field}' executed the side effect`);
      FIELD_MUTATION_ATTACKED.add(field);
      ledger("family1", record.handle, c.n);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("I-07 meta (field coverage): every persisted PendingApproval field is attacked by family 1", () => {
  assert.deepEqual(
    [...FIELD_MUTATION_ATTACKED].sort(),
    [...SCHEMA_FIELDS].sort(),
    "a persisted field escaped the field-mutation family — add it to the attack matrix"
  );
  // Hard floor: the security-critical fields MUST be part of the schema (guards against silently
  // dropping a field from makeIssueRecord and thereby from coverage).
  for (const required of [
    "operation",
    "normalizedArgs",
    "targetResources",
    "repoWorktreeIdentity",
    "requestDigest",
    "expiresAt",
    "audience",
    "idempotency",
    "epoch",
    "integrity",
  ]) {
    assert.ok(SCHEMA_FIELDS.includes(required), `record schema is missing '${required}'`);
  }
});

// ── Family 2: issuer / audience / session substitution ──────────────────────────────────────────────
test("I-07 family 2 (substitution): a handle issued by runtime A presented to runtime B → unknown-handle", () => {
  const a = seedIssued(fxRequest()); // runtime A's durable store
  const rootB = fxWs(); // a DIFFERENT runtime's store — never saw this handle
  try {
    const { c, execute } = counter();
    const r = consumeAndExecute(rootB, a.record.handle, brokeredFor(a.record), {
      identity: FIXTURE_IDENTITY,
      execute,
    });
    assert.equal(r.reason, "unknown-handle");
    assert.equal(c.n, 0);
    ledger("family2-issuer", a.record.handle, c.n);
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("I-07 family 2 (substitution): a decision brokered for session X consumed in session Y → audience-mismatch", () => {
  const { root, record } = seedIssued(fxRequest({ audience: FIXTURE_AUDIENCE }));
  try {
    const brokered = brokeredFor(record);
    const { c, execute } = counter();
    // Same valid handle + digest, presented under a DIFFERENT session.
    const r = consumeAndExecute(root, record.handle, brokered, {
      identity: FIXTURE_IDENTITY,
      audience: "runtime-B/session-Y",
      execute,
    });
    assert.equal(r.kind, "rejected");
    assert.equal(r.reason, "audience-mismatch");
    assert.equal(r.expected, FIXTURE_AUDIENCE);
    assert.equal(c.n, 0, "cross-session substitution must not execute");
    // The CORRECT session still consumes exactly once — the binding is precise, not a blanket block.
    const good = consumeAndExecute(root, record.handle, brokered, {
      identity: FIXTURE_IDENTITY,
      audience: FIXTURE_AUDIENCE,
      execute,
    });
    assert.equal(good.kind, "native-receipt");
    assert.equal(c.n, 1);
    ledger("family2-session", record.handle, c.n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Family 3: crash after consume, before action ────────────────────────────────────────────────────
test("I-07 family 3 (crash after consume, before action): surfaced as outcome_unknown, never silent re-exec", () => {
  const { root, record } = seedCrashWindow(fxRequest({ idempotency: "at-most-once" }));
  try {
    const brokered = brokeredFor(record);
    const { c, execute } = counter();
    // A naive re-consume of a crash-window record must NOT silently re-run and must NOT hide it as a flat
    // replay — it surfaces the unknown outcome with the retry plan its idempotency class dictates.
    const r = consumeAndExecute(root, record.handle, brokered, {
      identity: FIXTURE_IDENTITY,
      execute,
    });
    assert.equal(r.kind, "outcome");
    assert.equal(r.outcome, "outcome_unknown");
    assert.equal(r.crashWindow, true);
    assert.deepEqual(r.retry, retryEligibility("at-most-once"));
    assert.equal(c.n, 0, "no silent re-execution across the crash window");
    // at-most-once → reconcile refuses to auto-retry; still zero executions.
    const rec = reconcile(root, record.handle, { queryNativeReceipt: () => null, execute });
    assert.equal(rec.outcome, "outcome_unknown");
    assert.equal(rec.requires, "human-reapproval");
    assert.equal(c.n, 0);
    ledger("family3", record.handle, c.n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Family 4: crash after action, before receipt ────────────────────────────────────────────────────
test("I-07 family 4 (crash after action, before receipt): reconcile resolves via native receipt, no re-exec", () => {
  const { root, record } = seedCrashWindow(fxRequest({ idempotency: "reconcile-first" }));
  try {
    const { c, execute } = counter();
    const nativeReceipt = { ran: true, id: "native-abc" };
    // The action DID run; the channel provides a native receipt. Reconcile emits outcome_unknown then
    // resolves via that receipt — it must NOT re-execute the already-run side effect.
    const r = reconcile(root, record.handle, { queryNativeReceipt: () => nativeReceipt, execute });
    assert.equal(r.outcome, "resolved-native");
    assert.equal(r.via, "native-receipt");
    assert.deepEqual(r.nativeReceipt, nativeReceipt);
    assert.equal(c.n, 0, "reconcile must not re-run an action the channel confirms already ran");
    // Durably resolved now — a later consume is a flat replay, not another crash window.
    const replay = consumeAndExecute(root, record.handle, brokeredFor(record), {
      identity: FIXTURE_IDENTITY,
      execute,
    });
    assert.equal(replay.reason, "replay-consumed");
    assert.equal(replay.outcome, "resolved-native");
    assert.equal(c.n, 0);
    ledger("family4", record.handle, c.n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Family 5: outcome_unknown + idempotency-class retry ─────────────────────────────────────────────
test("I-07 family 5 (idempotency-class retry): the class dictates retry, never a guess", () => {
  // Pure policy: retry eligibility derives from the class alone; an unknown class defaults to the safest.
  assert.deepEqual(retryEligibility("safe-retry"), { retryable: true, action: "re-execute" });
  assert.deepEqual(retryEligibility("reconcile-first"), {
    retryable: true,
    action: "reconcile-channel",
  });
  assert.deepEqual(retryEligibility("at-most-once"), {
    retryable: false,
    action: "human-reapproval",
  });
  assert.deepEqual(retryEligibility("bogus"), { retryable: false, action: "human-reapproval" });

  // safe-retry: the action never ran, so reconcile re-executes — the FIRST and only execution.
  const sr = seedCrashWindow(fxRequest({ idempotency: "safe-retry" }));
  const srC = counter();
  const rSr = reconcile(sr.root, sr.record.handle, { execute: srC.execute });
  assert.equal(rSr.outcome, "re-executed");
  assert.equal(srC.c.n, 1, "safe-retry re-executes exactly once");
  const rSr2 = reconcile(sr.root, sr.record.handle, { execute: srC.execute });
  assert.equal(rSr2.alreadyResolved, true, "re-executed record is now terminal");
  assert.equal(srC.c.n, 1, "no second execution");
  ledger("family5-safe-retry", sr.record.handle, srC.c.n);

  // at-most-once: reconcile refuses to auto-retry — a human must re-approve.
  const am = seedCrashWindow(fxRequest({ idempotency: "at-most-once" }));
  const amC = counter();
  const rAm = reconcile(am.root, am.record.handle, { execute: amC.execute });
  assert.equal(rAm.requires, "human-reapproval");
  assert.equal(amC.c.n, 0, "at-most-once never auto-re-executes");
  ledger("family5-at-most-once", am.record.handle, amC.c.n);

  // reconcile-first: query the channel first; no native receipt → stays unknown, no execution.
  const rf = seedCrashWindow(fxRequest({ idempotency: "reconcile-first" }));
  const rfC = counter();
  const rRf = reconcile(rf.root, rf.record.handle, {
    queryNativeReceipt: () => null,
    execute: rfC.execute,
  });
  assert.equal(rRf.outcome, "outcome_unknown");
  assert.equal(rRf.action, "reconcile-channel");
  assert.equal(rfC.c.n, 0, "reconcile-first queries the channel, it does not execute");
  ledger("family5-reconcile-first", rf.record.handle, rfC.c.n);

  for (const r of [sr.root, am.root, rf.root]) rmSync(r, { recursive: true, force: true });
});

// ── Family 6: rotation ──────────────────────────────────────────────────────────────────────────────
test("I-07 family 6 (rotation): a handle issued under an old key/session epoch is rejected, TYPED", () => {
  const { root, record } = seedIssued(fxRequest({ epoch: FIXTURE_EPOCH }));
  try {
    const brokered = brokeredFor(record);
    const { c, execute } = counter();
    // Key/session rotated between issue and consume — current epoch differs from the issued one.
    const r = consumeAndExecute(root, record.handle, brokered, {
      identity: FIXTURE_IDENTITY,
      epoch: "key-epoch-2",
      execute,
    });
    assert.equal(r.kind, "rejected");
    assert.equal(
      r.reason,
      "rotation-superseded",
      "must be a typed rotation error, not generic failure"
    );
    assert.equal(r.issuedEpoch, FIXTURE_EPOCH);
    assert.equal(c.n, 0);
    // Same (un-rotated) epoch still consumes exactly once.
    const good = consumeAndExecute(root, record.handle, brokered, {
      identity: FIXTURE_IDENTITY,
      epoch: FIXTURE_EPOCH,
      execute,
    });
    assert.equal(good.kind, "native-receipt");
    assert.equal(c.n, 1);
    ledger("family6", record.handle, c.n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Family 7: replay (before AND after restart) ─────────────────────────────────────────────────────
test("I-07 family 7 (replay): consumed handle rejected before and after restart, exactly-once preserved", async () => {
  const root = fxWs();
  try {
    const { handle, displayProjection } = issueHandle(root, fxRequest());
    const brokered = brokerDecision(displayProjection, "approve");
    const { c, execute } = counter();
    const first = consumeAndExecute(root, handle, brokered, {
      identity: FIXTURE_IDENTITY,
      execute,
    });
    assert.equal(first.kind, "native-receipt");
    assert.equal(c.n, 1);

    // Replay BEFORE restart (same in-memory module instance).
    const beforeRestart = consumeAndExecute(root, handle, brokered, {
      identity: FIXTURE_IDENTITY,
      execute,
    });
    assert.equal(beforeRestart.reason, "replay-consumed");
    assert.equal(c.n, 1, "no re-execution on in-process replay");

    // Replay AFTER restart: a fresh module instance re-folds the durable tombstone + receipt from disk.
    const fresh = await import("../../gui/server/runtime-adapters/capability-store.mjs?fam7=1");
    const afterRestart = fresh.consumeAndExecute(root, handle, brokered, {
      identity: FIXTURE_IDENTITY,
      execute,
    });
    assert.equal(afterRestart.reason, "replay-consumed");
    assert.equal(c.n, 1, "no re-execution on post-restart replay");
    ledger("family7", handle, c.n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Meta: execution counter across the whole matrix ─────────────────────────────────────────────────
test("I-07 meta (execution counter): every handle across the matrix executes exactly-once or zero", () => {
  assert.ok(EXEC_LEDGER.length >= SCHEMA_FIELDS.length + 6, "ledger did not capture every family");
  for (const e of EXEC_LEDGER) {
    assert.ok(
      e.count === 0 || e.count === 1,
      `${e.family}/${e.handle}: executed ${e.count}× (matrix invariant: exactly-once or zero)`
    );
  }
  // Every family (1..7) contributed at least one observation.
  for (const n of ["family1", "family2", "family3", "family4", "family5", "family6", "family7"]) {
    assert.ok(
      EXEC_LEDGER.some((e) => e.family.startsWith(n)),
      `${n} missing from the execution ledger`
    );
  }
});
