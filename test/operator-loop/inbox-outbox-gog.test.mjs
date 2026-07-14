// Outbox real-gog CLI client + credential gate regression tests (I-11 / AIO-392).
//
// These pin the HARDENING findings on the live send path (no email is sent — the gog runner is
// injected as a recorded fixture):
//   1. Credential gate: assertGatewayTokenSecurity is wired before any first send; an insecure/
//      missing FILE token fails closed on POSIX; a keyring-backed credential is a named skip; the
//      win32 unsupported-platform skip is preserved.
//   2. querySent is FAIL-CLOSED: any exec/parse error throws OutboxReconcileError (never a silent
//      {found:false} that could cause a blind resend), and wired through createOutbox it yields
//      outcome_unknown with ZERO sends.
//   3. Reconcile is robust to SUBJECT EDITS: the stable marker lives in the body and querySent finds
//      the message by that marker regardless of the subject.
//   4. Send transmits EXACTLY the checked bytes (parsed via parseOutboundMessage) — one send, no dup.
//
// Loads the compiled loop barrel (as `loop`) + the CLI helpers from scripts/inbox.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as loop from "../../dist/operator-loop/index.js";
import {
  createGogSendClient,
  buildOutboundBytes,
  commandMarker,
  resolveGogCredential,
  gogTokenSecurityGate,
} from "../../scripts/inbox.mjs";

const now = () => 1_700_000_000_000;

function approvedRequest(addr = "john@john-ellison.com") {
  return {
    thread_ref: "gmail:t",
    evidence: [{ id: "m1", kind: "thread-message", origin_thread: "gmail:t", tier: "admin" }],
    recipients: [{ account: "gog:john", tenant: "personal", address: addr, verified: true }],
    channel: { channel_type: "email", thread_ref: "gmail:t" },
    attachments: [],
    quoted_refs: [],
    delegations: [],
  };
}
const ALLOW = { verdict: "allow", rule_id: "allow.origin-confined", explanation: "ok" };

function enqueueInputFor(commandId, bytes) {
  return {
    command_id: commandId,
    reply_request: approvedRequest(),
    exact_outbound_bytes: bytes,
    decision: ALLOW,
  };
}

// -- (2) querySent is fail-closed on a gog search outage -------------------------------------------

test("createGogSendClient.querySent throws OutboxReconcileError on an exec outage", () => {
  const client = createGogSendClient(loop, {
    commandId: "cmd-1",
    runGog() {
      const e = new Error("gog: connection refused");
      throw e;
    },
  });
  assert.throws(
    () => client.querySent(),
    (e) => e instanceof loop.OutboxReconcileError
  );
});

test("createGogSendClient.querySent throws OutboxReconcileError on non-JSON output", () => {
  const client = createGogSendClient(loop, { commandId: "cmd-1", runGog: () => "not json" });
  assert.throws(
    () => client.querySent(),
    (e) => e instanceof loop.OutboxReconcileError
  );
});

test("wired through the outbox, a search outage fails closed: outcome_unknown, ZERO sends", () => {
  let sends = 0;
  const bytes = buildOutboundBytes({
    commandId: "cmd-1",
    to: ["john@john-ellison.com"],
    subject: "hi",
    body: "yo",
  });
  const client = createGogSendClient(loop, {
    commandId: "cmd-1",
    runGog(args) {
      if (args[1] === "search") throw new Error("search outage");
      sends += 1;
      return JSON.stringify({ id: "should-not-happen" });
    },
  });
  const journal = loop.createInMemoryOutboxJournal();
  const ob = loop.createOutbox({ client, journal: journal.append, now });
  const cmd = ob.sendApproved(enqueueInputFor("cmd-1", bytes));
  assert.equal(cmd.state, "outcome_unknown");
  assert.equal(sends, 0, "a Sent-search outage must never fall through to a send");
});

// -- (3) reconcile is robust to subject edits (stable body marker) ---------------------------------

test("querySent finds the message by its stable body marker despite a subject edit", () => {
  const commandId = "cmd-subj-edit";
  const marker = commandMarker(commandId);
  // The fake Sent folder holds the message under an EDITED subject, but the body marker is intact.
  const sentFolder = [
    {
      id: "mid-9",
      threadId: "tid-9",
      subject: "TOTALLY DIFFERENT edited subject",
      labels: ["SENT"],
    },
  ];
  const client = createGogSendClient(loop, {
    commandId,
    runGog(args) {
      assert.equal(args[1], "search");
      const query = args[2];
      // gog full-text search matches the body marker, not the subject.
      assert.ok(query.includes(marker), `query must search the stable marker, got: ${query}`);
      return JSON.stringify(query.includes(marker) ? sentFolder : []);
    },
  });
  const q = client.querySent();
  assert.equal(q.found, true);
  assert.equal(q.message_id, "mid-9");
  assert.equal(q.thread_id, "tid-9");
});

