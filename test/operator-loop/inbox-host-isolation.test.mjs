// Inbox host isolation — credential broker + device identity (I-15 / AIO-396, the G6b gate).
//
// The pilot-host isolation bar, unit-verified against the SAME compiled logic the deploy-verification
// script (`scripts/inbox-host-verify.mjs`) drives on the live machine:
//   • ISOLATION  — an adapter reads only its own credential (scope + fs fence); no shared credentials.
//   • ENROLLMENT — an enrolled device reaches the read-model API with a scoped token.
//   • REVOCATION — a revoked device is rejected even with a valid, unexpired signature.
// Plus: the verify script's `--self-test` exits 0 here, and `--live` is refused (merge-gated).
//
// Runs against the COMPILED barrel (`dist/operator-loop/index.js`) — `npm run build:loop` first.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCredentialBroker,
  CredentialScopeError,
  crossScopeLeaks,
  checkPathAccess,
  checkEgress,
  STORE_RESERVED_KEYS,
  createDeviceRegistry,
  memoryDeviceStore,
  fileDeviceStore,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERIFY = path.join(ROOT, "scripts", "inbox-host-verify.mjs");

const SCOPES = { gmail: ["gmail.token"], telegram: ["telegram.session"] };
const SECRETS = { "gmail.token": "g-secret", "telegram.session": "t-secret" };

// ── credential broker ────────────────────────────────────────────────────────────────────────────

test("ISOLATION: an adapter reads ONLY its own credential; a cross-adapter read is denied", () => {
  const broker = createCredentialBroker(SCOPES, (k) => SECRETS[k]);
  assert.equal(broker.read("gmail", "gmail.token"), "g-secret");
  assert.throws(() => broker.read("telegram", "gmail.token"), CredentialScopeError);
  assert.throws(() => broker.read("gmail", "telegram.session"), CredentialScopeError);
  assert.equal(broker.canAccess("gmail", "gmail.token"), true);
  assert.equal(broker.canAccess("gmail", "telegram.session"), false);
});

test("ISOLATION: an unknown adapter and a scoped-but-unresolved credential both throw (default-deny)", () => {
  const broker = createCredentialBroker(SCOPES, (k) => SECRETS[k]);
  assert.throws(() => broker.read("stranger", "gmail.token"), CredentialScopeError);
  const brokerMissing = createCredentialBroker(SCOPES, () => undefined);
  assert.throws(() => brokerMissing.read("gmail", "gmail.token"), /unresolved/);
});

test("ISOLATION: the read-model store keys are reserved and never brokerable", () => {
  for (const reserved of STORE_RESERVED_KEYS) {
    // Cannot be granted in a scope (fail-closed config)…
    assert.throws(
      () => createCredentialBroker({ gmail: [reserved] }, () => "x"),
      CredentialScopeError
    );
    // …and cannot be read even by an adapter that somehow names it.
    const broker = createCredentialBroker(SCOPES, () => "x");
    assert.equal(broker.canAccess("gmail", reserved), false);
    assert.throws(() => broker.read("gmail", reserved), CredentialScopeError);
  }
});

test("ISOLATION: crossScopeLeaks flags any credential granted to two adapters", () => {
  assert.deepEqual(crossScopeLeaks(SCOPES), [], "well-formed scopes have no shared credentials");
  const shared = { gmail: ["shared.key"], telegram: ["shared.key"] };
  const leaks = crossScopeLeaks(shared);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].key, "shared.key");
  assert.deepEqual(leaks[0].adapters, ["gmail", "telegram"]);
});

test("ISOLATION: the fs sandbox denies cross-adapter paths + directory-traversal escapes", () => {
  const gmail = {
    adapter: "gmail",
    uid: 10001,
    allowedPathPrefixes: ["/data/adapters/gmail"],
    allowedEgressHosts: ["gmail.googleapis.com"],
  };
  assert.equal(checkPathAccess(gmail, "/data/adapters/gmail/token.json"), true);
  assert.equal(checkPathAccess(gmail, "/data/adapters/telegram/session.key"), false);
  assert.equal(
    checkPathAccess(gmail, "/data/adapters/gmail/../telegram/session.key"),
    false,
    "traversal blocked"
  );
  assert.equal(
    checkPathAccess(gmail, "/data/adapters/gmail-other/x"),
    false,
    "prefix is path-segment aware"
  );
  assert.equal(checkEgress(gmail, "gmail.googleapis.com"), true);
  assert.equal(checkEgress(gmail, "evil.example.com"), false);
});

// ── device identity ──────────────────────────────────────────────────────────────────────────────

