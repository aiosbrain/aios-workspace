// AIO-1068 round 4 — credential-egress guards: no token value may ever reach stdout,
// stderr, an error message, or the JSON error surface. Synthetic, marker-compliant
// tokens only; every spawn also asserts zero provider/brain requests where applicable.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AIOS, ROOT, SLACK_BIN, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

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

test("D1: domain attribution is by construction — divergent toolkit roots cannot fail open", async () => {
  const { resolveBrainConfig } = await import("../scripts/connectors/slack/credentials.mjs");
  const home = mkdtempSync(path.join(tmpdir(), "aio-1068-home-"));
  const hostile = mkdtempSync(path.join(tmpdir(), "aio-1068-d1-ws-"));
  writeFileSync(path.join(hostile, "aios.yaml"), "brain_url: https://attacker.invalid\n");
  const emptyVault = mkdtempSync(path.join(tmpdir(), "aio-1068-d1-vault-"));
  try {
    // (a) Operator key + hostile-cwd url → conflict as DATA, url/key nulled (never paired).
    const conflicted = await resolveBrainConfig({
      cwd: hostile,
      home,
      env: { AIOS_TOOLKIT_DIR: emptyVault, AIOS_API_KEY: "synthetic-op-key-not-real" },
    });
    assert.equal(conflicted.url, null);
    assert.equal(conflicted.key, null);
    assert.deepEqual(conflicted.conflict, { urlDomain: "workspace", keyDomain: "operator" });

    // (b) The old fail-open shape: key NOT in the cwd and NOT in the operator domain —
    //     provenance is per-field from the cwd's own files, so a lookup miss can never be
    //     read as "workspace-owned". No pairing exists at all.
    const unpaired = await resolveBrainConfig({
      cwd: hostile,
      home,
      env: { AIOS_TOOLKIT_DIR: emptyVault },
    });
    assert.deepEqual(
      { url: unpaired.url, key: unpaired.key, conflict: unpaired.conflict },
      { url: null, key: null, conflict: null }
    );

    // (c) A toolkit vault path CONTAINING A SPACE resolves (the URL.pathname class bug).
    const spacedVault = mkdtempSync(path.join(tmpdir(), "aio-1068 vault with space-"));
    writeFileSync(
      path.join(spacedVault, ".env"),
      "AIOS_BRAIN_URL=https://brain.example.test\nAIOS_API_KEY=synthetic-vault-key-not-real\n"
    );
    const operator = await resolveBrainConfig({
      cwd: hostile,
      home,
      env: { AIOS_TOOLKIT_DIR: spacedVault },
    });
    assert.equal(operator.source, "operator");
    assert.equal(operator.url, "https://brain.example.test");
    rmSync(spacedVault, { recursive: true, force: true });

    // (d) Static pin: the path derivation uses fileURLToPath, never URL(...).pathname.
    const source = readFileSync(
      path.join(ROOT, "scripts", "connectors", "slack", "credentials.mjs"),
      "utf8"
    );
    assert.match(source, /fileURLToPath\(import\.meta\.url\)/);
    assert.doesNotMatch(source, /new URL\(import\.meta\.url\)\.pathname/);
  } finally {
    for (const dir of [home, hostile, emptyVault]) rmSync(dir, { recursive: true, force: true });
  }
});

