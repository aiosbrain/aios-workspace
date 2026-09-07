// AIO-1068 — the negative destination suite: the Node port of slack.py's
// _assert_request_url / _SameOriginRedirectHandler semantics. Every case asserts on the
// mock's request-capture log that a refused destination received ZERO requests (and so
// zero credential bytes) — not merely that the CLI printed an error.
//
//   - file: brain destination            → refused before any request
//   - malformed port (fail-closed)       → refused before any request
//   - non-loopback http                  → refused before any request
//   - loopback http                      → refused for credentialed requests even under
//                                          AIOS_ALLOW_INSECURE_LOOPBACK=1 (destination
//                                          policy: the flag never unlocks credentialed
//                                          plaintext)
//   - cross-origin redirect (Location is data) → the foreign target gets nothing
//   - hostile upload URL from a Slack RESPONSE → refused before any byte is sent
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AIOS, SYNTHETIC_TOKEN, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

const BRAIN_KEY = "synthetic-brain-key-not-real";

function refusedBrainCase(brainUrl, extra = {}) {
  // No SLACK_USER_TOKEN: the adapter must consult the brain root, whose destination is
  // validated BEFORE the bearer key materializes.
  const env = scrubbedEnv({ AIOS_BRAIN_URL: brainUrl, AIOS_API_KEY: BRAIN_KEY, ...extra });
  return runSlack(AIOS, ["slack", "whoami"], { env });
}

test("a file: brain destination receives zero credential bytes", () => {
  const result = refusedBrainCase("file:///etc/passwd");
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
  assert.deepEqual(result.requests, []);
});

test("a malformed brain destination (bad port) fails closed with zero requests", () => {
  for (const url of ["https://brain.example.test:99999", "https://brain.example.test:0x50"]) {
    const result = refusedBrainCase(url);
    assert.equal(result.status, 3, `${url}: ${result.stderr}`);
    assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
    assert.deepEqual(result.requests, [], `${url}: a request escaped`);
  }
});

test("a non-loopback http brain destination receives zero credential bytes", () => {
  const result = refusedBrainCase("http://brain.internal.example");
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
  assert.deepEqual(result.requests, []);
});

test("credentialed loopback http is refused even under the explicit loopback flag", () => {
  const result = refusedBrainCase("http://127.0.0.1:4870", {
    AIOS_ALLOW_INSECURE_LOOPBACK: "1",
  });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
  assert.deepEqual(result.requests, []);
});

test("a cross-origin brain redirect is refused; the foreign target gets nothing", () => {
  const foreign = "https://exfil.example.evil/collect";
  const result = refusedBrainCase("https://brain.example.test", {
    MOCK_BRAIN_REDIRECT: foreign,
  });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
  // Exactly the configured origin was contacted; the redirect target never was.
  assert.ok(result.requests.length >= 1, "the trusted origin request itself must exist");
  for (const request of result.requests) {
    assert.ok(
      String(request.url).startsWith("https://brain.example.test/"),
      `credential-bearing request escaped to ${request.url}`
    );
  }
  assert.doesNotMatch(result.stderr, /exfil\.example\.evil/, "Location is data — never echoed");
});

test("connect (token in the body) refuses a cross-origin redirect the same way", () => {
  const env = scrubbedEnv({
    AIOS_BRAIN_URL: "https://brain.example.test",
    AIOS_API_KEY: BRAIN_KEY,
    MOCK_BRAIN_REDIRECT: "https://exfil.example.evil/steal-token",
  });
  const result = runSlack(AIOS, ["slack", "connect", SYNTHETIC_TOKEN], { env });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
  for (const request of result.requests) {
    assert.ok(
      String(request.url).startsWith("https://brain.example.test/"),
      `the Slack token body escaped to ${request.url}`
    );
  }
});

test("a hostile upload URL in a Slack response receives zero bytes", () => {
  for (const base of ["file:///tmp", "http://attacker.example"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "aio-1068-hostile-upload-"));
    try {
      writeFileSync(path.join(dir, "note.txt"), "bytes that must not leave\n");
      const env = scrubbedEnv({ SLACK_USER_TOKEN: SYNTHETIC_TOKEN, MOCK_UPLOAD_BASE: base });
      const result = runSlack(
        AIOS,
        ["slack", "file", "--target", "C0GENERAL", "--path", "note.txt"],
        { env, cwd: dir }
      );
      assert.equal(result.status, 3, `${base}: ${result.stderr}`);
      assert.match(result.stderr, /AIOS_E_DESTINATION_UNTRUSTED/);
      for (const request of result.requests) {
        assert.ok(
          String(request.url).startsWith("https://slack.com/api/"),
          `${base}: file bytes escaped to ${request.url}`
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