test("ENROLLMENT: an enrolled device gets a scoped token that verifies for its scope", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "host-secret");
  reg.enroll("dev-1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const tok = reg.mintToken({
    deviceId: "dev-1",
    scope: "read-model",
    expiresAt: 1000,
    nonce: "n1",
  });
  const v = reg.verifyToken(tok, 500);
  assert.equal(v.ok, true);
  assert.equal(v.deviceId, "dev-1");
  assert.equal(v.scope, "read-model");
});

test("ENROLLMENT: minting for an un-enrolled scope is refused", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "host-secret");
  reg.enroll("dev-1", ["read-model"], "2026-07-14T00:00:00.000Z");
  assert.throws(
    () => reg.mintToken({ deviceId: "dev-1", scope: "status", expiresAt: 1000, nonce: "n" }),
    /not enrolled/
  );
  assert.throws(
    () => reg.mintToken({ deviceId: "ghost", scope: "read-model", expiresAt: 1000, nonce: "n" }),
    /unknown device/
  );
});

test("REVOCATION: a revoked device is rejected even with a valid, unexpired token", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "host-secret");
  reg.enroll("dev-1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const tok = reg.mintToken({
    deviceId: "dev-1",
    scope: "read-model",
    expiresAt: 10_000,
    nonce: "n1",
  });
  assert.equal(reg.verifyToken(tok, 500).ok, true);
  assert.equal(reg.revoke("dev-1", "2026-07-14T00:01:00.000Z"), true);
  const v = reg.verifyToken(tok, 600);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "revoked");
  // A revoked device cannot mint a new token either.
  assert.throws(
    () => reg.mintToken({ deviceId: "dev-1", scope: "read-model", expiresAt: 20_000, nonce: "n2" }),
    /revoked/
  );
});

test("REVOCATION/tamper: expiry, field-tamper, bad secret, and malformed tokens all fail closed", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "host-secret");
  reg.enroll("dev-1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const tok = reg.mintToken({
    deviceId: "dev-1",
    scope: "read-model",
    expiresAt: 1000,
    nonce: "n1",
  });
  assert.equal(reg.verifyToken(tok, 1000).reason, "expired", "exp is exclusive");
  assert.equal(reg.verifyToken(tok, 1001).reason, "expired");
  assert.equal(
    reg.verifyToken(tok.replace(/\.read-model\./, ".status."), 500).reason,
    "bad-signature"
  );
  assert.equal(reg.verifyToken("a.b.c", 500).reason, "malformed");
  // A different host secret must not accept a token minted under the real one.
  const other = createDeviceRegistry(
    memoryDeviceStore([
      { device_id: "dev-1", scopes: ["read-model"], enrolled_at: "x", revoked_at: null },
    ]),
    "OTHER-secret"
  );
  assert.equal(other.verifyToken(tok, 500).reason, "bad-signature");
});

test("device registry survives a coordinator restart via the file-backed store", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "inbox-host-dev-"));
  try {
    const store = fileDeviceStore(dir);
    const reg = createDeviceRegistry(store, "host-secret");
    reg.enroll("dev-1", ["read-model", "status"], "2026-07-14T00:00:00.000Z");
    reg.revoke("dev-1", "2026-07-14T00:05:00.000Z");
    // A brand-new registry from the SAME on-disk store (a restart) sees the enrollment + revocation.
    const reg2 = createDeviceRegistry(fileDeviceStore(dir), "host-secret");
    const rec = reg2.get("dev-1");
    assert.ok(rec);
    assert.deepEqual(rec.scopes, ["read-model", "status"]);
    assert.equal(rec.revoked_at, "2026-07-14T00:05:00.000Z");
    const tok = reg2.mintToken.bind(reg2);
    assert.throws(
      () => tok({ deviceId: "dev-1", scope: "read-model", expiresAt: 1000, nonce: "n" }),
      /revoked/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── deploy-verification script ─────────────────────────────────────────────────────────────────────

function runVerify(args) {
  try {
    const stdout = execFileSync("node", [VERIFY, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("the deploy-verification script self-test passes (isolation · enrollment · revocation)", () => {
  const res = runVerify(["--self-test", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.mode, "self-test");
  assert.equal(out.ok, true);
  assert.ok(out.checks.length >= 5, "covers isolation, enrollment, revocation");
  assert.ok(out.checks.every((c) => c.pass));
});

test("the deploy-verification script REFUSES --live (merge-gated on I-11)", () => {
  const res = runVerify(["--live"]);
  assert.equal(res.code, 2, "live is refused pre-merge");
  assert.match(res.stderr, /MERGE-GATED/);
  assert.match(res.stderr, /I-11/);
});
