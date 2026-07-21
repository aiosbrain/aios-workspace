// GUI send-bypass gate for AIO-392. The browser supplies only body + confirmation capability data;
// the server must rebuild identity, rerun policy, gate credentials, lock, replay, and use the outbox.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as loop from "../../dist/operator-loop/index.js";
import {
  replyCheck,
  replySend,
  validateReplyCheckPayload,
  validateReplySendPayload,
} from "../../gui/server/outbox-api.mjs";

const COMMAND = "33333333-3333-4333-8333-333333333333";

function gmailItem() {
  return {
    id: "gmail-row",
    origin: "thread-state",
    source: "email",
    account: "primary",
    bucket: "thread",
    protected: false,
    why: "recency",
    attention_state: "surfaced",
    action_state: "none",
    ts: "2026-07-21T00:00:00.000Z",
    observation: {
      key: "gog:primary/email/message-1",
      connection_id: "gog:primary",
      account: "primary",
      tenant: "personal",
      object_kind: "email",
      native_id: "message-1",
      thread_id: "thread-1",
      participants: [{ id: "sender@example.test", display: null, role: "from" }],
      snippet: "Body preview text.",
      subject: "Subject",
      deleted: false,
      revisions: [],
      ts: "2026-07-21T00:00:00.000Z",
      origin: "enriched",
    },
  };
}

function dependencies(item, trace, instrumentedLoop = loop) {
  return {
    loop: instrumentedLoop,
    env: { GOG_ACCOUNT: "primary" },
    randomUUID: () => COMMAND,
    getInboxView: async () => ({ items: [item] }),
    credentialGate: () => {
      trace.push("credential");
      return { ok: true, skipped: true, reason: "fixture" };
    },
    acquireLock() {
      trace.push("lock");
      return { release: () => trace.push("unlock") };
    },
    createGogSendClient(_compiled, options) {
      trace.push("transport");
      // The gog CLI alias, not the observation's identity label — see outbox-api.test.mjs. A live
      // send proved that passing "primary" to `gog -a` fails closed and strands the reply.
      assert.equal(options.account, null);
      // The thread id is still server-derived from the observation, which is what stops the browser
      // choosing a destination thread.
      assert.equal(options.threadId, "thread-1");
      return {
        querySent: () => ({ found: false }),
        send: () => {
          trace.push("send");
          return { message_id: "message-sent", thread_id: "thread-1" };
        },
      };
    },
  };
}

test("GUI payloads cannot select account, thread, recipients, or reply-all", () => {
  assert.equal(validateReplyCheckPayload({ body: "Hello" }), null);
  for (const field of ["account", "thread_id", "to", "cc", "bcc", "attachments", "reply_all"]) {
    assert.match(validateReplyCheckPayload({ body: "Hello", [field]: "attacker" }), /exactly/);
  }
  assert.equal(
    validateReplySendPayload({ command_id: COMMAND, digest: "a".repeat(64), body: "Hello" }),
    null
  );
  assert.match(
    validateReplySendPayload({
      command_id: COMMAND,
      digest: "a".repeat(64),
      body: "Hello",
      thread_id: "attacker",
    }),
    /exactly/
  );
});

test("GUI server mounts reply routes before the generic inbox detail route", () => {
  const source = readFileSync(new URL("../../gui/server/index.mjs", import.meta.url), "utf8");
  const replyRoutes = source.indexOf("handleOutboxApi(req, res, url");
  const genericDetail = source.indexOf("const inboxDetail = url.pathname.match");
  assert.ok(replyRoutes >= 0, "outbox/reply handler must be mounted");
  assert.ok(
    genericDetail > replyRoutes,
    "reply handler must claim its paths before generic detail"
  );
});

test("GUI confirmed send crosses identity, PDP, credential, lock, replay, and outbox before transport", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aio392-gui-bypass-"));
  const item = gmailItem();
  const trace = [];
  const instrumentedLoop = {
    ...loop,
    buildGmailReplyDraft(input) {
      trace.push("identity");
      return loop.buildGmailReplyDraft(input);
    },
    prepareGmailReply(draft, journal) {
      trace.push("pdp");
      return loop.prepareGmailReply(draft, journal);
    },
    readJournalSegments(root) {
      trace.push("replay");
      return loop.readJournalSegments(root);
    },
    executePreparedGmailReply(input) {
      trace.push("outbox");
      return loop.executePreparedGmailReply(input);
    },
  };
  try {
    const check = await replyCheck(
      repo,
      item.id,
      { body: "Hello" },
      {
        ...dependencies(item, trace, instrumentedLoop),
        randomUUID: () => COMMAND,
      }
    );
    assert.equal(check.body.ok, true);
    trace.length = 0;
    const sent = await replySend(
      repo,
      item.id,
      { command_id: COMMAND, digest: check.body.digest, body: "Hello" },
      dependencies(item, trace, instrumentedLoop)
    );
    assert.equal(sent.body.ok, true);
    // The PDP DECIDES here, but its decision is only journaled after the lock is held (see
    // `bufferedPdpJournal`) — a refusal writes nothing, and two racing confirmations of one command
    // cannot both record an authorization.
    assert.deepEqual(trace, [
      "identity",
      "pdp",
      "credential",
      "lock",
      "replay",
      "transport",
      "outbox",
      "send",
      "unlock",
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("digest mismatch stops before credential, lock, or transport", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aio392-gui-bypass-"));
  const item = gmailItem();
  const trace = [];
  try {
    const result = await replySend(
      repo,
      item.id,
      { command_id: COMMAND, digest: "0".repeat(64), body: "changed" },
      dependencies(item, trace)
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "digest-mismatch");
    assert.deepEqual(trace, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
