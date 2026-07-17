// m365 connect-and-verify fixture matrix (I-12 / AIO-393).
//
// Proves the credential-free verify contract entirely from RECORDED fixtures — no live tenant, no
// network, deterministic. Report-shape validation (live vs fixture claim honesty), the three
// diagnostic checks, the failure paths (bad token, missing scope, read/send 403, throttling), and
// the pagination/delta/normalization/identity seams. Nothing here makes a Graph call.
//
// Runs against the COMPILED barrel (`dist/operator-loop/index.js`) — `npm run build:loop` first.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyM365,
  validateToken,
  normalizeScopes,
  missingScopes,
  classifyGraphError,
  normalizeMessage,
  m365IdentityKey,
  paginateMessages,
  needsTenantReport,
  recordVerifyReport,
  createMemoryVerifyJournal,
  createFixtureTransport,
  parseM365Config,
  M365_REQUIRED_SCOPES,
  M365_DIAGNOSTICS,
} from "../../dist/operator-loop/index.js";

// --- fixtures ---------------------------------------------------------------------------------

const CONFIG = {
  tenant_id: "contoso.onmicrosoft.test",
  client_id: "app-fixture",
  test_recipient: "test-recipient@contoso.onmicrosoft.test",
  account: "verify@contoso.onmicrosoft.test",
};

const TS = "2026-07-14T12:00:00.000Z";
const NO_SLEEP = () => Promise.resolve();

function token(overrides = {}) {
  return {
    access_token: "tok",
    scopes: [...M365_REQUIRED_SCOPES],
    expires_at: "2999-01-01T00:00:00.000Z",
    account: CONFIG.account,
    tenant: CONFIG.tenant_id,
    ...overrides,
  };
}

/** Build a transport from per-op handlers; unspecified ops succeed with sane defaults. */
function transport({ auth, list, send } = {}) {
  const page = {
    value: [{ id: "AAMk-1", received_at: "2026-07-14T09:00:00.000Z" }],
    next_link: null,
    delta_link: "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=D0",
  };
  return {
    async acquireToken() {
      return auth ?? { ok: true, value: token() };
    },
    async listMessages(_t, opts) {
      return typeof list === "function" ? list(opts) : (list ?? { ok: true, value: page });
    },
    async sendMail() {
      return send ?? { ok: true, value: { native_message_id: "AAMk-sent-1" } };
    },
  };
}

async function verify(overrides = {}) {
  return verifyM365({
    transport: transport(),
    config: CONFIG,
    ts: TS,
    sleep: NO_SLEEP,
    ...overrides,
  });
}

// --- report shape + claim honesty -------------------------------------------------------------

test("report shape: a fully-green run has the exact VerifyReport shape + all three checks pass", async () => {
  const r = await verify();
  assert.equal(r.tenant, CONFIG.tenant_id);
  assert.equal(r.status, "verified");
  assert.equal(r.verified, true);
  assert.equal(r.checks.auth.status, "pass");
  assert.equal(r.checks.read.status, "pass");
  assert.equal(r.checks.send.status, "pass");
  assert.deepEqual(r.graph_permissions, ["Mail.Read", "Mail.Send"]);
  assert.equal(r.native_message_id, "AAMk-sent-1");
  assert.equal(r.message_count, 1);
  assert.equal(typeof r.cursor, "string");
  assert.equal(r.ts, TS);
  for (const k of ["auth", "read", "send"]) {
    assert.ok(typeof r.checks[k].code === "string", "each check names a diagnostic code");
  }
});

test("claim honesty: a FIXTURE run never claims 'connected and verified' even when all pass", async () => {
  const r = await verify({ mode: "fixture" });
  assert.equal(r.verified, true);
  assert.equal(r.claim, "not verified");
});

test("claim honesty: only a LIVE all-green run publishes 'connected and verified'", async () => {
  const r = await verify({ mode: "live" });
  assert.equal(r.verified, true);
  assert.equal(r.claim, "connected and verified");
});

test("claim honesty: a LIVE run that is NOT fully green stays 'not verified'", async () => {
  const r = await verify({
    mode: "live",
    transport: transport({
      send: { ok: false, error: { status: 500, code: "internalError", message: "x" } },
    }),
  });
  assert.equal(r.verified, false);
  assert.equal(r.claim, "not verified");
});

// --- failure paths (recorded fixtures — the CI-safe negative cases) ----------------------------

