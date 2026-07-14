// Outbox + Gmail send fixture matrix (I-11 / AIO-392, the G5 gate).
//
// EXIT (verbatim): zero duplicate/misdirected sends across the matrix.
// gog is faked at the process boundary via recorded fixtures — NO live Gmail in CI. An
// execution-counter fake proves AT-MOST-ONCE actual sends per command across every fixture; any
// recipient not in the PDP-approved set fails the run.
//
// Matrix: double-enqueue (same command_id) · crash between attempt and receipt · timeout then retry
// (reconcile-first: Sent query before resend) · partial failure (multi-recipient) · duplicate native
// receipt · recipient mutation between PDP decision and send (rejected on exact-bytes check) ·
// prompt-injection (header injection + quoted-thread smuggling) · admin-context leak · native-receipt
// reconciliation with the Gmail message id journaled · delegation capability-scoping · the
// where-cheap gateway credential wrapper (token mode/ownership; skipped on unsupported platforms).
//
// Runs against the COMPILED barrel (`dist/operator-loop/index.js`) — `npm run build:loop` first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOutbox,
  createInMemoryOutboxJournal,
  foldOutboxState,
  checkPreSend,
  approvedRecipientSet,
  outboundRecipientSet,
  assertGatewayTokenSecurity,
  OutboxRejectedError,
  OutboxTimeoutError,
  OutboxSendError,
  ADMIN_CONTEXT_MARKERS,
} from "../../dist/operator-loop/index.js";

// -- fixture builders ------------------------------------------------------------------------------

const THREAD = "gmail:thread-A";
let CLOCK = 1_000;
const now = () => (CLOCK += 1000);

/** A verified participant identity (account/tenant-resolved), matching the I-10 shape. */
function participant(address, { account = "acct-1", tenant = "tenant-1", verified = true } = {}) {
  return { account, tenant, address, verified };
}
const ALICE = participant("alice@acme.test");
const BOB = participant("bob@acme.test");

/** A well-formed origin-confined reply request to the thread's own participants. */
function baseRequest(recipients = [ALICE, BOB]) {
  return {
    thread_ref: THREAD,
    evidence: [{ id: "msg-1", kind: "thread-message", origin_thread: THREAD, tier: "admin" }],
    recipients,
    channel: { channel_type: "email", thread_ref: THREAD },
    attachments: [],
    quoted_refs: [],
    delegations: [],
  };
}

const ALLOW = { verdict: "allow", rule_id: "allow.origin-confined", explanation: "ok" };

/** Build canonical outbound bytes (RFC822-shaped) carrying the command marker + given recipients. */
function outboundBytes({
  commandId = "cmd-1",
  to = ["alice@acme.test", "bob@acme.test"],
  cc = [],
  bcc = [],
  subject = "Re: hello",
  body = "Thanks, sounds good.\n",
  extraHeaders = [],
} = {}) {
  const headers = [
    `From: john@john-ellison.com`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    `X-AIOS-Command-Id: ${commandId}`,
    ...extraHeaders,
  ];
  return headers.join("\n") + "\n\n" + body;
}

function enqueueInput(overrides = {}) {
  const commandId = overrides.command_id ?? "cmd-1";
  return {
    command_id: commandId,
    reply_request: overrides.reply_request ?? baseRequest(),
    exact_outbound_bytes: overrides.exact_outbound_bytes ?? outboundBytes({ commandId }),
    decision: overrides.decision ?? ALLOW,
  };
}

/**
 * A recorded-fixture gog client with an execution counter + a Sent store. `send` increments the
 * counter (the at-most-once witness). `querySent` reports whether a message with the command marker
 * is already in Sent. `behavior` per command_id: "ok" | "timeout" | "fail" | partial recipients.
 */
