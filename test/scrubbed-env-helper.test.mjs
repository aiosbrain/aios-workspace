// test/scrubbed-env-helper.test.mjs — AIO-1028: self-test of the scrubbed-env helper,
// including the mandatory negative controls. Every positive assertion here has a paired
// proof that it FAILS when the mechanism is deliberately disabled — otherwise the decoy
// controls in the connector suites would prove nothing.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSecretEqual,
  fingerprint,
  isScrubbedName,
  redact,
  registerSecretSentinel,
  scrubAmbientProcessEnv,
  scrubEnv,
} from "./helpers/scrubbed-env.mjs";

// Decoys are synthetic. Registered as sentinels by scrubEnv/assertSecretEqual anyway, but
// keep them obviously fake.
const DECOYS = {
  AIOS_API_KEY: "aios_k_fake_decoy_ambient_1028",
  LINEAR_API_KEY: "lin_api_fake_decoy_ambient_1028",
  SLACK_USER_TOKEN: "xoxp-fake-decoy-ambient-1028",
  GRANOLA_API_KEY: "grn_fake_decoy_ambient_1028",
  OPENAI_API_KEY: "sk-fake-decoy-ambient-1028",
  DOTENV_PRIVATE_KEY: "d".repeat(64),
  DOTENV_PUBLIC_KEY: "0".repeat(66),
  AIOS_TOOLKIT_DIR: "/decoy/workspace/root",
  BRAIN_URL: "https://decoy.example",
};

test("isScrubbedName covers the provider, AIOS, dotenvx and workspace-root families", () => {
  for (const name of Object.keys(DECOYS)) {
    assert.equal(isScrubbedName(name), true, `${name} must be scrubbed`);
  }
  assert.equal(isScrubbedName("DOTENV_PRIVATE_KEY_PRODUCTION"), true);
  // and leaves ordinary variables alone
  for (const name of ["PATH", "HOME", "TMPDIR", "NODE_OPTIONS", "LANG", "PWD"]) {
    assert.equal(isScrubbedName(name), false, `${name} must survive the scrub`);
  }
});

test("scrubEnv removes every decoy ambient credential and keeps the rest", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x", ...DECOYS };
  const env = scrubEnv(base);
  for (const name of Object.keys(DECOYS)) {
    assert.equal(name in env, false, `${name} leaked through the scrubber`);
  }
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
});

test("NEGATIVE CONTROL: with the scrubber disabled the same assertion fails", () => {
  // Prove the test above depends on the mechanism: break the mechanism, run the same
  // assertion body, and require it to throw. If this ever passes with the scrubber off,
  // the decoy control is asserting nothing.
  const base = { PATH: "/usr/bin", ...DECOYS };
  const broken = scrubEnv(base, { disableScrub: true });
  assert.throws(
    () => {
      for (const name of Object.keys(DECOYS)) {
        assert.equal(name in broken, false, `${name} leaked through the scrubber`);
      }
    },
    assert.AssertionError,
    "disableScrub must let the decoys through — the positive test would be vacuous otherwise"
  );
});

test("scrubEnv({ add }) lets a test opt a named synthetic value back in", () => {
  const env = scrubEnv({ ...DECOYS, PATH: "/usr/bin" }, { add: { AIOS_API_KEY: "synthetic" } });
  assert.equal(env.AIOS_API_KEY, "synthetic");
  assert.equal("LINEAR_API_KEY" in env, false);
});

test("scrubAmbientProcessEnv scrubs process.env and restore() puts it back exactly", () => {
  const name = "AIOS_HELPER_SELFTEST_KEY";
  const untouched = "SCRUBBED_ENV_SELFTEST_PLAIN";
  process.env[name] = "aios_k_selftest_value";
  process.env[untouched] = "stays";
  try {
    const restore = scrubAmbientProcessEnv();
    assert.equal(process.env[name], undefined, "scrubbed name must be deleted");
    assert.equal(process.env[untouched], "stays", "non-scrubbed name must survive");
    restore();
    assert.equal(process.env[name], "aios_k_selftest_value", "restore must reinstate");
  } finally {
    delete process.env[name];
    delete process.env[untouched];
  }
});

test("assertSecretEqual: failure output carries fingerprints, never the values", () => {
  const secretA = "aios_k_redaction_selftest_actual";
  const secretB = "aios_k_redaction_selftest_expected";
  let thrown;
  try {
    assertSecretEqual(secretA, secretB, "redaction self-test");
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof assert.AssertionError, "mismatch must throw");
  const surfaces = [thrown.message, thrown.actual, thrown.expected, thrown.stack ?? ""].join("\n");
  assert.equal(surfaces.includes(secretA), false, "actual value leaked into failure output");
  assert.equal(surfaces.includes(secretB), false, "expected value leaked into failure output");
  assert.match(thrown.message, /redacted sha256:/);
  // equality still passes silently
  assertSecretEqual(secretA, secretA);
});

test("redact strips registered sentinels and credential-shaped strings", () => {
  const sentinel = "totally-custom-shape-sentinel-1028";
  registerSecretSentinel(sentinel);
  const noisy = `left ${sentinel} middle lin_api_abcdef123456 right sk-abcDEF7890`;
  const clean = redact(noisy);
  assert.equal(clean.includes(sentinel), false);
  assert.equal(clean.includes("lin_api_abcdef123456"), false);
  assert.equal(clean.includes("sk-abcDEF7890"), false);
  assert.match(clean, /left \[redacted sha256:[0-9a-f]{8} len:\d+\] middle/);
});

test("fingerprint distinguishes values without revealing them", () => {
  assert.equal(fingerprint(""), "«empty»");
  assert.equal(fingerprint(undefined), "«undefined»");
  assert.notEqual(fingerprint("a-secret"), fingerprint("b-secret"));
  assert.equal(fingerprint("a-secret"), fingerprint("a-secret"));
  assert.equal(fingerprint("a-secret").includes("a-secret"), false);
});
