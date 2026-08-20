/**
 * slack-personal-upload.test.mjs — the `slack file` external-upload FLOW, against a local mock.
 * Path-security cases live in slack-personal-upload-paths.test.mjs; the shared harness is in
 * slack-personal-upload-fixtures.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CHANNEL, runFile, tmpFile, withMock } from "./slack-personal-upload-fixtures.mjs";

test("the three-stage upload sends the right filename/length, exact bytes, and completion", async () => {
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x68, 0x69]);
  const f = tmpFile("report.bin", bytes);
  await withMock({}, async ({ base, seen }) => {
    const r = await runFile({
      base,
      args: ["--target", CHANNEL, "--path", f, "--message", "here you go", "--json"],
    });
    assert.equal(r.status, 0, r.stderr);

    const get = seen.api.find((c) => c.method === "files.getUploadURLExternal");
    assert.ok(get, "stage 1 must call files.getUploadURLExternal");
    assert.equal(get.body.filename, "report.bin", "filename is sent as DATA, not a header");
    assert.equal(get.body.length, String(bytes.length), "length must be the real byte length");

    assert.ok(seen.uploadBody.equals(bytes), "stage 2 must send the exact bytes, unwrapped");
    assert.equal(
      seen.uploadHeaders["content-type"],
      "application/octet-stream",
      "raw bytes, not multipart — no filename ever reaches a header"
    );

    const done = seen.api.find((c) => c.method === "files.completeUploadExternal");
    assert.ok(done, "stage 3 must call files.completeUploadExternal");
    assert.equal(done.body.channel_id, CHANNEL);
    assert.equal(done.body.initial_comment, "here you go");
    assert.match(done.body.files, /F0MOCK/);
    assert.match(r.stdout, /F0MOCK/, "--json must report the file id");
  });
});

test("a filename containing quotes and CRLF cannot inject anything (the multipart bug)", async () => {
  // Under the old multipart body this filename broke out of Content-Disposition. As raw bytes it
  // is just a JSON string, so the only correct behaviour is: send it verbatim, change nothing.
  const nasty = ['evil"; name="x', "X-Injected: 1.txt"].join("\r\n");
  const f = tmpFile(nasty, "payload");
  await withMock({}, async ({ base, seen }) => {
    const r = await runFile({ base, args: ["--target", CHANNEL, "--path", f, "--json"] });
    assert.equal(r.status, 0, r.stderr);
    const get = seen.api.find((c) => c.method === "files.getUploadURLExternal");
    assert.equal(get.body.filename, nasty, "the filename survives verbatim as a parameter");
    assert.equal(seen.uploadBody.toString(), "payload", "and the body is still exactly the file");
    assert.equal(seen.uploadHeaders["x-injected"], undefined, "nothing was injected as a header");
  });
});

test("--message is omitted entirely when not supplied", async () => {
  const f = tmpFile("a.txt", "x");
  await withMock({}, async ({ base, seen }) => {
    const r = await runFile({ base, args: ["--target", CHANNEL, "--path", f, "--json"] });
    assert.equal(r.status, 0, r.stderr);
    const done = seen.api.find((c) => c.method === "files.completeUploadExternal");
    assert.ok(!("initial_comment" in done.body), "an absent comment must not post an empty one");
  });
});

test("--member is resolved to a channel before uploading", async () => {
  const f = tmpFile("a.txt", "x");
  await withMock({}, async ({ base, seen }) => {
    const r = await runFile({
      base,
      args: ["--member", "someone@example.com", "--path", f, "--json"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      seen.api.some((c) => c.method === "conversations.open" || c.method === "users.lookupByEmail"),
      "a member must be resolved, not passed through as a channel id"
    );
  });
});

test("a transient 429/503 is retried and then succeeds, resending the full body", async () => {
  const f = tmpFile("a.txt", "retry me");
  await withMock({ uploadFailures: [429, 503] }, async ({ base, seen }) => {
    const r = await runFile({ base, args: ["--target", CHANNEL, "--path", f, "--json"] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(seen.attempts, 3, "two failures then a success");
    assert.equal(seen.uploadBody.toString(), "retry me", "the retry must resend the full body");
  });
});

test("a terminal upload failure exits 5 and never echoes the credential-bearing upload URL", async () => {
  const f = tmpFile("a.txt", "x");
  await withMock({ uploadFailures: [500, 500, 500, 500] }, async ({ base }) => {
    const r = await runFile({ base, args: ["--target", CHANNEL, "--path", f] });
    assert.equal(r.status, 5, `expected exit 5, got ${r.status}: ${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(
      out,
      /\/upload/,
      "the single-use upload URL is a credential — never log it"
    );
    assert.doesNotMatch(out, /xoxp-/, "the token must never appear in diagnostics");
  });
});

test("missing, empty, oversized and non-regular files are refused before any API call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slack-neg-"));
  const emptyFile = path.join(dir, "empty.txt");
  writeFileSync(emptyFile, "");
  const aDirectory = path.join(dir, "subdir");
  mkdirSync(aDirectory);
  const huge = path.join(dir, "huge.bin");
  writeFileSync(huge, Buffer.alloc(26 * 1024 * 1024));

  const cases = [
    // A missing path now says so explicitly rather than being lumped in with FIFOs and
    // directories — the caller almost always mistyped, and "not a regular file" sends them
    // looking for the wrong problem.
    [path.join(dir, "nope.txt"), /no such file/],
    [emptyFile, /empty file/],
    [aDirectory, /not a regular file/],
    [huge, /upload cap/],
  ];
  for (const [target, expected] of cases) {
    await withMock({}, async ({ base, seen }) => {
      const r = await runFile({ base, args: ["--target", CHANNEL, "--path", target] });
      assert.equal(r.status, 2, `${target} should be a usage error: ${r.stderr}`);
      assert.match(r.stderr, expected);
      assert.equal(seen.api.length, 0, "a refusal must not have called Slack at all");
    });
  }
});
