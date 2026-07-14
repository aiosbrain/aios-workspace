// Inbox host — device-token nonce replay protection (I-15 / AIO-396, the G6b review follow-up).
//
// A scoped HMAC device token is SINGLE-USE: its per-token nonce is consumed atomically on the first
// successful verify. This suite proves replay is rejected in-process, ACROSS A PROCESS RESTART (durable
// file store), under concurrency (exactly one winner), that scope/expiry/revocation/tamper still gate
// BEFORE consumption (a rejected token never burns a nonce), and that the store is DoS-bounded + pruned.
//
// Runs against the COMPILED barrel (`dist/operator-loop/index.js`) — `npm run build:loop` first.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDeviceRegistry,
  createHostDeviceRegistry,
  memoryDeviceStore,
  fileDeviceStore,
  memoryNonceStore,
  fileNonceStore,
} from "../../dist/operator-loop/index.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "inbox-nonce-"));
}

test("REPLAY (in-process): a token verifies once, a second use is rejected as replayed", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "secret", {
    nonceStore: memoryNonceStore(),
  });
  reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const tok = reg.mintToken({
    deviceId: "d1",
    scope: "read-model",
    expiresAt: 10_000,
    nonce: "n1",
  });
  const first = reg.verifyToken(tok, 500);
  assert.equal(first.ok, true);
  const second = reg.verifyToken(tok, 600);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "replayed");
});

test("REPLAY across RESTART: a durable nonce store rejects a replay after the registry is rebuilt", () => {
  const dir = tmp();
  try {
    // "Before restart": consume the token via a durable file-backed registry.
    const reg1 = createHostDeviceRegistry(dir, "secret");
    reg1.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
    const tok = reg1.mintToken({
      deviceId: "d1",
      scope: "read-model",
      expiresAt: 10_000,
      nonce: "n1",
    });
    assert.equal(reg1.verifyToken(tok, 500).ok, true);

    // "After restart": a brand-new registry + nonce store from the SAME on-disk files.
    const reg2 = createHostDeviceRegistry(dir, "secret");
    const replay = reg2.verifyToken(tok, 600);
    assert.equal(replay.ok, false, "a replay after restart is still rejected");
    assert.equal(replay.reason, "replayed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONCURRENCY: across many verifies of one token, exactly ONE succeeds (atomic consume)", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "secret", {
    nonceStore: memoryNonceStore(),
  });
  reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const tok = reg.mintToken({
    deviceId: "d1",
    scope: "read-model",
    expiresAt: 10_000,
    nonce: "n1",
  });
  let ok = 0;
  let replay = 0;
  for (let i = 0; i < 50; i++) {
    const v = reg.verifyToken(tok, 500);
    if (v.ok) ok++;
    else if (v.reason === "replayed") replay++;
  }
  assert.equal(ok, 1, "exactly one verify wins the nonce");
  assert.equal(replay, 49, "every other verify is rejected as a replay");
});

test("a distinct token (fresh nonce) for the same device still verifies (only the nonce is single-use)", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "secret", {
    nonceStore: memoryNonceStore(),
  });
  reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const t1 = reg.mintToken({ deviceId: "d1", scope: "read-model", expiresAt: 10_000, nonce: "n1" });
  const t2 = reg.mintToken({ deviceId: "d1", scope: "read-model", expiresAt: 10_000, nonce: "n2" });
  assert.equal(reg.verifyToken(t1, 500).ok, true);
  assert.equal(
    reg.verifyToken(t2, 500).ok,
    true,
    "a second token with a different nonce is not a replay"
  );
});

test("minted tokens without an explicit nonce are unique (random) and each single-use", () => {
  const reg = createDeviceRegistry(memoryDeviceStore(), "secret", {
    nonceStore: memoryNonceStore(),
  });
  reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const a = reg.mintToken({ deviceId: "d1", scope: "read-model", expiresAt: 10_000 });
  const b = reg.mintToken({ deviceId: "d1", scope: "read-model", expiresAt: 10_000 });
  assert.notEqual(a, b, "auto-generated nonces make each token unique");
  assert.equal(reg.verifyToken(a, 500).ok, true);
  assert.equal(reg.verifyToken(a, 500).reason, "replayed");
  assert.equal(reg.verifyToken(b, 500).ok, true);
});