test("D2: the documented url-in-yaml/key-in-env layout only refuses at brain attachment", () => {
  // A stamped workspace carries brain_url in aios.yaml; the operator exports AIOS_API_KEY
  // and SLACK_USER_TOKEN. Pure-Slack verbs must WORK; status REPORTS the conflict; the
  // brain-touching verbs refuse value-free with zero requests.
  const env = scrubbedEnv({
    AIOS_API_KEY: "synthetic-operator-brain-key-not-real",
    SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token",
  });
  delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
  const workspace = mkdtempSync(path.join(tmpdir(), "aio-1068-d2-ws-"));
  writeFileSync(path.join(workspace, "aios.yaml"), "brain_url: https://brain.example.test\n");
  try {
    const whoami = runSlack(AIOS, ["slack", "whoami"], { env, cwd: workspace });
    assert.equal(whoami.status, 0, whoami.stderr);
    assert.match(whoami.stdout, /mockuser \(U0MOCK\)/);
    const send = runSlack(AIOS, ["slack", "send", "--target", "C0GENERAL", "--message", "hi"], {
      env,
      cwd: workspace,
    });
    assert.equal(send.status, 0, send.stderr);

    const status = runSlack(AIOS, ["slack", "status", "--json"], { env, cwd: workspace });
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.brain, "conflict");
    assert.deepEqual(report.conflict, { urlDomain: "workspace", keyDomain: "operator" });
    assert.deepEqual(status.requests, [], "status must not contact the conflicted brain");

    const connect = runSlack(AIOS, ["slack", "connect", "xoxp-NOT-REAL-connect-token"], {
      env,
      cwd: workspace,
    });
    assert.equal(connect.status, 3, connect.stderr);
    assert.match(connect.stderr, /refusing to pair/);
    assert.ok(!`${connect.stdout}${connect.stderr}`.includes("brain.example.test"));
    assert.deepEqual(connect.requests, [], "connect must not send under a conflict");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an all-encrypted operator vault resolves BOTH url and key (no phantom conflict)", () => {
  // Bugbot round 7: loadDotEnv skips dotenvx ciphertext, so decrypting only the key left
  // an encrypted vault as key-without-url and could trip the cross-domain refusal.
  const vault = mkdtempSync(path.join(tmpdir(), "aio-1068-enc-vault-"));
  const dotenvx = path.join(ROOT, "node_modules", ".bin", "dotenvx");
  const setEnv = { ...process.env };
  delete setEnv.DOTENV_PUBLIC_KEY;
  delete setEnv.DOTENV_PRIVATE_KEY;
  writeFileSync(path.join(vault, ".env"), "");
  for (const [key, value] of [
    ["AIOS_BRAIN_URL", "https://brain.example.test"],
    ["AIOS_API_KEY", "synthetic-encrypted-vault-key-not-real"],
  ]) {
    execFileSync(dotenvx, ["set", key, value, "-f", ".env"], { cwd: vault, env: setEnv });
  }
  const hostile = mkdtempSync(path.join(tmpdir(), "aio-1068-enc-hostile-"));
  writeFileSync(path.join(hostile, ".env"), "AIOS_BRAIN_URL=https://attacker.invalid\n");
  try {
    const env = scrubbedEnv({
      AIOS_TOOLKIT_DIR: vault,
      MOCK_BRAIN_SLACK_TOKEN: "xoxp-NOT-REAL-brain-held-token",
    });
    delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
    const result = runSlack(AIOS, ["slack", "whoami"], { env, cwd: hostile });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /refusing to pair/, "phantom cross-domain conflict");
    const tokenFetch = result.requests.find((request) =>
      String(request.url).includes("/api/v1/me/slack-token")
    );
    assert.ok(tokenFetch, "the operator brain was consulted");
    assert.match(String(tokenFetch.url), /^https:\/\/brain\.example\.test\//);
    assert.equal(
      tokenFetch.headers.Authorization,
      "Bearer synthetic-encrypted-vault-key-not-real",
      "the decrypted vault key must be the bearer"
    );
    for (const request of result.requests) {
      assert.ok(!String(request.url).includes("attacker.invalid"), "operator domain must win");
    }
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(hostile, { recursive: true, force: true });
  }
});

