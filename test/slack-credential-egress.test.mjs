// AIO-1068 round 4 — credential-egress guards: no token value may ever reach stdout,
// stderr, an error message, or the JSON error surface. Synthetic, marker-compliant
// tokens only; every spawn also asserts zero provider/brain requests where applicable.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AIOS, SLACK_BIN, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

const RAW_TOKEN = "xoxp-NOT-REAL-raw-token-stored-in-config";

test("a raw token stored as credentialSources.slack is never echoed anywhere", () => {
  const env = scrubbedEnv();
  mkdirSync(env.AIOS_CONFIG_DIR, { recursive: true });
  writeFileSync(
    path.join(env.AIOS_CONFIG_DIR, "config.json"),
    `${JSON.stringify({ schemaVersion: 2, credentialSources: { slack: RAW_TOKEN } })}\n`
  );
  for (const [bin, args] of [
    [AIOS, ["slack", "whoami"]],
    [SLACK_BIN, ["whoami"]],
  ]) {
    const result = runSlack(bin, args, { env });
    assert.equal(result.status, 3, result.stderr);
    // Whichever layer fires (the config broker's rejectSecrets, or the adapter's own
    // parse guard behind it) must name the problem and its location…
    assert.match(result.stderr, /credential reference|credentialSources\.slack/i);
    // …and the value must appear ZERO times on either stream.
    const everything = `${result.stdout}\n${result.stderr}`;
    assert.ok(!everything.includes(RAW_TOKEN), "raw token leaked to stdout/stderr");
    assert.ok(!everything.includes(RAW_TOKEN.slice(5)), "raw token fragment leaked");
    assert.deepEqual(result.requests, [], "no request may leave on a config failure");
  }
});

test("an unresolvable but VALID reference names only its kind:locator", () => {
  const env = scrubbedEnv();
  mkdirSync(env.AIOS_CONFIG_DIR, { recursive: true });
  writeFileSync(
    path.join(env.AIOS_CONFIG_DIR, "config.json"),
    `${JSON.stringify({ schemaVersion: 2, credentialSources: { slack: "env:AIOS_MISSING_SLACK_VAR" } })}\n`
  );
  const result = runSlack(AIOS, ["slack", "whoami"], { env });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /env:AIOS_MISSING_SLACK_VAR/, "the locator is safe to name");
  assert.match(result.stderr, /did not resolve/);
  assert.deepEqual(result.requests, []);
});

test("the reference parser can never hand a raw secret to a message", async () => {
  const { parseSlackCredentialReference, resolveSlackReferenceValue } =
    await import("../scripts/connectors/slack/credentials.mjs");
  for (const notARef of [RAW_TOKEN, "xoxb-NOT-REAL-x", "plain-string", "env:", "keychain:", ""]) {
    assert.equal(parseSlackCredentialReference(notARef), null, notARef);
    assert.equal(resolveSlackReferenceValue(notARef, { env: {} }), null, notARef);
  }
  assert.deepEqual(parseSlackCredentialReference("env:SOME_VAR"), {
    kind: "env",
    locator: "SOME_VAR",
  });
  assert.deepEqual(parseSlackCredentialReference("keychain:aios-slack"), {
    kind: "keychain",
    locator: "aios-slack",
  });
});