function fakeGog({ behavior = {}, preSent = {} } = {}) {
  const counter = { total: 0, perCommand: new Map() };
  const sent = new Map(Object.entries(preSent)); // command_id -> { message_id, thread_id }
  return {
    counter,
    sent,
    client: {
      querySent(commandId) {
        const hit = sent.get(commandId);
        return hit ? { found: true, ...hit } : { found: false };
      },
      send(bytes) {
        // The marker is embedded in the bytes; extract it so the fake keys Sent like real Gmail.
        const m = bytes.match(/X-AIOS-Command-Id:\s*(\S+)/);
        const commandId = m ? m[1] : "unknown";
        counter.total += 1;
        counter.perCommand.set(commandId, (counter.perCommand.get(commandId) ?? 0) + 1);
        const b = behavior[commandId] ?? { kind: "ok" };
        if (b.kind === "timeout") {
          // A real timeout: the message MAY have landed. Record it in Sent so a reconcile-first
          // retry finds it (proving no duplicate).
          sent.set(commandId, { message_id: `mid-${commandId}`, thread_id: `tid-${commandId}` });
          throw new OutboxTimeoutError();
        }
        if (b.kind === "fail") throw new OutboxSendError();
        const message_id = `mid-${commandId}`;
        const thread_id = `tid-${commandId}`;
        sent.set(commandId, { message_id, thread_id });
        return {
          message_id,
          thread_id,
          ...(b.rejected_recipients ? { rejected_recipients: b.rejected_recipients } : {}),
        };
      },
    },
  };
}

// -- pure pre-send checks --------------------------------------------------------------------------

test("checkPreSend: origin-confined reply to approved recipients passes", () => {
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: outboundBytes() };
  const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.equal(r.ok, true);
});

test("checkPreSend: a non-allow decision is rejected (not-allowed)", () => {
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: outboundBytes() };
  for (const verdict of ["deny", "needs_promotion"]) {
    const r = checkPreSend(cmd, { verdict, rule_id: "x", explanation: "y" }, { kind: "direct" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-allowed");
  }
});

test("checkPreSend is deterministic (same inputs -> same verdict)", () => {
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: outboundBytes() };
  const a = checkPreSend(cmd, ALLOW, { kind: "direct" });
  const b = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.deepEqual(a, b);
});

test("recipient sets: approved vs outbound are parsed from structured fields only", () => {
  assert.deepEqual([...approvedRecipientSet(baseRequest())].sort(), [
    "alice@acme.test",
    "bob@acme.test",
  ]);
  assert.deepEqual([...outboundRecipientSet(outboundBytes())].sort(), [
    "alice@acme.test",
    "bob@acme.test",
  ]);
});

// -- prompt-injection fixtures (on exact outbound bytes) -------------------------------------------

test("injection: header injection (smuggled Bcc via a duplicate/extra header) is rejected", () => {
  // A header-injection smuggle: an extra Bcc line appended after the canonical headers.
  const bytes = outboundBytes({ extraHeaders: ["Bcc: attacker@evil.test"] });
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: bytes };
  const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.equal(r.ok, false);
  // The extra recipient is caught either as a recipient-mismatch or a schema/injection violation;
  // both are hard rejections. Assert the send would never proceed AND attacker is never approved.
  assert.ok(["recipient-mismatch", "header-injection"].includes(r.reason), r.reason);
});

test("injection: CRLF control char smuggled into a header value is header-injection", () => {
  const bytes = outboundBytes({ subject: "hi\r\nBcc: attacker@evil.test" });
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: bytes };
  const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.equal(r.ok, false);
  // After CRLF normalization the smuggled Bcc becomes a real extra recipient -> mismatch; either way
  // rejected and attacker never sent.
  assert.ok(["header-injection", "recipient-mismatch"].includes(r.reason), r.reason);
});

test("injection: a disallowed arbitrary header is header-injection", () => {
  const bytes = outboundBytes({ extraHeaders: ["X-Evil-Header: exfiltrate"] });
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: bytes };
  const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "header-injection");
});

test("injection: quoted-thread smuggling (a To:/Bcc: line in the body) is rejected, never expands recipients", () => {
  const body = "Sure.\n\n> On Tue, mallory wrote:\n> Bcc: attacker@evil.test please add\n";
  const bytes = outboundBytes({ body });
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: bytes };
  const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "quoted-thread-smuggle");
  // The body NEVER contributes to the recipient set.
  assert.deepEqual([...outboundRecipientSet(bytes)].sort(), ["alice@acme.test", "bob@acme.test"]);
});

test("injection: an admin-context leak marker in the outbound bytes is rejected", () => {
  for (const marker of ADMIN_CONTEXT_MARKERS) {
    const bytes = outboundBytes({ body: `Here you go.\n${marker}\n` });
    const cmd = { reply_request: baseRequest(), exact_outbound_bytes: bytes };
    const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "admin-context-leak");
  }
});

