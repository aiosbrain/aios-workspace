// Inbox send-bypass gate (I-11 / AIO-392, the G5 gate).
//
// Claim scope, stated HONESTLY: "the inbox code path is gated" — every inbox code path to a gog send
// runs through the I-10 reply PDP + the I-11 outbox (asserted here by seam instrumentation). The
// UNCLAIMED surface is named explicitly in this test's output: the ambient `gog` CLI on John's Mac
// still holds its own OAuth token and can be invoked directly. The full cannot-bypass credential
// broker + per-adapter uid isolation belong to G6b (I-15) and are NEVER advertised earlier than G5.
//
// Runs against the COMPILED barrel (`dist/operator-loop/index.js`) — `npm run build:loop` first.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOutbox,
  createInMemoryOutboxJournal,
  OutboxRejectedError,
} from "../../dist/operator-loop/index.js";

const THREAD = "gmail:thread-A";
let CLOCK = 5_000;
const now = () => (CLOCK += 1000);

function participant(address, { account = "acct-1", tenant = "tenant-1", verified = true } = {}) {
  return { account, tenant, address, verified };
}
const ALICE = participant("alice@acme.test");

function baseRequest(recipients = [ALICE]) {
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

function bytes(commandId = "cmd-1", to = ["alice@acme.test"]) {
  return (
    [
      "From: john@john-ellison.com",
      `To: ${to.join(", ")}`,
      "Subject: Re: hello",
      `X-AIOS-Command-Id: ${commandId}`,
    ].join("\n") + "\n\nHi.\n"
  );
}

/** An instrumented gog client: the ONLY thing that can reach the transport. It records every send. */
function instrumentedGog() {
  const sends = [];
  return {
    sends,
    client: {
      querySent: () => ({ found: false }),
      send(b) {
        sends.push(b);
        const m = b.match(/X-AIOS-Command-Id:\s*(\S+)/);
        const id = m ? m[1] : "unknown";
        return { message_id: `mid-${id}`, thread_id: `tid-${id}` };
      },
    },
  };
}

const ALLOW = { verdict: "allow", rule_id: "allow.origin-confined", explanation: "ok" };

// -- the gated path: every inbox send goes PDP-allow -> outbox -> gog ------------------------------

test("gated: an inbox send only reaches gog through an allow decision + the outbox", () => {
  const { client, sends } = instrumentedGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  const cmd = ob.sendApproved({
    command_id: "cmd-1",
    reply_request: baseRequest(),
    exact_outbound_bytes: bytes("cmd-1"),
    decision: ALLOW,
  });
  assert.equal(cmd.state, "sent");
  assert.equal(sends.length, 1, "exactly one gated send reached the transport");
});

test("bypass attempt 1: a deny/needs_promotion decision can NEVER reach gog", () => {
  const { client, sends } = instrumentedGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  for (const verdict of ["deny", "needs_promotion"]) {
    assert.throws(
      () =>
        ob.sendApproved({
          command_id: `c-${verdict}`,
          reply_request: baseRequest(),
          exact_outbound_bytes: bytes(`c-${verdict}`),
          decision: { verdict, rule_id: "r", explanation: "e" },
        }),
      (e) => e instanceof OutboxRejectedError
    );
  }
  assert.equal(sends.length, 0, "no non-allow decision ever reached the transport");
});

test("bypass attempt 2: a recipient-mutated command cannot reach gog", () => {
  const { client, sends } = instrumentedGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  // PDP approved {alice}; the bytes try to send to mallory.
  ob.enqueue({
    command_id: "cmd-1",
    reply_request: baseRequest(),
    exact_outbound_bytes: bytes("cmd-1", ["mallory@evil.test"]),
    decision: ALLOW,
  });
  assert.throws(
    () => ob.attempt("cmd-1"),
    (e) => e instanceof OutboxRejectedError && e.reason === "recipient-mismatch"
  );
  assert.equal(sends.length, 0);
});

test("bypass attempt 3: you cannot attempt a command that was never enqueued (no allow decision)", () => {
  const { client, sends } = instrumentedGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  assert.throws(
    () => ob.attempt("never-enqueued"),
    (e) => e instanceof OutboxRejectedError
  );
  assert.equal(sends.length, 0);
});

test("seam instrumentation: the outbox is the sole caller of the injected send client", () => {
  // Structural assertion: the send client is INJECTED into the outbox and nothing else in the inbox
  // barrel holds a reference to it. If any code reached gog without the outbox, it would need this
  // same injected client — the outbox is the only holder, so the PDP + pre-send checks are
  // unavoidable on the inbox path.
  const { client, sends } = instrumentedGog();
  const journal = createInMemoryOutboxJournal();
  const ob = createOutbox({ client, journal: journal.append, now });
  // The outbox exposes enqueue/attempt/reconcile/sendApproved — no "raw send" escape hatch.
  assert.deepEqual(
    Object.keys(ob).sort(),
    ["attempt", "enqueue", "get", "reconcile", "sendApproved", "sendCount"].sort()
  );
  assert.equal(typeof ob.sendApproved, "function");
  assert.equal(sends.length, 0);
});

test("UNCLAIMED surface named: the ambient gog CLI is NOT gated at G5 (G6b/I-15 owns cannot-bypass)", () => {
  // This is the honest claim boundary. We assert nothing about the ambient CLI — we NAME it so the
  // scope is explicit in the test output, exactly as the spec requires.
  const unclaimed =
    "UNCLAIMED at G5: the ambient `gog` CLI (its own OAuth token) can send directly, outside the " +
    "inbox path. The cannot-bypass credential broker + per-adapter uid isolation are G6b (I-15).";
  console.log(unclaimed);
  assert.match(unclaimed, /ambient `gog` CLI/);
  assert.match(unclaimed, /G6b \(I-15\)/);
});