test("token-shaped argv values are masked in usage errors, not echoed — BOTH routes", () => {
  const env = scrubbedEnv();
  // A pasted token in the verb slot. The compat bin's deprecation BANNER echoes this slot
  // too (round-5 finding 1), so the assertion covers the banner and the error line alike.
  for (const [bin, argv] of [
    [AIOS, ["slack", "xoxp-NOT-REAL-pasted-token"]],
    [SLACK_BIN, ["xoxp-NOT-REAL-pasted-token"]],
  ]) {
    const result = runSlack(bin, argv, { env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown slack verb: \(token-shaped value not shown\)/);
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes("xoxp-NOT-REAL-pasted"),
      "the pasted token leaked (banner or error line)"
    );
  }
  // A pasted token as an unexpected positional (whoami takes none). SLACK_USER_TOKEN is
  // present so parsing (not credentials) owns the failure.
  const asArg = runSlack(AIOS, ["slack", "whoami", "xoxp-NOT-REAL-misplaced-token"], {
    env: scrubbedEnv({ SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token" }),
  });
  assert.equal(asArg.status, 2, asArg.stderr);
  assert.match(asArg.stderr, /Unexpected argument: \(token-shaped value not shown\)/);
  assert.doesNotMatch(asArg.stderr, /xoxp-NOT-REAL-misplaced/);
  // An ordinary misplaced argument is still named — the mask is shape-scoped.
  const plain = runSlack(AIOS, ["slack", "whoami", "oops"], {
    env: scrubbedEnv({ SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token" }),
  });
  assert.match(plain.stderr, /Unexpected argument: oops/);
});

test("a token with an embedded NUL is refused value-free, with zero requests (no retry storm)", async () => {
  // Round-5 finding 2: undici's header TypeError embeds the value; the widened shape
  // guard must refuse the token before any fetch (and therefore before any retry).
  // In-process: a NUL cannot legally cross a spawn env boundary, but a keychain blob or a
  // brain response can carry one — options.env models that arrival.
  const { resolveSlackCredential } = await import("../scripts/connectors/slack/credentials.mjs");
  const nulToken = ["xoxp-NOT-REAL-head", "NOT-REAL-tail"].join(String.fromCharCode(0));
  let fetches = 0;
  await assert.rejects(
    resolveSlackCredential({
      env: { SLACK_USER_TOKEN: nulToken, AIOS_DISABLE_WORKSPACE_CREDENTIALS: "1" },
      fetch: async () => {
        fetches += 1;
        throw new Error("must not be reached");
      },
    }),
    (error) => {
      assert.equal(error.code, "AIOS_E_CREDENTIAL_INCOMPLETE");
      assert.match(error.message, /[Vv]alue intentionally not shown/);
      assert.ok(!error.message.includes("NOT-REAL-head"), "token bytes leaked into the error");
      assert.ok(!error.message.includes("NOT-REAL-tail"), "token bytes leaked into the error");
      return true;
    }
  );
  assert.equal(fetches, 0, "a NUL token must never leave the process (no retries either)");
});

test("an untrusted cwd's brain URL is never paired with the operator's key", () => {
  // Round-5 finding 3, the attack shape: the operator's brain key sits in their env, an
  // untrusted clone plants AIOS_BRAIN_URL in its own .env. Workspace credentials are NOT
  // disabled — this is the live path. The pairing must be refused, value-free, with zero
  // credential bytes leaving.
  const env = scrubbedEnv({ AIOS_API_KEY: "synthetic-operator-brain-key-not-real" });
  delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
  const hostile = mkdtempSync(path.join(tmpdir(), "aio-1068-hostile-ws-"));
  writeFileSync(path.join(hostile, ".env"), "AIOS_BRAIN_URL=https://attacker.invalid\n");
  try {
    for (const argv of [
      ["slack", "whoami"], // brain token root would carry the bearer key
      ["slack", "connect", "xoxp-NOT-REAL-connect-token"], // body would carry the xoxp token
    ]) {
      const result = runSlack(AIOS, argv, { env, cwd: hostile });
      assert.equal(result.status, 3, `${argv.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /refusing to pair|trust/i);
      const everything = `${result.stdout}${result.stderr}`;
      assert.ok(!everything.includes("attacker.invalid"), "the planted URL was echoed");
      assert.ok(!everything.includes("synthetic-operator-brain-key"), "the key was echoed");
      assert.deepEqual(result.requests, [], `${argv.join(" ")}: credential bytes left`);
    }
  } finally {
    rmSync(hostile, { recursive: true, force: true });
  }
});

test("a workspace supplying BOTH its own brain URL and key still works (same domain)", () => {
  const env = scrubbedEnv();
  delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
  const workspace = mkdtempSync(path.join(tmpdir(), "aio-1068-own-key-ws-"));
  writeFileSync(
    path.join(workspace, ".env"),
    "AIOS_BRAIN_URL=https://brain.example.test\nAIOS_API_KEY=synthetic-workspace-key-not-real\n"
  );
  try {
    const result = runSlack(AIOS, ["slack", "status"], { env, cwd: workspace });
    assert.equal(result.status, 0, result.stderr);
    const tokenCheck = result.requests.find((request) =>
      String(request.url).includes("/api/v1/me/slack-token")
    );
    assert.ok(tokenCheck, "the workspace-domain brain was consulted");
    assert.equal(tokenCheck.headers.Authorization, "Bearer synthetic-workspace-key-not-real");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a malformed env token fails with a fixed, value-free message on both routes", () => {
  // Assembled at runtime (the scanner-recommended decoy form): a control character inside
  // an otherwise plausible token, with no secret-shaped literal in the source.
  const badToken = ["xoxp-NOT-REAL", "NOT-REAL-tab-inside"].join("\t");
  for (const [bin, args] of [
    [AIOS, ["slack", "whoami"]],
    [SLACK_BIN, ["whoami"]],
  ]) {
    const result = runSlack(bin, args, { env: scrubbedEnv({ SLACK_USER_TOKEN: badToken }) });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /[Vv]alue intentionally not shown/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("tab-inside"));
    assert.deepEqual(result.requests, [], "a malformed token must never leave the process");
  }
});
