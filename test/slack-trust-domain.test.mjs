// AIO-1068 round 10 (final confirmation pass F1/F2 + Codex member-echo P1):
//   F1 — the credential being ATTACHED shares a trust domain with the destination: an
//        ambient env-sourced Slack token is never POSTed to a workspace-domain brain.
//   F2 — AIOS_AGENT_WORKSPACE is an accepted workspace root (operator-designated),
//        with the same both-fields-from-one-root provenance rules.
//   F3 — token-shaped --member values are masked in resolution errors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AIOS, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

const workspaceEnabled = (overrides = {}) => {
  const env = scrubbedEnv(overrides);
  delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
  return env;
};

test("F1: an ambient env token is never POSTed to a workspace-domain brain", () => {
  // The reproduced attack: a hostile cwd supplies BOTH brain fields (same-domain for the
  // BRAIN key, so no url/key conflict) and `aios slack connect` picks up the operator's
  // exported SLACK_USER_TOKEN. The token must not leave.
  const hostile = mkdtempSync(path.join(tmpdir(), "aio-1068-f1-hostile-"));
  writeFileSync(
    path.join(hostile, ".env"),
    "AIOS_BRAIN_URL=https://attacker.invalid\nAIOS_API_KEY=synthetic-attacker-key-not-real\n"
  );
  try {
    const env = workspaceEnabled({ SLACK_USER_TOKEN: "xoxp-NOT-REAL-operator-env-token" });
    const result = runSlack(AIOS, ["slack", "connect"], { env, cwd: hostile });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /Refusing to send the environment-sourced Slack token/);
    const everything = `${result.stdout}${result.stderr}`;
    assert.ok(!everything.includes("xoxp-NOT-REAL-operator-env"), "the token was echoed");
    assert.ok(!everything.includes("attacker.invalid"), "the destination was echoed");
    assert.deepEqual(result.requests, [], "zero token bytes may leave");
  } finally {
    rmSync(hostile, { recursive: true, force: true });
  }
});

