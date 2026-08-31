// AIO-1068 — mocked behavioral contracts for the built-in Slack adapter: stdin byte
// fidelity, target resolution, pagination, error/exit mapping, the brain token root, and
// the upload → complete → delete file flow. Everything runs against the in-process mock
// provider; no network, synthetic credentials only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AIOS, SYNTHETIC_TOKEN, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

const tokenEnv = (overrides = {}) =>
  scrubbedEnv({ SLACK_USER_TOKEN: SYNTHETIC_TOKEN, ...overrides });

const brainEnv = (overrides = {}) =>
  scrubbedEnv({
    AIOS_BRAIN_URL: "https://brain.example.test",
    AIOS_API_KEY: "synthetic-brain-key-not-real",
    ...overrides,
  });

test("send --message-stdin preserves multiline stdin bytes exactly", () => {
  const message = "line one\nline two with 'quotes' & $vars\n\ttabbed — ünïcodé\n";
  const result = runSlack(AIOS, ["slack", "send", "--target", "C0GENERAL", "--message-stdin"], {
    env: tokenEnv(),
    input: message,
  });
  assert.equal(result.status, 0, result.stderr);
  const post = result.requests.find((request) => String(request.url).endsWith("chat.postMessage"));
  assert.ok(post, "chat.postMessage was called");
  assert.equal(new URLSearchParams(post.body).get("text"), message, "byte fidelity lost");
  assert.match(result.stdout, /^sent → C0GENERAL @ /);
});

test("empty stdin is a usage error before any Slack call", () => {
  const result = runSlack(AIOS, ["slack", "send", "--target", "C0GENERAL", "--message-stdin"], {
    env: tokenEnv(),
    input: "",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /AIOS_E_USAGE/);
  assert.deepEqual(result.requests, [], "no request may precede argument validation");
});

test("target resolution: @email opens a DM; #name paginates conversations.list", () => {
  const dm = runSlack(
    AIOS,
    ["slack", "send", "--target", "@teammate@example.test", "--message", "hi"],
    { env: tokenEnv() }
  );
  assert.equal(dm.status, 0, dm.stderr);
  assert.match(dm.stdout, /^sent → D0U0TEAMMATE @ /);

  // second-page is only on page two of the mock's conversations.list.
  const paged = runSlack(AIOS, ["slack", "send", "--target", "#second-page", "--message", "hi"], {
    env: tokenEnv(),
  });
  assert.equal(paged.status, 0, paged.stderr);
  assert.match(paged.stdout, /^sent → C0SECOND @ /);
});

test("read renders newest-last with newlines flattened; --json emits raw messages", () => {
  const human = runSlack(AIOS, ["slack", "read", "--target", "C0GENERAL"], { env: tokenEnv() });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, "[1.000] U0TEAMMATE: older\n[2.000] U0MOCK: newer line\n");
  const json = runSlack(AIOS, ["slack", "read", "--target", "C0GENERAL", "--json"], {
    env: tokenEnv(),
  });
  assert.equal(JSON.parse(json.stdout).length, 2);
});

test("Slack error mapping: provider errors exit 4, auth errors exit 3", () => {
  const provider = runSlack(AIOS, ["slack", "resolve", "missing@example.test"], {
    env: tokenEnv(),
  });
  assert.equal(provider.status, 4, provider.stderr);
  assert.match(provider.stderr, /AIOS_E_PROVIDER/);
  assert.match(provider.stderr, /users_not_found/);

  const malformed = runSlack(AIOS, ["slack", "whoami"], {
    env: tokenEnv({ SLACK_USER_TOKEN: "not-a-slack-token" }),
  });
  assert.equal(malformed.status, 3, malformed.stderr);
  assert.match(malformed.stderr, /AIOS_E_CREDENTIAL_INCOMPLETE/);
  assert.doesNotMatch(malformed.stderr, /not-a-slack-token/, "token value must never be shown");
  assert.deepEqual(malformed.requests, [], "a malformed token must never leave the process");
});

test("the brain token root feeds provider verbs; connect/status/disconnect round-trip", () => {
  const stored = brainEnv({ MOCK_BRAIN_SLACK_TOKEN: SYNTHETIC_TOKEN });
  const whoami = runSlack(AIOS, ["slack", "whoami"], { env: stored });
  assert.equal(whoami.status, 0, whoami.stderr);
  assert.match(whoami.stdout, /mockuser \(U0MOCK\) on team MockCo/);
  const tokenFetch = whoami.requests.find((request) =>
    String(request.url).includes("/api/v1/me/slack-token")
  );
  assert.ok(tokenFetch, "the token came from the brain root");
  assert.equal(tokenFetch.headers.Authorization, "Bearer synthetic-brain-key-not-real");

  const connect = runSlack(AIOS, ["slack", "connect", "--stdin"], {
    env: brainEnv(),
    input: `${SYNTHETIC_TOKEN}\n`,
  });
  assert.equal(connect.status, 0, connect.stderr);
  assert.equal(connect.stdout, "connected as U0MOCK in workspace MockCo\n");

  const rejected = runSlack(AIOS, ["slack", "connect", "xoxb-bot-token-not-a-user-token"], {
    env: brainEnv(),
  });
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.deepEqual(rejected.requests, [], "a bot token is refused before any request");

  const disconnect = runSlack(AIOS, ["slack", "disconnect"], { env: brainEnv() });
  assert.equal(disconnect.status, 0, disconnect.stderr);
  assert.equal(disconnect.stdout, "disconnected\n");
});