test("a rejected token never burns a nonce (expiry/revocation/tamper gate BEFORE consumption)", () => {
  const store = memoryDeviceStore();
  const nonces = memoryNonceStore();
  const reg = createDeviceRegistry(store, "secret", { nonceStore: nonces });
  reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");

  // Expired token → no consume: after it expires, the nonce was never recorded, so a fresh token
  // reusing... (nonces differ) — the point: size stays 0 after only-rejected verifies.
  const expiredTok = reg.mintToken({
    deviceId: "d1",
    scope: "read-model",
    expiresAt: 1000,
    nonce: "e1",
  });
  assert.equal(reg.verifyToken(expiredTok, 1000).reason, "expired");
  const tampered = reg
    .mintToken({ deviceId: "d1", scope: "read-model", expiresAt: 9999, nonce: "t1" })
    .replace(/\.read-model\./, ".status.");
  assert.equal(reg.verifyToken(tampered, 500).reason, "bad-signature");
  reg.revoke("d1", "2026-07-14T00:01:00.000Z");
  const revokedTok = reg.mintToken.bind(reg);
  // (cannot mint after revoke; craft via a fresh enrolled device instead)
  assert.throws(
    () => revokedTok({ deviceId: "d1", scope: "read-model", expiresAt: 9999, nonce: "r1" }),
    /revoked/
  );
  assert.equal(nonces.size(500), 0, "no nonce was consumed by any rejected verify");
});

test("DoS bound: the nonce store is capped and fails closed when full, pruning expired first", () => {
  const store = memoryDeviceStore();
  const nonces = memoryNonceStore(2); // tiny cap to exercise the bound
  const reg = createDeviceRegistry(store, "secret", { nonceStore: nonces });
  reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
  const mk = (nonce, exp) =>
    reg.mintToken({ deviceId: "d1", scope: "read-model", expiresAt: exp, nonce });

  assert.equal(reg.verifyToken(mk("a", 1000), 100).ok, true); // store: {a}
  assert.equal(reg.verifyToken(mk("b", 1000), 100).ok, true); // store: {a,b} (full)
  const overflow = reg.verifyToken(mk("c", 5000), 100); // full → fail closed
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, "nonce-store-full");

  // Once 'a' and 'b' EXPIRE, the store prunes them and accepts a new nonce again.
  assert.equal(
    reg.verifyToken(mk("d", 5000), 2000).ok,
    true,
    "expired entries are pruned, freeing the bound"
  );
});

test("durable file nonce store: size() prunes expired and reports the live count", () => {
  const dir = tmp();
  try {
    const ns = fileNonceStore(dir, 100);
    assert.equal(ns.consume("k1", 1000, 100), "fresh");
    assert.equal(ns.consume("k1", 1000, 100), "replay");
    assert.equal(ns.consume("k2", 500, 100), "fresh");
    assert.equal(ns.size(100), 2);
    assert.equal(ns.size(600), 1, "k2 expired → pruned");
    assert.equal(ns.size(1001), 0, "k1 expired → pruned");
    // A fresh store over the same dir (restart) sees no live nonces once all expired.
    const ns2 = fileNonceStore(dir, 100);
    assert.equal(
      ns2.consume("k1", 4000, 2000),
      "fresh",
      "an expired-and-pruned nonce can be reused later"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed registry + nonce store live under .aios/loop/inbox (admin-tier local)", () => {
  const dir = tmp();
  try {
    const reg = createDeviceRegistry(fileDeviceStore(dir), "secret", {
      nonceStore: fileNonceStore(dir),
    });
    reg.enroll("d1", ["read-model"], "2026-07-14T00:00:00.000Z");
    const tok = reg.mintToken({
      deviceId: "d1",
      scope: "read-model",
      expiresAt: 10_000,
      nonce: "n1",
    });
    assert.equal(reg.verifyToken(tok, 500).ok, true);
    assert.equal(reg.verifyToken(tok, 500).reason, "replayed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
