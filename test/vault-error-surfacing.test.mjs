// scripts/connector.mjs — vaultSet() used to throw a bare "vault: failed to store {env}"
// with zero diagnosis regardless of cause, which was the confirmed root cause of the
// dogfood complaint "Vault failed to store notion token! Not sure why." This asserts the
// real cause is now distinguishable (dotenvx missing from PATH), plus a real bug found
// while writing these tests: an ambient DOTENV_PUBLIC_KEY in the caller's shell silently
// broke per-workspace key generation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

test("vaultSet names the real cause when dotenvx isn't on PATH", () => {
  const dir = ws();
  const savedPath = process.env.PATH;
  process.env.PATH = ""; // dotenvx (and everything else) unresolvable
  try {
    assert.throws(() => vaultSet(dir, "TEST_TOKEN", "value"), /dotenvx isn't on PATH/);
  } finally {
    process.env.PATH = savedPath;
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