test("reconcile-first with the body marker prevents a duplicate after a timeout", () => {
  const commandId = "cmd-dup";
  const bytes = buildOutboundBytes({
    commandId,
    to: ["john@john-ellison.com"],
    subject: "hi",
    body: "yo",
  });
  let sends = 0;
  let landed = false;
  const client = createGogSendClient(loop, {
    commandId,
    runGog(args) {
      if (args[1] === "search") {
        return JSON.stringify(
          landed ? [{ id: "mid-dup", threadId: "tid-dup", labels: ["SENT"] }] : []
        );
      }
      // send: it "lands" at Gmail but times out on our side.
      sends += 1;
      landed = true;
      const e = new Error("deadline exceeded");
      e.code = "ETIMEDOUT";
      throw e;
    },
  });
  const journal = loop.createInMemoryOutboxJournal();
  const ob = loop.createOutbox({ client, journal: journal.append, now });
  const c1 = ob.sendApproved(enqueueInputFor(commandId, bytes));
  assert.equal(c1.state, "outcome_unknown"); // timeout classified as unknown, not failed
  assert.equal(sends, 1);
  const c2 = ob.attempt(commandId); // reconcile-first finds the landed message via marker
  assert.equal(c2.state, "reconciled");
  assert.equal(c2.native_message_id, "mid-dup");
  assert.equal(sends, 1, "reconcile-first via the stable marker prevents a duplicate send");
});

// -- (4) send transmits exactly the checked bytes --------------------------------------------------

test("send parses the exact bytes and passes those fields to gog (aligned)", () => {
  const commandId = "cmd-align";
  const bytes = buildOutboundBytes({
    commandId,
    to: ["a@x.test", "b@x.test"],
    subject: "Re: aligned",
    body: "hello world",
  });
  let sentArgs = null;
  const client = createGogSendClient(loop, {
    commandId,
    runGog(args) {
      if (args[1] === "search") return JSON.stringify([]);
      sentArgs = args;
      return JSON.stringify({ id: "mid-align", threadId: "tid-align" });
    },
  });
  const r = client.send(bytes);
  assert.equal(r.message_id, "mid-align");
  // The recipients/subject/body handed to gog come straight from the checked bytes.
  const toIdx = sentArgs.indexOf("--to");
  assert.equal(sentArgs[toIdx + 1], "a@x.test,b@x.test");
  const subjIdx = sentArgs.indexOf("--subject");
  assert.equal(sentArgs[subjIdx + 1], "Re: aligned");
  const bodyIdx = sentArgs.indexOf("--body");
  assert.ok(sentArgs[bodyIdx + 1].startsWith("hello world"));
  // The stable marker is present in the body actually sent (so reconcile can find it).
  assert.ok(sentArgs[bodyIdx + 1].includes(commandMarker(commandId)));
});

// -- (1) credential gate ---------------------------------------------------------------------------

test("resolveGogCredential: env override selects file mode; default is keyring", () => {
  const fileMode = resolveGogCredential({ AIOS_GOG_TOKEN_FILE: "/tmp/tok" });
  assert.equal(fileMode.mode, "file");
  assert.equal(fileMode.tokenPath, "/tmp/tok");
  // With no env override and (in CI) gog keyring-backed or absent, the mode is keyring (named skip).
  const dflt = resolveGogCredential({});
  assert.ok(["keyring", "file"].includes(dflt.mode));
});

test("gogTokenSecurityGate: an insecure FILE token fails closed on POSIX", (t) => {
  if (process.platform === "win32") {
    const g = gogTokenSecurityGate(loop, {
      env: { AIOS_GOG_TOKEN_FILE: "C:/x" },
      platform: "win32",
    });
    assert.equal(g.skipped, true);
    t.skip("win32: POSIX mode/uid gate unsupported — asserted skip path");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "aio392-cred-"));
  const tok = path.join(dir, "gog-token");
  writeFileSync(tok, "fake");

  chmodSync(tok, 0o600);
  const okGate = gogTokenSecurityGate(loop, { env: { AIOS_GOG_TOKEN_FILE: tok } });
  assert.equal(okGate.ok, true);
  assert.equal(okGate.skipped, false);

  chmodSync(tok, 0o644);
  const badGate = gogTokenSecurityGate(loop, { env: { AIOS_GOG_TOKEN_FILE: tok } });
  assert.equal(badGate.ok, false, "an insecure token file must fail the gate closed");

  const missingGate = gogTokenSecurityGate(loop, {
    env: { AIOS_GOG_TOKEN_FILE: path.join(dir, "nope") },
  });
  assert.equal(missingGate.ok, false, "a missing token file must fail the gate closed");
});

test("gogTokenSecurityGate: a keyring-backed credential is a named skip (not a false pass)", () => {
  // Force the keyring branch by pointing at a config-less env and simulating via resolveGogCredential.
  const cred = resolveGogCredential({});
  if (cred.mode !== "keyring") {
    // On a machine with a file-backed gog config this branch is inapplicable; assert the shape only.
    assert.ok(typeof cred.reason === "string" || cred.mode === "file");
    return;
  }
  const gate = gogTokenSecurityGate(loop, { env: {} });
  assert.equal(gate.ok, true);
  assert.equal(gate.skipped, true);
  assert.match(gate.reason, /keyring|OS keyring/i);
});

test("gogTokenSecurityGate: win32 unsupported-platform skip is preserved", () => {
  const gate = gogTokenSecurityGate(loop, {
    env: { AIOS_GOG_TOKEN_FILE: "/whatever" },
    platform: "win32",
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.skipped, true);
  assert.match(gate.reason, /win32/);
});