test("bad token: acquisition fails → auth fail, read + send skipped", async () => {
  const r = await verify({
    transport: transport({
      auth: {
        ok: false,
        error: { status: 401, code: "invalidAuthenticationToken", message: "no token" },
      },
    }),
  });
  assert.equal(r.checks.auth.status, "fail");
  assert.equal(r.checks.auth.code, M365_DIAGNOSTICS.AUTH_TOKEN_UNAVAILABLE);
  assert.equal(r.checks.read.status, "skipped");
  assert.equal(r.checks.send.status, "skipped");
  assert.equal(r.checks.read.code, M365_DIAGNOSTICS.SKIPPED_PRIOR_FAILURE);
  assert.equal(r.status, "unverified");
  assert.deepEqual(r.graph_permissions, []);
});

test("missing scope: token granted without Mail.Send → auth fail (insufficient-scope)", async () => {
  const r = await verify({
    transport: transport({ auth: { ok: true, value: token({ scopes: ["Mail.Read"] }) } }),
  });
  assert.equal(r.checks.auth.status, "fail");
  assert.equal(r.checks.auth.code, M365_DIAGNOSTICS.AUTH_INSUFFICIENT_SCOPE);
  assert.deepEqual(r.checks.auth.observed_scopes, ["Mail.Read"]);
});

test("expired token → auth fail (token-expired), validated against the injected clock", async () => {
  const r = await verify({
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    transport: transport({
      auth: { ok: true, value: token({ expires_at: "2020-01-01T00:00:00.000Z" }) },
    }),
  });
  assert.equal(r.checks.auth.status, "fail");
  assert.equal(r.checks.auth.code, M365_DIAGNOSTICS.AUTH_TOKEN_EXPIRED);
});

test("read 403: valid token but Graph denies read → read fail (insufficient-scope), send SKIPPED (sequential gating)", async () => {
  const r = await verify({
    transport: transport({
      list: { ok: false, error: { status: 403, code: "accessDenied", message: "denied" } },
    }),
  });
  assert.equal(r.checks.auth.status, "pass");
  assert.equal(r.checks.read.status, "fail");
  assert.equal(r.checks.read.code, M365_DIAGNOSTICS.READ_INSUFFICIENT_SCOPE);
  // auth → read → send is sequential: a failed read means the one mediated send never fires.
  assert.equal(r.checks.send.status, "skipped");
  assert.equal(r.checks.send.code, M365_DIAGNOSTICS.SKIPPED_PRIOR_FAILURE);
  assert.equal(r.native_message_id, null, "no send was attempted after a failed read");
  assert.equal(r.verified, false);
  // No scope was exercised successfully (read failed, send never ran).
  assert.deepEqual(r.graph_permissions, []);
});

test("sequential gating: sendMail is NEVER called when the read check fails", async () => {
  let sendCalls = 0;
  const t = transport({
    list: { ok: false, error: { status: 500, code: "internalError", message: "boom" } },
  });
  const inner = t.sendMail.bind(t);
  t.sendMail = (...args) => {
    sendCalls += 1;
    return inner(...args);
  };
  const r = await verify({ transport: t });
  assert.equal(r.checks.read.status, "fail");
  assert.equal(r.checks.send.status, "skipped");
  assert.equal(sendCalls, 0, "the transport's sendMail was never invoked");
});

test("send 403: Graph denies send → send fail (insufficient-scope)", async () => {
  const r = await verify({
    transport: transport({
      send: { ok: false, error: { status: 403, code: "accessDenied", message: "denied" } },
    }),
  });
  assert.equal(r.checks.read.status, "pass");
  assert.equal(r.checks.send.status, "fail");
  assert.equal(r.checks.send.code, M365_DIAGNOSTICS.SEND_INSUFFICIENT_SCOPE);
  assert.deepEqual(r.graph_permissions, ["Mail.Read"]);
});

test("throttling: a 429 with Retry-After is retried within budget → read passes, throttle honored", async () => {
  let calls = 0;
  const waits = [];
  const r = await verify({
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    transport: transport({
      list: () => {
        calls += 1;
        if (calls === 1)
          return {
            ok: false,
            error: {
              status: 429,
              code: "TooManyRequests",
              message: "slow down",
              retry_after_seconds: 2,
            },
          };
        return {
          ok: true,
          value: { value: [{ id: "AAMk-1" }], next_link: null, delta_link: "D1" },
        };
      },
    }),
  });
  assert.equal(r.checks.read.status, "pass");
  assert.equal(calls, 2, "retried once after the 429");
  assert.deepEqual(waits, [2000], "honored Retry-After (2s) via the injected sleep");
});

test("throttling beyond budget: persistent 429 → read fail (throttled)", async () => {
  const r = await verify({
    maxThrottleRetries: 2,
    transport: transport({
      list: () => ({
        ok: false,
        error: { status: 429, code: "TooManyRequests", message: "slow", retry_after_seconds: 1 },
      }),
    }),
  });
  assert.equal(r.checks.read.status, "fail");
  assert.equal(r.checks.read.code, M365_DIAGNOSTICS.READ_THROTTLED);
});

