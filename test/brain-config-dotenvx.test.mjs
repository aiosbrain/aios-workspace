// test/brain-config-dotenvx.test.mjs — F-C6 (AIO-367): the CLI must tell "genuinely no API key"
// apart from "key present but still dotenvx-encrypted" and, where possible, decrypt it via
// .env.keys rather than fail with the misleading "no API key found in $AIOS_API_KEY (env or
// .env)". Uses this repo's own vendored dotenvx binary (node_modules/.bin/dotenvx) to produce a
// REAL encrypted .env + .env.keys pair, not a hand-rolled fixture, so the decrypt path is
// exercised against the actual ciphertext format.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isDotenvxEncrypted,
  decryptDotenvKey,
  resolveBrainConfig,
} from "../scripts/brain-config.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOTENVX_BIN = path.join(ROOT, "node_modules", ".bin", "dotenvx");

function tmpRepo() {
  return mkdtempSync(path.join(tmpdir(), "braincfg-dotenvx-"));
}

// Strip any ambient dotenvx keypair from the environment so encryption always uses the temp
// repo's own freshly-generated .env.keys (mirrors scripts/connector.mjs's dotenvxEnv()).
function strippedEnv() {
  const env = { ...process.env };
  delete env.DOTENV_PUBLIC_KEY;
  delete env.DOTENV_PRIVATE_KEY;
  return env;
}

/** Real dotenvx encryption via the vendored CLI — produces a genuine ciphertext + .env.keys. */
function dotenvxSet(repo, key, value) {
  const envPath = path.join(repo, ".env");
  if (!existsSync(envPath)) writeFileSync(envPath, "");
  execFileSync(DOTENVX_BIN, ["set", key, value, "-f", envPath], {
    cwd: repo,
    env: strippedEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("isDotenvxEncrypted: true for a DOTENV_PUBLIC_KEY header", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(
      path.join(repo, ".env"),
      'DOTENV_PUBLIC_KEY="0123abc"\nAIOS_API_KEY=encrypted:BAbc123==\n'
    );
    assert.equal(isDotenvxEncrypted(repo), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("isDotenvxEncrypted: false for a plain .env with a real value", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(path.join(repo, ".env"), "AIOS_API_KEY=plain-real-key\n");
    assert.equal(isDotenvxEncrypted(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("isDotenvxEncrypted: false when .env doesn't exist", () => {
  const repo = tmpRepo();
  try {
    assert.equal(isDotenvxEncrypted(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("decryptDotenvKey: returns '' when .env.keys is missing (encrypted but can't decrypt)", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(
      path.join(repo, ".env"),
      'DOTENV_PUBLIC_KEY="0123abc"\nAIOS_API_KEY=encrypted:BAbc123==\n'
    );
    // No .env.keys written — decryption must fail closed, not throw.
    assert.equal(decryptDotenvKey(repo, "AIOS_API_KEY"), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("decryptDotenvKey: decrypts a real dotenvx-encrypted value via .env.keys", () => {
  const repo = tmpRepo();
  try {
    dotenvxSet(repo, "AIOS_API_KEY", "aios_k_real_secret_123");
    assert.ok(existsSync(path.join(repo, ".env.keys")), "dotenvx set should generate .env.keys");
    assert.equal(isDotenvxEncrypted(repo), true);
    assert.equal(decryptDotenvKey(repo, "AIOS_API_KEY"), "aios_k_real_secret_123");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveBrainConfig: plain .env with a real key still works as before", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(path.join(repo, "aios.yaml"), "brain_url: https://brain.example\nteam_id: t\n");
    writeFileSync(path.join(repo, ".env"), "AIOS_API_KEY=plain-real-key\n");
    const saved = process.env.AIOS_API_KEY;
    delete process.env.AIOS_API_KEY;
    try {
      const cfg = resolveBrainConfig(repo);
      assert.equal(cfg.api_key, "plain-real-key");
      assert.equal(cfg.dotenvx_encrypted, false);
    } finally {
      if (saved == null) delete process.env.AIOS_API_KEY;
      else process.env.AIOS_API_KEY = saved;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveBrainConfig: dotenvx-encrypted .env + matching .env.keys decrypts transparently", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(path.join(repo, "aios.yaml"), "brain_url: https://brain.example\nteam_id: t\n");
    dotenvxSet(repo, "AIOS_API_KEY", "aios_k_scheduled_run_secret");
    const saved = process.env.AIOS_API_KEY;
    delete process.env.AIOS_API_KEY;
    try {
      const cfg = resolveBrainConfig(repo);
      assert.equal(cfg.api_key, "aios_k_scheduled_run_secret");
      assert.equal(cfg.dotenvx_encrypted, false); // resolved fine — no error state
    } finally {
      if (saved == null) delete process.env.AIOS_API_KEY;
      else process.env.AIOS_API_KEY = saved;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveBrainConfig: dotenvx-encrypted .env with NO .env.keys -> empty key + dotenvx_encrypted flag", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(path.join(repo, "aios.yaml"), "brain_url: https://brain.example\nteam_id: t\n");
    // Shaped exactly like a dotenvx-encrypted .env, but no .env.keys anywhere — simulates a
    // scheduled run on a machine (or worktree) that never got the keypair. A key name unique to
    // this test avoids resolveBrainConfig's toolkit-root fallback finding a REAL, decryptable
    // AIOS_API_KEY in this checkout's own .env (this repo IS the toolkit root in these tests).
    const keyEnv = "AIOS_TEST_NO_KEYS_UNIQUE_KEY";
    writeFileSync(
      path.join(repo, ".env"),
      `DOTENV_PUBLIC_KEY="0123abc"\n${keyEnv}=encrypted:BAbc123XyzNeverDecryptable==\n`
    );
    const saved = process.env[keyEnv];
    delete process.env[keyEnv];
    try {
      const cfg = resolveBrainConfig(repo, { apiKeyEnv: keyEnv });
      assert.equal(cfg.api_key, "");
      assert.equal(cfg.dotenvx_encrypted, true);
    } finally {
      if (saved == null) delete process.env[keyEnv];
      else process.env[keyEnv] = saved;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
