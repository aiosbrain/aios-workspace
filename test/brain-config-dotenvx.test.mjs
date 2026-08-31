// test/brain-config-dotenvx.test.mjs — F-C6 (AIO-367): the CLI must tell "genuinely no API key"
// apart from "key present but still dotenvx-encrypted" and, where possible, decrypt it via
// .env.keys rather than fail with the misleading "no API key found in $AIOS_API_KEY (env or
// .env)". Uses this repo's own vendored dotenvx binary (node_modules/.bin/dotenvx) to produce a
// REAL encrypted .env + .env.keys pair, not a hand-rolled fixture, so the decrypt path is
// exercised against the actual ciphertext format.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isDotenvxEncrypted,
  decryptDotenvKey,
  dotenvxEncryptedHint,
  resolveBrainConfig,
} from "../scripts/brain-config.mjs";
import {
  assertSecretEqual,
  registerSecretSentinel,
  scrubAmbientProcessEnv,
  scrubEnv,
} from "./helpers/scrubbed-env.mjs";

// AIO-1028: neutralize the ambient environment before any fixture assertion. On a direnv
// machine the Tessera cascade exports a REAL AIOS_API_KEY, and `dotenvx get` prefers the
// ambient environment over the on-disk .env — so without this, the decrypt assertions below
// compare the fixture against the developer's live key (and print it on failure). Each test
// file runs in its own process, so scrubbing process.env here cannot affect other files.
scrubAmbientProcessEnv();

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
    assertSecretEqual(
      decryptDotenvKey(repo, "AIOS_API_KEY"),
      "aios_k_real_secret_123",
      "decryptDotenvKey fixture roundtrip"
    );
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
      assertSecretEqual(cfg.api_key, "plain-real-key", "plain .env api_key");
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
      assertSecretEqual(cfg.api_key, "aios_k_scheduled_run_secret", "decrypted api_key");
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

// ── AIO-1028 controls ─────────────────────────────────────────────────────────────────────

// Decoy control: seed a decoy ambient credential (exactly what direnv did with the real
// one) and prove the on-disk fixture wins under the scrubbed child environment. The paired
// NEGATIVE control runs the identical child with the scrubber deliberately disabled and
// requires the decoy to win — proving the positive assertion depends on the mechanism,
// not on the machine happening to be credential-free.
test("decoy control: ambient decoy loses to the fixture under scrubEnv (and wins without it)", () => {
  const repo = tmpRepo();
  try {
    const fixture = "aios_k_fixture_wins_1028";
    const decoy = "aios_k_decoy_ambient_1028";
    registerSecretSentinel(decoy);
    dotenvxSet(repo, "AIOS_API_KEY", fixture);
    const brainConfigUrl = pathToFileURL(path.join(ROOT, "scripts", "brain-config.mjs")).href;
    // The child prints a verdict, never a value — no secret can reach a log from here.
    const script = [
      `import { decryptDotenvKey } from ${JSON.stringify(brainConfigUrl)};`,
      `const v = decryptDotenvKey(${JSON.stringify(repo)}, "AIOS_API_KEY");`,
      `process.stdout.write(v === ${JSON.stringify(fixture)} ? "fixture-wins" : v === ${JSON.stringify(decoy)} ? "decoy-wins" : "neither");`,
    ].join("\n");
    const run = (opts) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: scrubEnv({ ...process.env, AIOS_API_KEY: decoy }, opts),
        encoding: "utf8",
      });
    assert.equal(run({}).stdout, "fixture-wins", "fixture must win under the scrubbed env");
    assert.equal(
      run({ disableScrub: true }).stdout,
      "decoy-wins",
      "NEGATIVE CONTROL: with the scrubber disabled the ambient decoy must win — if it " +
        "doesn't, the positive assertion above is not testing the scrubber at all"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Both directions (AIO-1028 lane design, point 2): fixture-only resolution succeeding is
// covered above; this asserts the other direction — with the fixture unusable, the caller
// gets the stable actionable bootstrap hint (naming the next command), not the
// self-referential "no API key found" class of error (#639).
test("without a usable fixture, resolution surfaces the actionable bootstrap hint", () => {
  const repo = tmpRepo();
  try {
    writeFileSync(path.join(repo, "aios.yaml"), "brain_url: https://brain.example\nteam_id: t\n");
    // Unique key name: resolveBrainConfig's toolkit-root fallback would otherwise find and
    // decrypt this checkout's own real AIOS_API_KEY (this repo IS the toolkit root here).
    const keyEnv = "AIOS_TEST_BOOTSTRAP_HINT_KEY";
    writeFileSync(
      path.join(repo, ".env"),
      `DOTENV_PUBLIC_KEY="0123abc"\n${keyEnv}=encrypted:BAbc123NeverDecryptable==\n`
    );
    const cfg = resolveBrainConfig(repo, { apiKeyEnv: keyEnv });
    assert.equal(cfg.api_key, "");
    assert.equal(cfg.dotenvx_encrypted, true);
    const hint = dotenvxEncryptedHint(cfg);
    assert.match(hint, /dotenvx run -- aios push/, "hint must name the runnable command");
    assert.match(hint, new RegExp(`\\$${keyEnv}`), "hint must name the exact env var to set");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The decrypt path above only works OUTSIDE this repo because the published package vendors
// dotenvx: resolveDotenvxBin() prefers <toolkit>/node_modules/.bin/dotenvx and falls back to a
// bare `dotenvx` on PATH, which a plain npm install of the toolkit cannot assume. Shipping
// dotenvx as a devDependency made every one of these tests green in the checkout while the
// tarball install could not decrypt anything on a machine without a global dotenvx (masked on
// dev machines by direnv exporting the keys). The full property is asserted from the installed
// artifact in npm-pack-golden-path.test.mjs (4e); this is the fast in-repo guard.
test("dotenvx is a runtime dependency, so the F-C6 decrypt path survives a tarball install", () => {
  const pkg = JSON.parse(
    execFileSync(process.execPath, ["-p", "JSON.stringify(require('./package.json'))"], {
      cwd: ROOT,
      encoding: "utf8",
    })
  );
  assert.ok(
    pkg.dependencies?.["@dotenvx/dotenvx"],
    "@dotenvx/dotenvx must be in dependencies (not devDependencies): resolveDotenvxBin() needs the vendored binary in a production install"
  );
});
