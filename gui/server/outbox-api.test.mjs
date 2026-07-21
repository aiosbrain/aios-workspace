import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as loop from "../../dist/operator-loop/index.js";
import {
  OUTBOX_PROJECTION_LIMIT,
  REPLY_REQUEST_MAX_BYTES,
  getOutbox,
  handleOutboxApi,
  replyCheck,
  replySend,
  validateReplyCheckPayload,
  validateReplySendPayload,
} from "./outbox-api.mjs";

const COMMAND = "22222222-2222-4222-8222-222222222222";

function inboxItem(overrides = {}) {
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
      thread_id: "native-thread-1",
      participants: [{ id: "sender@example.test", display: "Sender", role: "from" }],
      snippet: "Body preview that must never become the subject.",
      subject: "Current subject",
      deleted: false,
      revisions: [],
      ts: "2026-07-21T00:00:00.000Z",
      origin: "enriched",
      ...overrides,
    },
  };
}

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "aio392-outbox-api-"));
}

function deps(current = inboxItem(), extra = {}) {
  return {
    loop,
    env: { GOG_ACCOUNT: "primary" },
    randomUUID: () => COMMAND,
    getInboxView: async () => ({ items: current ? [current] : [] }),
    credentialGate: () => ({ ok: true, skipped: true, reason: "test" }),
    ...extra,
  };
}

async function checked(repo, current = inboxItem(), body = "Hello") {
  const result = await replyCheck(repo, current.id, { body }, deps(current));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  return result.body;
}