test("F1 control: an explicitly passed token to the workspace's own brain is consent", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "aio-1068-f1-ws-"));
  writeFileSync(
    path.join(workspace, ".env"),
    "AIOS_BRAIN_URL=https://brain.example.test\nAIOS_API_KEY=synthetic-workspace-key-not-real\n"
  );
  try {
    const env = workspaceEnabled();
    const result = runSlack(AIOS, ["slack", "connect", "--stdin"], {
      env,
      cwd: workspace,
      input: "xoxp-NOT-REAL-consented-token\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const post = result.requests.find(
      (request) =>
        request.method === "POST" && String(request.url).includes("/api/v1/me/slack-token")
    );
    assert.ok(post, "the consented connect must reach the workspace brain");
    assert.match(String(post.url), /^https:\/\/brain\.example\.test\//);
    assert.ok(String(post.body).includes("xoxp-NOT-REAL-consented-token"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("F2: AIOS_AGENT_WORKSPACE is a workspace root with unchanged provenance rules", () => {
  // Run-from-anywhere layout: the workspace holds brain_url (aios.yaml) + key (.env);
  // the operator-exported AIOS_AGENT_WORKSPACE designates it; cwd is elsewhere.
  const workspace = mkdtempSync(path.join(tmpdir(), "aio-1068-f2-ws-"));
  writeFileSync(path.join(workspace, "aios.yaml"), "brain_url: https://brain.example.test\n");
  writeFileSync(path.join(workspace, ".env"), "AIOS_API_KEY=synthetic-agentws-key-not-real\n");
  const elsewhere = mkdtempSync(path.join(tmpdir(), "aio-1068-f2-elsewhere-"));
  try {
    const env = workspaceEnabled({
      AIOS_AGENT_WORKSPACE: workspace,
      MOCK_BRAIN_SLACK_TOKEN: "xoxp-NOT-REAL-brain-held-token",
    });
    const result = runSlack(AIOS, ["slack", "whoami"], { env, cwd: elsewhere });
    assert.equal(result.status, 0, result.stderr);
    const tokenFetch = result.requests.find((request) =>
      String(request.url).includes("/api/v1/me/slack-token")
    );
    assert.ok(tokenFetch, "the agent-workspace brain must be consulted from anywhere");
    assert.match(String(tokenFetch.url), /^https:\/\/brain\.example\.test\//);
    assert.equal(tokenFetch.headers.Authorization, "Bearer synthetic-agentws-key-not-real");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("F2 hostile twin: cwd brain_url + agent-workspace key is a conflict, never a pairing", () => {
  const hostile = mkdtempSync(path.join(tmpdir(), "aio-1068-f2-hostile-"));
  writeFileSync(path.join(hostile, ".env"), "AIOS_BRAIN_URL=https://attacker.invalid\n");
  const keyOnly = mkdtempSync(path.join(tmpdir(), "aio-1068-f2-keyonly-"));
  writeFileSync(path.join(keyOnly, ".env"), "AIOS_API_KEY=synthetic-agentws-key-not-real\n");
  try {
    const env = workspaceEnabled({ AIOS_AGENT_WORKSPACE: keyOnly });
    const result = runSlack(AIOS, ["slack", "whoami"], { env, cwd: hostile });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /refusing to pair/);
    assert.match(result.stderr, /workspace config/);
    assert.match(result.stderr, /agent-workspace config/);
    const everything = `${result.stdout}${result.stderr}`;
    assert.ok(!everything.includes("attacker.invalid"), "the planted URL was echoed");
    assert.ok(!everything.includes("synthetic-agentws-key"), "the key was echoed");
    assert.deepEqual(result.requests, [], "zero credential bytes may leave");
  } finally {
    rmSync(hostile, { recursive: true, force: true });
    rmSync(keyOnly, { recursive: true, force: true });
  }
});

test("disconnect reports failure when the brain-held token was NOT removed", () => {
  // Bugbot round 11: the DELETE status was never inspected — a 500 still printed
  // "disconnected" and exited 0 while the token stayed stored.
  const brain = {
    AIOS_BRAIN_URL: "https://brain.example.test",
    AIOS_API_KEY: "synthetic-brain-key-not-real",
  };
  const failed = runSlack(AIOS, ["slack", "disconnect"], {
    env: scrubbedEnv({ ...brain, MOCK_BRAIN_DELETE_STATUS: "500" }),
  });
  assert.notEqual(failed.status, 0, "a failed removal must not exit 0");
  assert.match(failed.stderr, /NOT removed/);
  assert.doesNotMatch(failed.stdout, /^disconnected/m, "no false removal claim");

  // 404 = the brain holds no token — the desired end state, reported explicitly.
  const absent = runSlack(AIOS, ["slack", "disconnect"], {
    env: scrubbedEnv({ ...brain, MOCK_BRAIN_DELETE_STATUS: "404" }),
  });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, "disconnected (no token was stored)\n");

  // Success path unchanged.
  const ok = runSlack(AIOS, ["slack", "disconnect"], { env: scrubbedEnv(brain) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "disconnected\n");
});

test("inherited-property names are unknown verbs/options, never AIOS_E_INTERNAL", () => {
  const env = scrubbedEnv(); // zero credentials — everything here must stay offline
  for (const verb of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const result = runSlack(AIOS, ["slack", verb], { env });
    assert.equal(result.status, 2, `${verb}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`unknown slack verb: ${verb}`));
    assert.doesNotMatch(result.stderr, /AIOS_E_INTERNAL/);
    assert.deepEqual(result.requests, [], `${verb}: a request escaped`);
  }
  for (const flag of ["--__proto__", "--constructor"]) {
    const result = runSlack(AIOS, ["slack", "whoami", flag, "x"], { env });
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr, /Unknown option/);
    assert.doesNotMatch(result.stderr, /AIOS_E_INTERNAL/);
    assert.deepEqual(result.requests, [], `${flag}: a request escaped`);
  }
});

test("F3: token-shaped --member values are masked in resolution errors", () => {
  // No brain configured, member is not an email → both resolution paths error; the
  // pasted-token member must appear zero times in the output.
  const env = scrubbedEnv({ SLACK_USER_TOKEN: "xoxp-NOT-REAL-env-token" });
  for (const argv of [
    ["slack", "resolve", "--member", "xoxp-NOT-REAL-member-token"],
    ["slack", "dm", "--member", "xoxp-NOT-REAL-member-token", "--message", "hi"],
  ]) {
    const result = runSlack(AIOS, argv, { env });
    assert.equal(result.status, 4, `${argv[1]}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /Could not resolve teammate '\(token-shaped value not shown\)'/,
      `${argv[1]}: mask missing`
    );
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes("xoxp-NOT-REAL-member"),
      `${argv[1]}: the member token leaked`
    );
  }
});