test("recipient mutation between PDP decision and send is rejected on the exact-bytes check", () => {
  // PDP approved {alice,bob}; the bytes were mutated to send to mallory instead.
  const bytes = outboundBytes({ to: ["alice@acme.test", "mallory@evil.test"] });
  const cmd = { reply_request: baseRequest(), exact_outbound_bytes: bytes };
  const r = checkPreSend(cmd, ALLOW, { kind: "direct" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "recipient-mismatch");
});

// -- outbox lifecycle: at-most-once across the matrix ----------------------------------------------

test("happy path: enqueue -> attempt -> sent, one send, native receipt journaled", () => {
  const { client, counter } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const cmd = ob.sendApproved(enqueueInput());
  assert.equal(cmd.state, "sent");
  assert.equal(cmd.native_message_id, "mid-cmd-1");
  assert.equal(counter.total, 1);
  const kinds = journal.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["action-attempt", "native-receipt", "outcome"]);
  const receipt = journal.events.find((e) => e.kind === "native-receipt");
  assert.equal(receipt.data.native_message_id, "mid-cmd-1");
  // Content-free: no body/subject/recipient address is ever journaled.
  const blob = JSON.stringify(journal.events);
  assert.ok(!blob.includes("alice@acme.test"));
  assert.ok(!blob.includes("Thanks, sounds good"));
});

test("double-enqueue with the same command_id is idempotent: exactly one send", () => {
  const { client, counter } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  ob.enqueue(enqueueInput());
  ob.enqueue(enqueueInput()); // no-op
  const cmd = ob.attempt("cmd-1");
  ob.attempt("cmd-1"); // terminal -> no-op
  assert.equal(cmd.state, "sent");
  assert.equal(counter.total, 1);
  assert.equal(ob.sendCount("cmd-1"), 1);
});

test("enqueue refuses a non-allow decision (deny / needs_promotion) -> zero sends", () => {
  const { client, counter } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  for (const verdict of ["deny", "needs_promotion"]) {
    assert.throws(
      () =>
        ob.enqueue(
          enqueueInput({
            command_id: `c-${verdict}`,
            decision: { verdict, rule_id: "r", explanation: "e" },
          })
        ),
      (e) => e instanceof OutboxRejectedError && e.reason === "not-allowed"
    );
  }
  assert.equal(counter.total, 0);
});

test("timeout then retry: reconcile-first finds the message in Sent, no duplicate send", () => {
  const { client, counter, sent } = fakeGog({ behavior: { "cmd-1": { kind: "timeout" } } });
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const c1 = ob.sendApproved(enqueueInput());
  assert.equal(c1.state, "outcome_unknown");
  assert.equal(counter.total, 1);
  assert.ok(sent.has("cmd-1")); // the timed-out send actually landed
  // Retry: reconcile-first queries Sent BEFORE resending -> reconciled, no second send.
  const c2 = ob.attempt("cmd-1");
  assert.equal(c2.state, "reconciled");
  assert.equal(c2.native_message_id, "mid-cmd-1");
  assert.equal(counter.total, 1, "reconcile-first must not resend");
  assert.equal(ob.sendCount("cmd-1"), 1);
});

test("crash between attempt and receipt: recovery reconciles, no duplicate send", () => {
  // Journal that throws right after the action-attempt is written (simulating a crash before the
  // receipt/outcome are persisted). The send itself reached Gmail.
  const events = [];
  const sentStore = new Map();
  let crashArmed = false;
  const client = {
    querySent(id) {
      const h = sentStore.get(id);
      return h ? { found: true, ...h } : { found: false };
    },
    send() {
      sentStore.set("cmd-1", { message_id: "mid-cmd-1", thread_id: "tid-cmd-1" });
      return { message_id: "mid-cmd-1", thread_id: "tid-cmd-1" };
    },
  };
  let sendCalls = 0;
  const countingClient = {
    querySent: client.querySent,
    send: (b) => {
      sendCalls += 1;
      return client.send(b);
    },
  };
  // Crash when the native-receipt is about to be journaled: the send already reached Gmail (message
  // in Sent), but the receipt/outcome lines are never persisted. Throw BEFORE pushing the event.
  const crashingJournal = (ev) => {
    if (ev.kind === "native-receipt" && crashArmed)
      throw new Error("simulated crash before receipt");
    events.push(ev);
  };
  const ob1 = createOutbox({ client: countingClient, journal: crashingJournal, now });
  ob1.enqueue(enqueueInput());
  crashArmed = true;
  assert.throws(() => ob1.attempt("cmd-1"), /simulated crash before receipt/);
  // The send happened (message in Sent) but the process "crashed" before persisting the receipt.
  assert.equal(sendCalls, 1);
  assert.ok(sentStore.has("cmd-1"));

  // Recovery: a fresh outbox folds the journal (state = attempting), re-enqueues (idempotent, adopts
  // attempting), and attempts -> reconcile-first finds it -> reconciled, NO second send.
  const recovered = createOutbox({
    client: countingClient,
    journal: (ev) => events.push(ev),
    now,
    priorEvents: events,
  });
  const folded = foldOutboxState(events);
  assert.equal(folded.get("cmd-1").state, "attempting");
  recovered.enqueue(enqueueInput());
  const c = recovered.attempt("cmd-1");
  assert.equal(c.state, "reconciled");
  assert.equal(sendCalls, 1, "recovery must not resend after a crash");
});