test("reply-check is side-effect-free and previews only server-derived destination fields", async () => {
  const repo = workspace();
  try {
    const before = loop.readJournalSegments(repo).events;
    const result = await replyCheck(repo, "gmail-row", { body: "  Hello exactly.  " }, deps());
    assert.deepEqual(result, {
      status: 200,
      body: {
        ok: true,
        command_id: COMMAND,
        digest: result.body.digest,
        preview: {
          to: ["sender@example.test"],
          subject: "Re: Current subject",
          body: "  Hello exactly.  ",
          thread_label: "Gmail thread",
        },
      },
    });
    assert.match(result.body.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(loop.readJournalSegments(repo).events, before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("send journals PDP first, passes native account/thread, and duplicate confirmation sends once", async () => {
  const repo = workspace();
  let sends = 0;
  let clientOptions;
  const client = {
    querySent: () => ({ found: false }),
    send: () => {
      sends += 1;
      return { message_id: "native-message", thread_id: "native-thread-1" };
    },
  };
  try {
    const check = await checked(repo);
    const shared = deps(inboxItem(), {
      createGogSendClient(_loop, options) {
        clientOptions = options;
        return client;
      },
    });
    const payload = {
      command_id: check.command_id,
      digest: check.digest,
      body: check.preview.body,
    };
    const first = await replySend(repo, "gmail-row", payload, shared);
    const second = await replySend(repo, "gmail-row", payload, shared);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.state, "sent");
    assert.equal(second.body.ok, true);
    assert.equal(sends, 1);
    // Was `assert.equal(clientOptions.account, "primary")`. A live send disproved that expectation:
    // "primary" is the observation's identity LABEL, and passing it as `gog -a` fails with
    // "No auth for gmail primary" on a default-account gog, stranding every reply at "Confirming…".
    // The transport takes the CLI alias (`AIOS_GOG_CLI_ACCOUNT`), null meaning gog's own default.
    assert.equal(clientOptions.account, null);
    // The THREAD id still comes from the server-derived observation — that part was always right.
    assert.equal(clientOptions.threadId, "native-thread-1");

    const events = loop.readJournalSegments(repo).events;
    const firstPdp = events.findIndex(
      (event) => event.kind === "pdp-decision" && event.correlation_id === COMMAND
    );
    const firstAttempt = events.findIndex(
      (event) => event.kind === "action-attempt" && event.correlation_id === COMMAND
    );
    assert.ok(firstPdp >= 0 && firstPdp < firstAttempt);
    assert.equal(JSON.stringify(events).includes(check.preview.body), false);
    assert.equal(JSON.stringify(events).includes("sender@example.test"), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("malformed, stale digest, unsafe body, and credential failure make zero transport calls", async () => {
  const repo = workspace();
  let credentials = 0;
  let transports = 0;
  const current = inboxItem();
  const common = deps(current, {
    credentialGate: () => {
      credentials += 1;
      return { ok: true };
    },
    createGogSendClient: () => {
      transports += 1;
      return { querySent: () => ({ found: false }), send: () => ({}) };
    },
  });
  try {
    const check = await checked(repo, current, "Hello");
    const stale = await replySend(
      repo,
      current.id,
      { command_id: COMMAND, digest: "0".repeat(64), body: "Hello" },
      common
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "digest-mismatch");

    const unsafeDraft = loop.buildGmailReplyDraft({
      item: current,
      commandId: COMMAND,
      body: "Hello\nTo: mallory@example.test",
      expectedAccount: "primary",
    });
    const unsafe = await replySend(
      repo,
      current.id,
      { command_id: COMMAND, digest: unsafeDraft.digest, body: unsafeDraft.body },
      common
    );
    assert.equal(unsafe.status, 409);
    assert.equal(unsafe.body.code, "no-longer-allowed");

    const invalid = await replySend(repo, current.id, { ...check, extra: true }, common);
    assert.equal(invalid.status, 400);
    assert.equal(credentials, 0);
    assert.equal(transports, 0);

    const denied = await replySend(
      repo,
      current.id,
      { command_id: check.command_id, digest: check.digest, body: check.preview.body },
      deps(current, {
        credentialGate: () => ({ ok: false, reason: "private path" }),
        createGogSendClient: () => {
          transports += 1;
          return {};
        },
      })
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "credential-gate");
    assert.equal(transports, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a live command lock returns send-in-progress; retry after release sends once", async () => {
  const repo = workspace();
  let sends = 0;
  try {
    const check = await checked(repo);
    const lock = loop.acquireOutboxCommandLock(repo, COMMAND);
    const shared = deps(inboxItem(), {
      createGogSendClient: () => ({
        querySent: () => ({ found: false }),
        send: () => {
          sends += 1;
          return { message_id: "mid", thread_id: "native-thread-1" };
        },
      }),
    });
    const payload = { command_id: COMMAND, digest: check.digest, body: check.preview.body };
    const blocked = await replySend(repo, "gmail-row", payload, shared);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "send-in-progress");
    assert.equal(sends, 0);
    lock.release();
    const sent = await replySend(repo, "gmail-row", payload, shared);
    assert.equal(sent.body.ok, true);
    assert.equal(sends, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("timeout returns a retry timestamp and reconcile finds Sent without another send", async () => {
  const repo = workspace();
  let sends = 0;
  let landed = false;
  const nowMs = Date.parse("2026-07-21T01:00:00.000Z");
  const current = inboxItem();
  const shared = deps(current, {
    now: () => nowMs,
    createGogSendClient: () => ({
      querySent: () =>
        landed
          ? { found: true, message_id: "mid-timeout", thread_id: "native-thread-1" }
          : { found: false },
      send: () => {
        sends += 1;
        landed = true;
        throw new loop.OutboxTimeoutError("fixture timeout");
      },
    }),
  });
  try {
    const check = await checked(repo, current);
    const payload = { command_id: COMMAND, digest: check.digest, body: check.preview.body };
    const unknown = await replySend(repo, current.id, payload, shared);
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.state, "outcome_unknown");
    assert.equal(
      unknown.body.retry_after,
      new Date(nowMs + loop.DEFAULT_RECONCILE_MIN_DELAY_MS).toISOString()
    );
    const reconciled = await replySend(repo, current.id, payload, shared);
    assert.equal(reconciled.body.ok, true);
    assert.equal(reconciled.body.state, "reconciled");
    assert.equal(sends, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("GET outbox folds only outbox events, joins thread ref, and remains content-free", async () => {
  const repo = workspace();
  try {
    const check = await checked(repo);
    await replySend(
      repo,
      "gmail-row",
      { command_id: COMMAND, digest: check.digest, body: check.preview.body },
      deps(inboxItem(), {
        createGogSendClient: () => ({
          querySent: () => ({ found: false }),
          send: () => ({ message_id: "mid", thread_id: "native-thread-1" }),
        }),
      })
    );
    loop.appendInboxEvent(repo, {
      kind: "outcome",
      correlation_id: "capability-handle",
      payload: { lane: "capability", result: "outcome_unknown" },
    });
    const result = await getOutbox(repo, { loop, now: () => 1_750_000_000_000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.commands[0].command_id, COMMAND);
    assert.equal(result.body.commands[0].thread_ref, "gmail:native-thread-1");
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("Hello"), false);
    assert.equal(serialized.includes("sender@example.test"), false);
    assert.equal(serialized.includes("capability-handle"), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("payload allowlists reject unknown fields and malformed command ids", () => {
  assert.equal(validateReplyCheckPayload({ body: "ok" }), null);
  assert.match(validateReplyCheckPayload({ body: "ok", account: "primary" }), /exactly/);
  assert.equal(
    validateReplySendPayload({ command_id: COMMAND, digest: "a".repeat(64), body: "ok" }),
    null
  );
  assert.match(
    validateReplySendPayload({ command_id: "not-uuid", digest: "a".repeat(64), body: "ok" }),
    /UUID/
  );
  assert.match(
    validateReplySendPayload({
      command_id: COMMAND,
      digest: "a".repeat(64),
      body: "ok",
      thread_id: "x",
    }),
    /exactly/
  );
});

function requestRoute({
  pathname,
  method = "GET",
  token = "test-token",
  rawBody = "",
  routeDeps = {},
}) {
  return new Promise((resolve) => {
    const req = new PassThrough();
    req.method = method;
    let claimed = false;
    const response = {
      status: null,
      headers: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body = "") {
        queueMicrotask(() =>
          resolve({ claimed, status: this.status, body: body ? JSON.parse(body) : null })
        );
      },
    };
    const url = new URL(`http://127.0.0.1${pathname}?token=${encodeURIComponent(token)}`);
    claimed = handleOutboxApi(req, response, url, {
      repo: "/fixture",
      token: "test-token",
      deps: routeDeps,
    });
    req.end(rawBody);
  });
}

test("routes are token-gated, claim reply paths before generic detail, and return JSON 413", async () => {
  const unauthorized = await requestRoute({ pathname: "/api/outbox", token: "wrong" });
  assert.equal(unauthorized.claimed, true);
  assert.equal(unauthorized.status, 401);

  const tooLarge = await requestRoute({
    pathname: "/api/inbox/gmail-row/reply-check",
    method: "POST",
    rawBody: "x".repeat(REPLY_REQUEST_MAX_BYTES + 1),
  });
  assert.equal(tooLarge.claimed, true);
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, { ok: false, error: "request body too large" });

  const invalid = await requestRoute({
    pathname: "/api/inbox/gmail-row/reply-send",
    method: "POST",
    rawBody: "{",
  });
  assert.equal(invalid.claimed, true);
  assert.equal(invalid.status, 400);
});

test("the outbox projection is bounded and reports what it truncated", async () => {
  const repo = workspace();
  try {
    const total = OUTBOX_PROJECTION_LIMIT + 5;
    const journal = loop.createDurableOutboxJournal(repo);
    for (let i = 0; i < total; i += 1) {
      journal({
        kind: "action-attempt",
        command_id: `command-${String(i).padStart(3, "0")}`,
        // Ascending timestamps: the projection sorts newest-first, so the newest must survive.
        at: new Date(Date.UTC(2026, 6, 21, 0, i)).toISOString(),
        data: { attempt: 1 },
      });
    }

    const result = await getOutbox(repo, { loop, now: () => 1_750_000_000_000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.commands.length, OUTBOX_PROJECTION_LIMIT);
    assert.equal(result.body.count, OUTBOX_PROJECTION_LIMIT);
    assert.equal(result.body.total, total);
    assert.equal(result.body.truncated, true);
    // Newest-first: the most recent command is kept and the oldest is the one dropped.
    assert.equal(
      result.body.commands[0].command_id,
      `command-${String(total - 1).padStart(3, "0")}`
    );
    assert.equal(
      result.body.commands.some((command) => command.command_id === "command-000"),
      false
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the gog CLI account alias is decoupled from the observation identity label", async () => {
  const repo = workspace();
  const current = inboxItem();
  let seenAccount = "unset";
  try {
    const check = await checked(repo, current, "Hello");
    // The observation's `account` is the literal identity label "primary". Passing it to `gog -a`
    // fails on a workspace whose gog uses an unnamed default account ("No auth for gmail primary"),
    // which fails closed as reconcile_unavailable and strands the reply at "Confirming…".
    await replySend(
      repo,
      current.id,
      { command_id: check.command_id, digest: check.digest, body: check.preview.body },
      deps(current, {
        createGogSendClient: (_loop, opts) => {
          seenAccount = opts.account;
          return {
            querySent: () => ({ found: false }),
            send: () => ({ message_id: "m-1", thread_id: "t-1" }),
          };
        },
      })
    );
    assert.equal(seenAccount, null, "no alias configured → gog's default account, never 'primary'");
    assert.equal(current.observation.account, "primary", "the identity label is unchanged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