// --- pagination + delta + normalization + identity --------------------------------------------

test("pagination: follows next_link across pages and captures the terminal delta cursor", async () => {
  const pages = [
    { value: [{ id: "m1" }, { id: "m2" }], next_link: "P2", delta_link: null },
    { value: [{ id: "m3" }], next_link: "P3", delta_link: null },
    { value: [{ id: "m4" }], next_link: null, delta_link: "DELTA-FINAL" },
  ];
  let i = 0;
  const t = transport({
    list: () => ({ ok: true, value: pages[i++] }),
  });
  const res = await paginateMessages(t, token(), {
    top: 10,
    maxThrottleRetries: 0,
    sleep: NO_SLEEP,
  });
  assert.equal(res.ok, true);
  assert.equal(res.pages, 3);
  assert.equal(res.messages.length, 4);
  assert.equal(res.cursor, "DELTA-FINAL", "delta cursor is the terminal page's delta_link");
});

test("pagination bound: paginateMessages stops at maxPages even while next_link keeps flowing", async () => {
  let calls = 0;
  const t = transport({
    list: () => {
      calls += 1;
      return {
        ok: true,
        value: { value: [{ id: `m${calls}` }], next_link: `P${calls + 1}`, delta_link: null },
      };
    },
  });
  const res = await paginateMessages(t, token(), {
    top: 10,
    maxThrottleRetries: 0,
    sleep: NO_SLEEP,
    maxPages: 3,
  });
  assert.equal(res.ok, true);
  assert.equal(res.pages, 3, "the walk stops at the page cap");
  assert.equal(calls, 3, "no request is made beyond the cap");
});

test("verify read check is BOUNDED: one page of readCount, never a whole-mailbox walk", async () => {
  // A hostile/huge mailbox: every page is full and always advertises another next_link.
  let listCalls = 0;
  const t = transport({
    list: (opts) => {
      listCalls += 1;
      return {
        ok: true,
        value: {
          value: Array.from({ length: opts.top }, (_, i) => ({ id: `m-${listCalls}-${i}` })),
          next_link: `PAGE-${listCalls + 1}`,
          delta_link: null,
        },
      };
    },
  });
  const r = await verify({ transport: t, readCount: 10 });
  assert.equal(r.checks.read.status, "pass");
  assert.equal(listCalls, 1, "exactly one page request — the verify never follows next_link");
  assert.equal(r.message_count, 10, "the read check lists readCount messages, not the mailbox");
});

test("normalization + identity: same native id on two accounts → two distinct keys (AIO-387 dedup key)", () => {
  const a = normalizeMessage(token({ account: "a@x.test", tenant: "t1" }), { id: "SHARED" });
  const b = normalizeMessage(token({ account: "b@x.test", tenant: "t1" }), { id: "SHARED" });
  assert.notEqual(a.key, b.key);
  assert.equal(a.tier, "admin", "inbound m365 is admin-tier by default");
  assert.equal(a.object_kind, "email");
  assert.equal(a.native_id, "SHARED");
  assert.equal(m365IdentityKey("a@x.test", "t1", "SHARED"), a.key);
});

// --- scope + error-classification units -------------------------------------------------------

test("normalizeScopes strips the Graph resource prefix and dedupes", () => {
  assert.deepEqual(
    normalizeScopes(["https://graph.microsoft.com/Mail.Read", "Mail.Read", " Mail.Send "]),
    ["Mail.Read", "Mail.Send"]
  );
});

test("missingScopes reports required scopes not granted (case-insensitive)", () => {
  assert.deepEqual(missingScopes(["mail.read"], M365_REQUIRED_SCOPES), ["Mail.Send"]);
  assert.deepEqual(missingScopes(M365_REQUIRED_SCOPES, M365_REQUIRED_SCOPES), []);
});

test("validateToken: null / expired / missing-scope / ok all name the right diagnostic", () => {
  const now = Date.parse("2026-07-14T00:00:00.000Z");
  assert.equal(
    validateToken(null, M365_REQUIRED_SCOPES, now).code,
    M365_DIAGNOSTICS.AUTH_TOKEN_UNAVAILABLE
  );
  assert.equal(
    validateToken(token({ expires_at: "2020-01-01T00:00:00.000Z" }), M365_REQUIRED_SCOPES, now)
      .code,
    M365_DIAGNOSTICS.AUTH_TOKEN_EXPIRED
  );
  assert.equal(
    validateToken(token({ scopes: ["Mail.Read"] }), M365_REQUIRED_SCOPES, now).code,
    M365_DIAGNOSTICS.AUTH_INSUFFICIENT_SCOPE
  );
  assert.equal(validateToken(token(), M365_REQUIRED_SCOPES, now).valid, true);
});

