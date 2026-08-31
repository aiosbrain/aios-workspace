// scripts/connector.mjs — vaultSet() used to throw a bare "vault: failed to store {env}"
// with zero diagnosis regardless of cause, which was the confirmed root cause of the
// dogfood complaint "Vault failed to store notion token! Not sure why." This asserts the
// real cause is now distinguishable (dotenvx missing from PATH), plus a real bug found
// while writing these tests: an ambient DOTENV_PUBLIC_KEY in the caller's shell silently
// broke per-workspace key generation.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vaultSet, vaultGet } from "../scripts/connector.mjs";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "vault-error-"));
}

test("vaultSet succeeds and vaultGet reads the value back (baseline, real dotenvx)", () => {
  const dir = ws();
  try {
    vaultSet(dir, "TEST_TOKEN", "a-real-value");
    assert.equal(vaultGet(dir, "TEST_TOKEN"), "a-real-value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vaultSet no longer depends on PATH at all (AIO-1004)", () => {
  // This test used to assert the actionable "dotenvx isn't on PATH" error when PATH was
  // emptied. Since AIO-1004 the vault resolves the toolkit's own @dotenvx/dotenvx via Node
  // module resolution and runs it under process.execPath, so an empty PATH must now
  // SUCCEED — the stronger property. (The bare-PATH error message still exists, but only
  // as the final fallback for an install carrying no @dotenvx/dotenvx at all — see
  // test/connector-dotenvx-resolution.test.mjs for the layout matrix.)
  const dir = ws();
  const savedPath = process.env.PATH;
  process.env.PATH = ""; // nothing resolvable from PATH, including any global dotenvx
  try {
    vaultSet(dir, "TEST_TOKEN", "a-real-value");
    assert.equal(vaultGet(dir, "TEST_TOKEN"), "a-real-value");
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vaultGet tolerates dotenvx 2.x's non-zero exit on an unreadable SIBLING key (AIO-790 shape)", () => {
  // dotenvx 2.x exits non-zero on `get KEY` when any OTHER key in the .env fails to
  // decrypt, even though it printed the requested value on stdout. With the resolver
  // pinning 2.x everywhere (AIO-1004), vaultGet must read stdout regardless of exit
  // status — otherwise a mixed-key .env (the exact shape of this repo's own .env) makes
  // every stored secret read back as "" and vaultSet's roundtrip reports it didn't take.
  const dir = ws();
  try {
    vaultSet(dir, "GOOD_TOKEN", "good-value");
    // Sibling ciphertext the workspace keypair cannot read — same synthetic recipe as
    // test/linear-dotenvx-scope.test.mjs; not a production secret.
    appendFileSync(
      path.join(dir, ".env"),
      "UNRELATED_API_KEY=encrypted:BNotARealCiphertextForAIO1004==\n"
    );
    assert.equal(vaultGet(dir, "GOOD_TOKEN"), "good-value");
    // A fresh write to the now-mixed file must still roundtrip-verify successfully.
    vaultSet(dir, "OTHER_TOKEN", "other-value");
    assert.equal(vaultGet(dir, "OTHER_TOKEN"), "other-value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vaultGet accepts legitimate secrets whose PLAINTEXT is shaped like an error", () => {
  // Round 2 of the PR #663 review: success must be decided by evidence about the
  // requested key (ciphertext passthrough), not by scanning the plaintext for
  // error-shaped substrings — a real secret may legitimately start with "encrypted:"
  // or contain a string like DECRYPTION_FAILED, and a blocklist would make its
  // vaultSet roundtrip fail forever.
  const dir = ws();
  try {
    vaultSet(dir, "TRICKY_PREFIX", "encrypted:not-actually-ciphertext");
    assert.equal(vaultGet(dir, "TRICKY_PREFIX"), "encrypted:not-actually-ciphertext");
    vaultSet(dir, "TRICKY_SUBSTR", "abc-DECRYPTION_FAILED-xyz");
    assert.equal(vaultGet(dir, "TRICKY_SUBSTR"), "abc-DECRYPTION_FAILED-xyz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vaultGet still fails closed when the REQUESTED key is genuinely unreadable", () => {
  const dir = ws();
  try {
    vaultSet(dir, "GOOD_TOKEN", "good-value"); // establishes the workspace keypair
    appendFileSync(path.join(dir, ".env"), "BAD_TOKEN=encrypted:BNotARealCiphertextForAIO1004==\n");
    // The requested key itself can't decrypt → "" (fail closed), never the ciphertext
    // and never a decryption-error string surfaced as if it were the secret.
    assert.equal(vaultGet(dir, "BAD_TOKEN"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ambient DOTENV_PUBLIC_KEY in the caller's shell no longer breaks this workspace's vault", () => {
  // Discovered live in this repo's own dev environment (an env cascade sets a global
  // DOTENV_PUBLIC_KEY): dotenvx prioritizes an ambient key over the repo's own
  // .env.keys, so `set` silently encrypts against the WRONG key and `get` can never
  // decrypt it back — exactly the unexplained "vault failed" symptom from the audit,
  // just one layer deeper. vaultSet/vaultGet must strip both DOTENV_* vars from the
  // child process env so a workspace's own .env.keys always wins.
  const dir = ws();
  const saved = { pub: process.env.DOTENV_PUBLIC_KEY, priv: process.env.DOTENV_PRIVATE_KEY };
  process.env.DOTENV_PUBLIC_KEY = "0".repeat(66); // syntactically key-shaped, deliberately wrong
  process.env.DOTENV_PRIVATE_KEY = "1".repeat(64);
  try {
    vaultSet(dir, "TEST_TOKEN", "a-real-value");
    assert.equal(vaultGet(dir, "TEST_TOKEN"), "a-real-value");
  } finally {
    if (saved.pub === undefined) delete process.env.DOTENV_PUBLIC_KEY;
    else process.env.DOTENV_PUBLIC_KEY = saved.pub;
    if (saved.priv === undefined) delete process.env.DOTENV_PRIVATE_KEY;
    else process.env.DOTENV_PRIVATE_KEY = saved.priv;
    rmSync(dir, { recursive: true, force: true });
  }
});
