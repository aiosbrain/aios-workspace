// AIO-1068 round 4 — credential-egress guards: no token value may ever reach stdout,
// stderr, an error message, or the JSON error surface. Synthetic, marker-compliant
// tokens only; every spawn also asserts zero provider/brain requests where applicable.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

test("token-shaped argv values are masked in usage errors, not echoed", () => {
  const env = scrubbedEnv();
  // A pasted token in the verb slot.
  const asVerb = runSlack(AIOS, ["slack", "xoxp-NOT-REAL-pasted-token"], { env });
  assert.equal(asVerb.status, 2);
  assert.match(asVerb.stderr, /unknown slack verb: \(token-shaped value not shown\)/);
  assert.doesNotMatch(asVerb.stderr, /xoxp-NOT-REAL-pasted/);
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