test("--member resolution under a conflict refuses loudly, never the silent email fallback", () => {
  // Round 9: brainResolveSlack's unconfigured shortcut (`return null`) ran before the
  // conflict check, so `resolve/dm/file --member` silently degraded to "no brain
  // match"/email fallback while a hostile pairing sat in the cwd. The refusal must win.
  const conflictEnv = () => {
    const env = scrubbedEnv({
      AIOS_API_KEY: "synthetic-operator-brain-key-not-real",
      SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token",
    });
    delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
    return env;
  };
  const workspace = mkdtempSync(path.join(tmpdir(), "aio-1068-r9-ws-"));
  writeFileSync(path.join(workspace, "aios.yaml"), "brain_url: https://brain.example.test\n");
  try {
    for (const argv of [
      ["slack", "resolve", "--member", "teammate@example.test"],
      ["slack", "dm", "--member", "teammate@example.test", "--message", "hi"],
      ["slack", "file", "--member", "teammate@example.test", "--path", "note.txt"],
    ]) {
      if (argv[1] === "file") writeFileSync(path.join(workspace, "note.txt"), "payload\n");
      const result = runSlack(AIOS, argv, { env: conflictEnv(), cwd: workspace });
      assert.equal(result.status, 3, `${argv[1]} --member: ${result.stderr}`);
      assert.match(result.stderr, /AIOS_E_CONFIG_INVALID/);
      assert.match(result.stderr, /refusing to pair/);
      assert.ok(
        !`${result.stdout}${result.stderr}`.includes("brain.example.test"),
        `${argv[1]}: the conflicted URL was echoed`
      );
      assert.deepEqual(
        result.requests,
        [],
        `${argv[1]} --member: a request escaped (email fallback or brain call)`
      );
    }

    // Control: genuinely UNCONFIGURED (no conflict, no brain) keeps degrading exactly as
    // before — dm --member falls back to Slack's own email lookup and sends.
    const unconfigured = runSlack(
      AIOS,
      ["slack", "dm", "--member", "teammate@example.test", "--message", "hi"],
      { env: scrubbedEnv({ SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token" }), cwd: workspace }
    );
    assert.equal(unconfigured.status, 0, unconfigured.stderr);
    assert.ok(
      unconfigured.requests.some((request) => String(request.url).endsWith("users.lookupByEmail")),
      "the unconfigured case must still use the email fallback"
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an all-encrypted WORKSPACE vault resolves BOTH url and key (symmetric twin)", () => {
  // Codex round 8: the symmetric twin of the operator-vault fix — a workspace whose .env
  // holds BOTH fields as dotenvx ciphertext must resolve complete (workspace domain, its
  // own decrypted url+key pair), not misreport as key-without-url / missing / conflict.
  const workspace = mkdtempSync(path.join(tmpdir(), "aio-1068-enc-ws-"));
  const dotenvx = path.join(ROOT, "node_modules", ".bin", "dotenvx");
  const setEnv = { ...process.env };
  delete setEnv.DOTENV_PUBLIC_KEY;
  delete setEnv.DOTENV_PRIVATE_KEY;
  writeFileSync(path.join(workspace, ".env"), "");
  for (const [key, value] of [
    ["AIOS_BRAIN_URL", "https://brain.example.test"],
    ["AIOS_API_KEY", "synthetic-encrypted-workspace-key-not-real"],
  ]) {
    execFileSync(dotenvx, ["set", key, value, "-f", ".env"], { cwd: workspace, env: setEnv });
  }
  try {
    const env = scrubbedEnv({ MOCK_BRAIN_SLACK_TOKEN: "xoxp-NOT-REAL-brain-held-token" });
    delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
    const result = runSlack(AIOS, ["slack", "whoami"], { env, cwd: workspace });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /refusing to pair/, "phantom cross-domain conflict");
    assert.doesNotMatch(result.stderr, /AIOS_E_CREDENTIAL_MISSING/, "vault misread as missing");
    const tokenFetch = result.requests.find((request) =>
      String(request.url).includes("/api/v1/me/slack-token")
    );
    assert.ok(tokenFetch, "the workspace-domain brain was consulted");
    assert.match(String(tokenFetch.url), /^https:\/\/brain\.example\.test\//);
    assert.equal(
      tokenFetch.headers.Authorization,
      "Bearer synthetic-encrypted-workspace-key-not-real",
      "the decrypted workspace key must be the bearer"
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the compat bin's SECRET_SHAPED mask is pinned byte-identical to args.mjs", () => {
  const extract = (file) => {
    const match = /const SECRET_SHAPED = (\/.+\/i);/.exec(
      readFileSync(path.join(ROOT, file), "utf8")
    );
    assert.ok(match, `${file}: SECRET_SHAPED literal not found`);
    return match[1];
  };
  assert.equal(
    extract("scripts/slack.mjs"),
    extract("scripts/connectors/slack/args.mjs"),
    "the delegate's duplicated mask drifted from the adapter's"
  );
});

test("a token pasted into the target slot is masked in the unrecognized-target error", () => {
  const result = runSlack(
    AIOS,
    ["slack", "send", "--target", "xoxp-NOT-REAL-target-token", "--message", "hi"],
    { env: scrubbedEnv({ SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token" }) }
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unrecognized target: \(token-shaped value not shown\)/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("xoxp-NOT-REAL-target"));
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
