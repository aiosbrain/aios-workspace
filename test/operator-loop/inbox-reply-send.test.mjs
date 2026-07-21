import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as loop from "../../dist/operator-loop/index.js";

const COMMAND = "11111111-1111-4111-8111-111111111111";

function item(overrides = {}, observationOverrides = {}) {
  return {
    id: "thread-item-1",
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
      key: "gog-primary/email/message-1",
      connection_id: "gog:primary",
      account: "primary",
      tenant: "personal",
      object_kind: "email",
      native_id: "message-1",
      thread_id: "thread-1",
      participants: [
        { id: "Sender@Example.test", display: "Sender", role: "from" },
        { id: "sender@example.test", display: "Duplicate", role: "from" },
        { id: "other@example.test", display: "Other", role: "to" },
      ],
      snippet: "Quarterly review",
      deleted: false,
      revisions: [{ op: "create", revision: 0, ts: "2026-07-21T00:00:00.000Z" }],
      ts: "2026-07-21T00:00:00.000Z",
      origin: "enriched",
      ...observationOverrides,
    },
    ...overrides,
  };
}

function draft(current = item(), body = "  Keep this whitespace.  ", commandId = COMMAND) {
  return loop.buildGmailReplyDraft({
    item: current,
    commandId,
    body,
    expectedAccount: current.observation?.account ?? "primary",
  });
}

test("valid enriched GOG item derives the complete PDP, byte, transport, and digest contract", () => {
  const built = draft();
  assert.equal(built.thread_ref, "gmail:thread-1");
  assert.deepEqual(built.recipients, [
    { account: "primary", tenant: "personal", address: "sender@example.test", verified: true },
  ]);
  assert.deepEqual(built.reply_request, {
    thread_ref: "gmail:thread-1",
    evidence: [
      {
        id: "message-1",
        kind: "thread-message",
        origin_thread: "gmail:thread-1",
        tier: "admin",
      },
    ],
    recipients: built.recipients,
    channel: { channel_type: "email", thread_ref: "gmail:thread-1" },
    attachments: [],
    quoted_refs: [],
    delegations: [],
  });
  assert.deepEqual(built.transport, {
    provider: "gmail",
    account: "primary",
    thread_id: "thread-1",
  });
  assert.equal(built.body, "  Keep this whitespace.  ");
  assert.match(
    built.exact_outbound_bytes,
    /^To: sender@example\.test\nSubject: Re: Quarterly review\n\n/
  );
  assert.ok(built.exact_outbound_bytes.includes(loop.gmailReplyCommandMarker(COMMAND)));
  assert.equal(built.exact_outbound_bytes.includes("Cc:"), false);
  assert.equal(built.exact_outbound_bytes.includes("Bcc:"), false);
  assert.equal(built.exact_outbound_bytes.includes("From:"), false);
  assert.match(built.digest, /^[0-9a-f]{64}$/);

  const memory = loop.createMemoryJournalSink();
  const prepared = loop.prepareGmailReply(built, memory);
  assert.equal(prepared.ok, true);
  assert.equal(memory.events.length, 1);
  assert.equal(memory.events[0].thread_ref, "gmail:thread-1");
});