test("classifyGraphError buckets 403/429/401/other", () => {
  assert.equal(
    classifyGraphError({ status: 403, code: "accessDenied", message: "" }),
    "insufficient-scope"
  );
  assert.equal(
    classifyGraphError({ status: 429, code: "TooManyRequests", message: "" }),
    "throttled"
  );
  assert.equal(
    classifyGraphError({ status: 401, code: "invalidAuthenticationToken", message: "" }),
    "auth"
  );
  assert.equal(classifyGraphError({ status: 500, code: "internalError", message: "" }), "other");
});

// --- needs-tenant + journal + config ----------------------------------------------------------

test("needsTenantReport: no config → needs-tenant status, every check skipped, claim not verified", () => {
  const r = needsTenantReport(null, TS);
  assert.equal(r.status, "needs-tenant");
  assert.equal(r.verified, false);
  assert.equal(r.claim, "not verified");
  assert.equal(r.tenant, "<unconfigured>");
  for (const k of ["auth", "read", "send"]) {
    assert.equal(r.checks[k].status, "skipped");
    assert.equal(r.checks[k].code, M365_DIAGNOSTICS.NEEDS_TENANT);
  }
});

test("journal event is content-free: no token, address, subject, or body ever lands in the event", async () => {
  const sink = createMemoryVerifyJournal();
  await verify({ journal: sink });
  assert.equal(sink.events.length, 1);
  const ev = sink.events[0];
  assert.equal(ev.kind, "audit-checkpoint-link");
  assert.equal(ev.correlation_id, `m365-verify:${CONFIG.tenant_id}`);
  assert.deepEqual(ev.data.checks, { auth: "pass", read: "pass", send: "pass" });
  assert.equal(ev.data.native_message_id, "AAMk-sent-1");
  const serialized = JSON.stringify(ev);
  assert.ok(!/@/.test(serialized), "no email address in the journal event");
  assert.ok(!serialized.includes("tok"), "no access token in the journal event");
});

test("recordVerifyReport returns the same content-free event it records", () => {
  const sink = createMemoryVerifyJournal();
  const r = needsTenantReport(CONFIG, TS);
  const ev = recordVerifyReport(r, sink);
  assert.deepEqual(sink.events[0], ev);
  assert.equal(ev.data.status, "needs-tenant");
});

test("parseM365Config: valid config normalizes; a missing required field throws loudly", () => {
  const cfg = parseM365Config({
    tenant_id: "t",
    client_id: "c",
    test_recipient: "r@x.test",
    account: "  a@x.test  ",
  });
  assert.equal(cfg.account, "a@x.test");
  assert.equal(cfg.tenant_id, "t");
  assert.throws(() => parseM365Config({ tenant_id: "t", client_id: "c" }), /test_recipient/);
  assert.throws(() => parseM365Config("nope"), /must be a JSON object/);
});

// --- determinism ------------------------------------------------------------------------------

test("determinism: same transport + config + ts → identical report", async () => {
  const a = await verify();
  const b = await verify();
  assert.deepEqual(a, b);
});

// --- the bundled fixture transport (the shipped self-test path) --------------------------------

test("fixture transport 'happy': verified checks but claim stays 'not verified' (no live tenant)", async () => {
  const r = await verifyM365({
    transport: createFixtureTransport("happy"),
    config: CONFIG,
    ts: TS,
    sleep: NO_SLEEP,
  });
  assert.equal(r.verified, true);
  assert.equal(r.claim, "not verified");
});

test("fixture transport 'bad-token' / 'missing-scope' fail at auth; 'throttled' recovers", async () => {
  const bad = await verifyM365({
    transport: createFixtureTransport("bad-token"),
    config: CONFIG,
    ts: TS,
    sleep: NO_SLEEP,
  });
  assert.equal(bad.checks.auth.status, "fail");
  const miss = await verifyM365({
    transport: createFixtureTransport("missing-scope"),
    config: CONFIG,
    ts: TS,
    sleep: NO_SLEEP,
  });
  assert.equal(miss.checks.auth.code, M365_DIAGNOSTICS.AUTH_INSUFFICIENT_SCOPE);
  const thr = await verifyM365({
    transport: createFixtureTransport("throttled"),
    config: CONFIG,
    ts: TS,
    sleep: NO_SLEEP,
  });
  assert.equal(thr.checks.read.status, "pass");
});