test("file upload flow: contained read → upload URL → complete; file-delete cleans up", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio-1068-file-"));
  try {
    writeFileSync(path.join(dir, "report.txt"), "upload payload bytes\n");
    const upload = runSlack(
      AIOS,
      ["slack", "file", "--target", "C0GENERAL", "--path", "report.txt", "--json"],
      { env: tokenEnv(), cwd: dir }
    );
    assert.equal(upload.status, 0, upload.stderr);
    const out = JSON.parse(upload.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.channel, "C0GENERAL");
    const fileId = out.files[0].id;
    assert.match(fileId, /^F0MOCK/);
    const uploadPut = upload.requests.find((request) =>
      String(request.url).includes("/mock-upload/")
    );
    assert.ok(uploadPut, "raw bytes hit the granted upload URL");
    assert.equal(uploadPut.headers?.Authorization, undefined, "no bearer on the upload URL");

    const del = runSlack(AIOS, ["slack", "file-delete", fileId], { env: tokenEnv(), cwd: dir });
    assert.equal(del.status, 0, del.stderr);
    assert.equal(del.stdout, `deleted ${fileId}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload retries honor Retry-After through the injected sleep seam (no real sleep)", async () => {
  const { cmdFile } = await import("../scripts/connectors/slack/files.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "aio-1068-retry-"));
  const delays = [];
  let uploadAttempts = 0;
  const fetchMock = async (url) => {
    const target = new URL(String(url));
    if (target.pathname === "/api/files.getUploadURLExternal") {
      return Response.json({
        ok: true,
        upload_url: "https://files.slack.example/up/1",
        file_id: "F1",
      });
    }
    if (target.pathname === "/up/1") {
      uploadAttempts += 1;
      if (uploadAttempts === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "7" } });
      }
      return new Response("OK", { status: 200 });
    }
    if (target.pathname === "/api/files.completeUploadExternal") {
      return Response.json({ ok: true, files: [{ id: "F1" }] });
    }
    throw new Error(`unrouted ${target.pathname}`);
  };
  const ctx = {
    token: SYNTHETIC_TOKEN,
    fetch: fetchMock,
    sleep: async (ms) => {
      delays.push(ms);
    },
    cwd: dir,
    env: {},
    brain: null,
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true; // keep the verb's human output out of the TAP stream
  try {
    writeFileSync(path.join(dir, "note.txt"), "retry payload\n");
    const status = await cmdFile(ctx, ["--target", "C0GENERAL", "--path", "note.txt"]);
    assert.equal(status, 0);
  } finally {
    process.stdout.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(uploadAttempts, 2, "the 429 must be retried and succeed");
  assert.deepEqual(delays, [7000], "the observed delay must honor Retry-After (7s → 7000ms)");
});

test("verb-level --help never resolves credentials or touches the network", () => {
  const env = scrubbedEnv(); // zero credentials, zero brain config
  for (const argv of [
    ["slack", "send", "--help"],
    ["slack", "file", "-h"],
    ["slack", "connect", "--help"],
  ]) {
    const result = runSlack(AIOS, argv, { env });
    assert.equal(result.status, 0, `${argv.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /aios slack send --target/);
    assert.doesNotMatch(result.stderr, /AIOS_E_CREDENTIAL_MISSING/);
    assert.deepEqual(result.requests, [], "help must observe zero brain/provider requests");
  }
});

test("dm --member falls back from brain to Slack email lookup and fails closed otherwise", () => {
  // No brain configured: email member falls back to users.lookupByEmail.
  const email = runSlack(
    AIOS,
    ["slack", "dm", "--member", "teammate@example.test", "--message", "hi"],
    { env: tokenEnv() }
  );
  assert.equal(email.status, 0, email.stderr);

  // No brain and not an email: fail closed as a provider resolution error.
  const handle = runSlack(AIOS, ["slack", "dm", "--member", "ghost", "--message", "hi"], {
    env: tokenEnv(),
  });
  assert.equal(handle.status, 4, handle.stderr);
  assert.match(handle.stderr, /Could not resolve teammate 'ghost'/);
});