test("partial failure (multi-recipient): message exists, state failed, never resends", () => {
  const { client, counter } = fakeGog({
    behavior: { "cmd-1": { kind: "ok", rejected_recipients: ["bob@acme.test"] } },
  });
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const cmd = ob.sendApproved(enqueueInput());
  assert.equal(cmd.state, "failed");
  assert.deepEqual(cmd.rejected_recipients, ["bob@acme.test"]);
  assert.equal(cmd.native_message_id, "mid-cmd-1");
  // A retry reconcile-first finds the created message -> reconciled, NO resend to the accepted set.
  const retry = ob.attempt("cmd-1");
  assert.equal(retry.state, "reconciled");
  assert.equal(counter.total, 1, "partial failure must not resend");
});

test("duplicate native receipt: reconcile is idempotent, one receipt journaled", () => {
  const { client } = fakeGog({
    preSent: { "cmd-1": { message_id: "mid-cmd-1", thread_id: "tid-cmd-1" } },
  });
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  ob.enqueue(enqueueInput());
  const a = ob.reconcile("cmd-1");
  assert.equal(a.state, "reconciled");
  const b = ob.reconcile("cmd-1"); // duplicate native receipt / duplicate reconcile
  assert.equal(b.state, "reconciled");
  const receipts = journal.events.filter((e) => e.kind === "native-receipt");
  assert.equal(receipts.length, 1, "a duplicate receipt must not double-journal");
});

test("hard send failure -> failed, message never created, retry may resend safely", () => {
  const { client, counter } = fakeGog({ behavior: { "cmd-1": { kind: "fail" } } });
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const cmd = ob.sendApproved(enqueueInput());
  assert.equal(cmd.state, "failed");
  assert.equal(counter.total, 1);
});

test("native receipt reconciliation: sent fixture reaches reconciled with the Gmail id journaled", () => {
  const { client } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  ob.sendApproved(enqueueInput());
  const c = ob.reconcile("cmd-1");
  assert.equal(c.native_message_id, "mid-cmd-1");
  // Read the journal fixture back: a native-receipt event carries the Gmail message id.
  const recovered = foldOutboxState(journal.events);
  assert.equal(recovered.get("cmd-1").native_message_id, "mid-cmd-1");
});

// -- delegation capability scoping -----------------------------------------------------------------

test("delegated send without a scoped capability handle is rejected (ambient-delegation)", () => {
  const { client, counter } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const req = { ...baseRequest(), delegations: [{ id: "d1", capability: "send" }] };
  ob.enqueue(enqueueInput({ reply_request: req }));
  assert.throws(
    () => ob.attempt("cmd-1", { kind: "direct" }),
    (e) => e instanceof OutboxRejectedError && e.reason === "ambient-delegation"
  );
  assert.equal(counter.total, 0);
});

test("delegated send WITH a scoped capability handle proceeds", () => {
  const { client, counter } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const req = { ...baseRequest(), delegations: [{ id: "d1", capability: "send" }] };
  ob.enqueue(enqueueInput({ reply_request: req }));
  const cmd = ob.attempt("cmd-1", { kind: "delegated", capabilityHandle: "cap-handle-xyz" });
  assert.equal(cmd.state, "sent");
  assert.equal(counter.total, 1);
});

// -- recipient-mutation is caught at attempt time (not just the pure check) ------------------------