test("legacy/deleted/non-email/account/missing identity/invalid sender items are not replyable", () => {
  const cases = [
    [item({}, { origin: "legacy" }), "legacy-observation"],
    [item({}, { connection_id: "other:primary" }), "not-gog-observation"],
    [item({}, { connection_id: "gog:secondary" }), "not-gog-observation"],
    [item({}, { deleted: true }), "deleted-observation"],
    [item({}, { object_kind: "calendar-event" }), "not-email"],
    [item({}, { native_id: "" }), "missing-native-id"],
    [item({}, { thread_id: null }), "missing-thread-id"],
    [item({}, { account: null }), "missing-account"],
    [item({}, { tenant: null }), "missing-tenant"],
    [item({}, { participants: [{ id: "a@example.test", role: "to" }] }), "invalid-sender"],
    [
      item({}, { participants: [{ id: "a@example.test,b@example.test", role: "from" }] }),
      "invalid-sender",
    ],
    [item({}, { participants: [{ id: ".a@example.test", role: "from" }] }), "invalid-sender"],
    [item({}, { participants: [{ id: "a..b@example.test", role: "from" }] }), "invalid-sender"],
    [item({}, { participants: undefined }), "invalid-sender"],
    [
      item({}, { participants: [{ id: "a@example.test\nBcc:x@example.test", role: "from" }] }),
      "invalid-sender",
    ],
  ];
  for (const [candidate, code] of cases) {
    const replyability = loop.isGmailReplyable(candidate, "primary");
    assert.deepEqual(replyability, { replyable: false, code });
  }
  assert.deepEqual(loop.isGmailReplyable(item(), "other-account"), {
    replyable: false,
    code: "account-mismatch",
  });
  assert.deepEqual(
    loop.isGmailReplyable({ ...item(), origin: "agent-event", observation: undefined }, "primary"),
    { replyable: false, code: "not-thread-item" }
  );
});

test("subject removes CR/LF, preserves Re:, defaults empty, and caps Unicode code points", () => {
  assert.equal(loop.deriveGmailReplySubject(" Hello\r\nBcc: injected "), "Re: Hello Bcc: injected");
  assert.equal(loop.deriveGmailReplySubject("re: Already replying"), "re: Already replying");
  assert.equal(loop.deriveGmailReplySubject(" \n\r "), "Re: (no subject)");
  const capped = loop.deriveGmailReplySubject("🙂".repeat(250));
  assert.equal(Array.from(capped).length, 200);
  assert.equal(capped.startsWith("Re: "), true);
});

test("empty, oversized, NUL, reserved marker, and header-smuggling bodies fail before transport", () => {
  for (const [body, code] of [
    ["  \n ", "empty-body"],
    ["a".repeat(loop.MAX_REPLY_BODY_BYTES + 1), "body-too-large"],
    ["hello\0world", "nul-body"],
    ["hello aios-outbox-cmd:fake", "reserved-marker"],
    ["hello AIOS-OUTBOX-CMD:fake", "reserved-marker"],
  ]) {
    assert.throws(
      () => draft(item(), body),
      (error) => error instanceof loop.GmailReplyValidationError && error.code === code
    );
  }

  const smuggled = draft(item(), "Thanks\nTo: mallory@example.test");
  const prepared = loop.prepareGmailReply(smuggled, loop.createMemoryJournalSink());
  assert.equal(prepared.ok, false);
  assert.equal(prepared.stage, "pre_send");
  assert.equal(prepared.code, "quoted-thread-smuggle");
});

test("confirmation digest changes with body, recipient, subject, account, item, or thread", () => {
  const base = draft();
  const variants = [
    draft(item(), "different body"),
    draft(item({}, { participants: [{ id: "other@example.test", role: "from" }] })),
    draft(item({}, { snippet: "Different subject" })),
    draft(item({ account: "secondary" }, { account: "secondary", connection_id: "gog:secondary" })),
    draft(item({ id: "thread-item-2" })),
    draft(item({}, { thread_id: "thread-2" })),
  ];
  for (const variant of variants) assert.notEqual(variant.digest, base.digest);
});

test("command lock rejects a live holder, recovers stale/dead owners, and releases by token", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aio392-lock-"));
  try {
    const first = loop.acquireOutboxCommandLock(root, COMMAND);
    assert.throws(
      () => loop.acquireOutboxCommandLock(root, COMMAND),
      (error) => error instanceof loop.OutboxSendInProgressError
    );
    first.release();
    const second = loop.acquireOutboxCommandLock(root, COMMAND);
    const held = JSON.parse(readFileSync(second.path, "utf8"));
    writeFileSync(
      second.path,
      JSON.stringify({ ...held, token: "replacement-token", pid: 999_999_999 }),
      "utf8"
    );
    second.release();
    assert.equal(readFileSync(second.path, "utf8").includes("replacement-token"), true);
    const recovered = loop.acquireOutboxCommandLock(root, COMMAND);
    recovered.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