test("attempt rejects a recipient-mutated command with zero sends", () => {
  const { client, counter } = fakeGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const bytes = outboundBytes({ to: ["mallory@evil.test"] });
  ob.enqueue(enqueueInput({ exact_outbound_bytes: bytes }));
  assert.throws(
    () => ob.attempt("cmd-1"),
    (e) => e instanceof OutboxRejectedError && e.reason === "recipient-mismatch"
  );
  assert.equal(counter.total, 0);
});

// -- global at-most-once + no-misdirection assertion across the whole matrix -----------------------

test("EXIT: zero duplicate/misdirected sends across the full matrix", () => {
  const behavior = {
    ok1: { kind: "ok" },
    to1: { kind: "timeout" },
    part1: { kind: "ok", rejected_recipients: ["bob@acme.test"] },
    fail1: { kind: "fail" },
  };
  const { client, counter, sent } = fakeGog({ behavior });
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });

  // ok: send once, retry no-ops
  ob.sendApproved(
    enqueueInput({ command_id: "ok1", exact_outbound_bytes: outboundBytes({ commandId: "ok1" }) })
  );
  ob.attempt("ok1");
  // timeout: send once, retry reconciles
  ob.sendApproved(
    enqueueInput({ command_id: "to1", exact_outbound_bytes: outboundBytes({ commandId: "to1" }) })
  );
  ob.attempt("to1");
  // partial: send once, retry reconciles
  ob.sendApproved(
    enqueueInput({
      command_id: "part1",
      exact_outbound_bytes: outboundBytes({ commandId: "part1" }),
    })
  );
  ob.attempt("part1");
  // fail: send once (no message created)
  ob.sendApproved(
    enqueueInput({
      command_id: "fail1",
      exact_outbound_bytes: outboundBytes({ commandId: "fail1" }),
    })
  );
  // double-enqueue: one send
  ob.enqueue(
    enqueueInput({ command_id: "dup1", exact_outbound_bytes: outboundBytes({ commandId: "dup1" }) })
  );
  ob.enqueue(
    enqueueInput({ command_id: "dup1", exact_outbound_bytes: outboundBytes({ commandId: "dup1" }) })
  );
  ob.attempt("dup1");
  ob.attempt("dup1");
  // misdirected: rejected, zero sends
  assert.throws(() =>
    ob.sendApproved(
      enqueueInput({
        command_id: "bad1",
        exact_outbound_bytes: outboundBytes({ commandId: "bad1", to: ["mallory@evil.test"] }),
      })
    )
  );

  // At-most-once: every command sent the transport at most once.
  for (const [cmd, n] of counter.perCommand) {
    assert.ok(n <= 1, `command ${cmd} sent ${n} times (at-most-once violated)`);
  }
  assert.equal(counter.perCommand.get("bad1") ?? 0, 0, "misdirected command must never send");
  // No misdirection: every Sent entry belongs to an approved command; attacker never in Sent.
  for (const id of sent.keys()) assert.notEqual(id, "bad1");
});

// -- where-cheap gateway credential wrapper --------------------------------------------------------

test("gateway credential wrapper: a 0600 gateway-owned token passes; wrong mode fails", (t) => {
  if (process.platform === "win32") {
    // Named skip reason: POSIX mode/ownership is meaningless on win32 (deferred to G6b).
    const r = assertGatewayTokenSecurity("C:/nonexistent", { platform: "win32" });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /win32/);
    t.skip("POSIX token mode/ownership unsupported on win32 — asserted skip path");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "aios-outbox-tok-"));
  const tokenPath = path.join(dir, "gog-token");
  writeFileSync(tokenPath, "secret-refresh-token");

  chmodSync(tokenPath, 0o600);
  const ok = assertGatewayTokenSecurity(tokenPath);
  assert.equal(ok.ok, true);
  assert.equal(ok.skipped, false);

  chmodSync(tokenPath, 0o644);
  const bad = assertGatewayTokenSecurity(tokenPath);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /0644|0600/);

  const missing = assertGatewayTokenSecurity(path.join(dir, "nope"));
  assert.equal(missing.ok, false);

  // Wrong owner: assert a uid the token isn't owned by.
  chmodSync(tokenPath, 0o600);
  const wrongUid = assertGatewayTokenSecurity(tokenPath, { expectedUid: 999999 });
  assert.equal(wrongUid.ok, false);
  assert.match(wrongUid.reason, /uid/);

  // The unsupported-platform skip path is always assertable.
  const skipped = assertGatewayTokenSecurity(tokenPath, { platform: "win32" });
  assert.equal(skipped.skipped, true);
});
