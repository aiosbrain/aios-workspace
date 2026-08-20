/**
 * slack-personal-upload.test.mjs — the `slack file` external-upload flow, against a LOCAL MOCK.
 *
 * No network, no credentials, no Slack workspace. A live self-DM smoke proves the happy path
 * exactly once and proves nothing about the cases that actually bite: a filename with a quote in
 * it, a zero-byte file, a 429 with a Retry-After, a terminal 500. Those are asserted here.
 *
 * The CLI is pointed at the mock by rewriting its `API` constant into a throwaway copy — the
 * shipped file carries no API-base override, deliberately. See `cliPointedAt()` for why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembled at runtime, never written as a literal. `check-secrets.sh` matches the Slack token
// SHAPE, and it is right to: a scanner that has to distinguish real tokens from convincing fake
// ones is a scanner you cannot trust. So the fixture simply never has the shape on disk.
const MOCK_TOKEN = ["xoxp", "mock", "token"].join("-");

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(
  DIR,
  "..",
  "scaffold",
  ".claude",
  "descriptors",
  "skills",
  "slack-personal",
  "slack.py"
);
const CHANNEL = "C0MOCK0001";

/** Start a Slack-shaped mock. `plan` lets a test script per-endpoint behaviour. */
async function withMock(plan, fn) {
  const seen = { api: [], uploadBody: null, uploadHeaders: null, attempts: 0 };
  let port;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      // Explicit Content-Length + Connection: close. Chunked keep-alive responses leave urllib
      // waiting on a body that never ends, which hangs the CLI rather than failing it.
      const send = (code, obj) => {
        const payload = Buffer.from(JSON.stringify(obj));
        res.writeHead(code, {
          "content-type": "application/json",
          "content-length": String(payload.length),
          connection: "close",
        });
        res.end(payload);
      };

      if (url.pathname === "/upload") {
        seen.attempts += 1;
        const fail =
          plan.uploadFailures && seen.attempts <= plan.uploadFailures.length
            ? plan.uploadFailures[seen.attempts - 1]
            : null;
        if (fail) {
          const h = { "content-length": "4", connection: "close" };
          if (fail === 429) h["retry-after"] = "0";
          res.writeHead(fail, h);
          return res.end("nope");
        }
        seen.uploadBody = body;
        seen.uploadHeaders = req.headers;
        res.writeHead(200, { "content-length": "2", connection: "close" });
        return res.end("OK");
      }

      const method = url.pathname.replace("/api/", "");
      seen.api.push({
        method,
        body: Object.fromEntries(new URLSearchParams(body.toString())),
      });
      if (method === "files.getUploadURLExternal") {
        return send(200, {
          ok: true,
          upload_url: plan.uploadUrl ?? `http://127.0.0.1:${port}/upload`,
          file_id: "F0MOCK",
        });
      }
      if (method === "files.completeUploadExternal") {
        return send(200, { ok: true, files: [{ id: "F0MOCK", title: "t" }] });
      }
      if (method === "users.lookupByEmail") {
        return send(200, { ok: true, user: { id: "U0MOCK", name: "mock" } });
      }
      if (method === "conversations.open") {
        return send(200, { ok: true, channel: { id: "D0MOCK" } });
      }
      return send(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  try {
    return await fn({ base: `http://127.0.0.1:${port}/api/`, seen });
  } finally {
    server.close();
  }
}

/**
 * Point the CLI at the mock by REWRITING ITS `API` CONSTANT INTO A THROWAWAY COPY — not by an
 * env-var override in the shipped code.
 *
 * An earlier version of this suite added a `SLACK_API_BASE_URL` override, restricted to
 * loopback, and argued that loopback made it safe. It did not. Every call attaches a bearer
 * user token, so a local process that cannot READ the token could start a listener, set the
 * variable, invoke the CLI and capture the Authorization header — then forward it anywhere.
 * Loopback bounds the destination, not the credential boundary. The override was a
 * token-disclosure primitive shipped for the convenience of this file.
 *
 * A patched copy costs one string replacement and adds no production surface at all.
 *
 * MUST be async: the mock HTTP server lives in THIS process, so a synchronous spawn would block
 * the event loop and the server could never answer — the CLI would wait forever on a request
 * nobody is able to serve. That deadlock looks exactly like a hung CLI.
 */
function cliPointedAt(base) {
  const src = readFileSync(CLI, "utf8");
  const needle = 'API = "https://slack.com/api/"';
  if (!src.includes(needle)) {
    throw new Error(`slack.py no longer declares ${needle} — update this test's patch point`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "slack-cli-copy-"));
  const copy = path.join(dir, "slack.py");
  writeFileSync(copy, src.replace(needle, `API = ${JSON.stringify(base)}`));
  return copy;
}

// Every fixture here lives in a temp dir, which is OUTSIDE the cwd — so these runs pass the
// escape hatch explicitly. That is the flag doing its job, not a workaround: containment is
// tested on its own below, with and without it.
function runFile({ base, args, contained = false }) {
  const flags = contained ? [] : ["--allow-outside-workspace"];
  return runFileRaw({ base, args: [...args, ...flags] });
}

function runFileRaw({ base, args, cwd }) {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [cliPointedAt(base), "file", ...args],
      {
        encoding: "utf8",
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SLACK_USER_TOKEN: MOCK_TOKEN },
      },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
  });
}

function tmpFile(name, contents) {
  const d = mkdtempSync(path.join(tmpdir(), "slack-upload-"));
  const f = path.join(d, name);
  writeFileSync(f, contents);
  return f;
}

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

test("the shipped CLI carries no API-base override at all", () => {
  const src = readFileSync(CLI, "utf8");
  assert.doesNotMatch(
    src,
    /SLACK_API_BASE_URL/,
    "an env-var API override hands the bearer token to whoever can set the variable"
  );
});

test("a symlinked path is refused outright, before any API call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slack-link-"));
  const real = path.join(dir, "secret.txt");
  writeFileSync(real, "sensitive");
  const link = path.join(dir, "innocuous.txt");
  symlinkSync(real, link);
  await withMock({}, async ({ base, seen }) => {
    const r = await runFile({ base, args: ["--target", CHANNEL, "--path", link] });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /symlink/);
    assert.equal(seen.api.length, 0, "a refusal must not have called Slack at all");
  });
});

test("a FIFO is refused rather than hanging the CLI forever", async () => {
  // Without O_NONBLOCK, opening a FIFO read-only blocks until a writer appears — the process
  // hangs before any validation runs. This asserts it returns, which is the whole point.
  const dir = mkdtempSync(path.join(tmpdir(), "slack-fifo-"));
  const fifo = path.join(dir, "pipe");
  const mk = await new Promise((resolve) =>
    execFile("python3", ["-c", "import os,sys;os.mkfifo(sys.argv[1])", fifo], (e) => resolve(!e))
  );
  if (!mk) return; // platform without mkfifo — nothing to assert
  await withMock({}, async ({ base, seen }) => {
    const r = await runFile({ base, args: ["--target", CHANNEL, "--path", fifo] });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /not a regular file/);
    assert.equal(seen.api.length, 0);
  });
});

// ── containment: the intermediate-symlink attack (AIO-1010) ─────────────────────────────────

test("a symlinked INTERMEDIATE directory cannot smuggle a file out of the workspace", async () => {
  // O_NOFOLLOW guards only the final component, so this is the case it does NOT catch:
  // `reports/link -> ../secrets`, then an upload of `reports/link/id_rsa`. Verified exploitable
  // before the fix; the refusal is by containment, not by symlink detection.
  const root = mkdtempSync(path.join(tmpdir(), "slack-contain-"));
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  mkdirSync(path.join(root, "work", "reports"), { recursive: true });
  writeFileSync(path.join(root, "secrets", "id_rsa"), "PRIVATE KEY MATERIAL");
  writeFileSync(path.join(root, "work", "reports", "ok.pdf"), "legit");
  symlinkSync(path.join(root, "secrets"), path.join(root, "work", "reports", "link"));
  const cwd = path.join(root, "work");

  await withMock({}, async ({ base, seen }) => {
    const attack = await runFileRaw({
      base,
      cwd,
      args: ["--target", CHANNEL, "--path", "reports/link/id_rsa"],
    });
    assert.equal(attack.status, 2, attack.stderr);
    // The refusal now names the SYMLINK rather than the containment verdict: the walk fails at
    // the component that is a symlink, which is both earlier and more useful than "resolves
    // outside the workspace" — it says which component to look at.
    assert.match(attack.stderr, /symlink/);
    assert.match(attack.stderr, /id_rsa|link/, "the refusal must identify what it refused");
    assert.equal(seen.api.length, 0, "a refusal must not have called Slack at all");

    // The same workspace, a real file: unaffected.
    const ok = await runFileRaw({
      base,
      cwd,
      args: ["--target", CHANNEL, "--path", "reports/ok.pdf", "--json"],
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(seen.uploadBody.toString(), "legit");
  });
});

test("a file outside the workspace needs the explicit flag, and works with it", async () => {
  // The /var-temp case that made a component-wise openat walk unusable: agents generate files
  // in temp dirs and upload them. Refused by default, allowed when somebody says so.
  const outside = mkdtempSync(path.join(tmpdir(), "slack-outside-"));
  writeFileSync(path.join(outside, "generated.pdf"), "report");
  const cwd = mkdtempSync(path.join(tmpdir(), "slack-cwd-"));
  const target = path.join(outside, "generated.pdf");

  await withMock({}, async ({ base, seen }) => {
    const refused = await runFileRaw({ base, cwd, args: ["--target", CHANNEL, "--path", target] });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /resolves outside this workspace/);
    assert.equal(seen.api.length, 0);

    const allowed = await runFileRaw({
      base,
      cwd,
      args: ["--target", CHANNEL, "--path", target, "--allow-outside-workspace", "--json"],
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(seen.uploadBody.toString(), "report");
  });
});

// ── the bypass a masked test hid (found by codex:gpt-5.6-sol) ───────────────────────────────

test("an IN-WORKSPACE symlink is refused in DEFAULT mode, not silently followed", async () => {
  // The earlier symlink test passed --allow-outside-workspace, which took the leaf-only path
  // and never exercised containment. Meanwhile containment resolved the WHOLE path before
  // walking it, so `report.txt -> .env` was replaced by `.env` before O_NOFOLLOW could object
  // and the secret uploaded. Both the code and the test were wrong; this pins the default path.
  const root = mkdtempSync(path.join(tmpdir(), "slack-inws-"));
  writeFileSync(path.join(root, ".env"), "SLACK_SECRET=leaked");
  symlinkSync(".env", path.join(root, "report.txt"));
  writeFileSync(path.join(root, "real.txt"), "fine");

  await withMock({}, async ({ base, seen }) => {
    const linked = await runFileRaw({
      base,
      cwd: root,
      args: ["--target", CHANNEL, "--path", "report.txt"],
    });
    assert.equal(linked.status, 2, linked.stderr);
    assert.match(linked.stderr, /symlink/);
    assert.equal(seen.api.length, 0, "a refusal must not have called Slack at all");

    // Same directory, a real file: unaffected.
    const ok = await runFileRaw({
      base,
      cwd: root,
      args: ["--target", CHANNEL, "--path", "real.txt", "--json"],
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(seen.uploadBody.toString(), "fine");
  });
});

test("a symlinked DIRECTORY component is refused, and says so", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "slack-lnkdir-"));
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  mkdirSync(path.join(root, "work", "reports"), { recursive: true });
  writeFileSync(path.join(root, "secrets", "id_rsa"), "PRIVATE KEY MATERIAL");
  symlinkSync(path.join(root, "secrets"), path.join(root, "work", "reports", "link"));

  await withMock({}, async ({ base, seen }) => {
    const r = await runFileRaw({
      base,
      cwd: path.join(root, "work"),
      args: ["--target", CHANNEL, "--path", "reports/link/id_rsa"],
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /symlink/, "the refusal must name the actual reason");
    assert.equal(seen.api.length, 0);
  });
});

// ── the upload URL is not ours (Bandit B310) ────────────────────────────────────────────────

test("an upload URL that is not https (or loopback http) is refused", async () => {
  // This POST carries the FILE CONTENTS, and the URL arrives in a Slack API RESPONSE — it is
  // not something we chose. urlopen honours file:, ftp: and anything else urllib has a handler
  // for, so a tampered response turns "upload to Slack" into "write this somewhere else", with
  // no prompt and no log line (the URL is deliberately never printed).
  for (const evil of ["file:///etc/passwd", "http://evil.example.com/collect", "ftp://x/y"]) {
    await withMock({ uploadUrl: evil }, async ({ base, seen }) => {
      const f = tmpFile("a.txt", "x");
      const r = await runFile({ base, args: ["--target", CHANNEL, "--path", f] });
      assert.equal(r.status, 5, `${evil} must be refused: ${r.stderr}`);
      assert.match(r.stderr, /non-https URL/);
      assert.doesNotMatch(r.stderr, /evil\.example\.com|etc\/passwd/, "never echo the URL");
      assert.equal(seen.attempts, 0, "nothing may be sent to it");
    });
  }
});

// ── `..` must be rejected BEFORE normalisation (found by codex:gpt-5.6-sol) ─────────────────

test("a `..` segment is refused before normalisation can hide a symlink", async () => {
  // os.path.abspath() calls normpath(), which collapses `..` LEXICALLY. Checking for `..`
  // afterwards checks a string that can no longer contain one: `reports/link/../../.env`
  // became `<cwd>/.env`, so BOTH the `..` and the symlinked `link` vanished before the
  // descriptor walk, and the workspace .env was uploaded. Verified exploitable.
  const root = mkdtempSync(path.join(tmpdir(), "slack-dotdot-"));
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  mkdirSync(path.join(root, "work", "reports"), { recursive: true });
  writeFileSync(path.join(root, "secrets", "id_rsa"), "PRIVATE KEY MATERIAL");
  writeFileSync(path.join(root, "work", ".env"), "SLACK_SECRET=leaked");
  writeFileSync(path.join(root, "work", "reports", "ok.pdf"), "legit");
  symlinkSync(path.join(root, "secrets"), path.join(root, "work", "reports", "link"));
  const cwd = path.join(root, "work");

  const escapes = [
    "reports/link/../../.env", // the reported exploit: hides a symlink AND escapes
    "../secrets/id_rsa", // plain escape
    "reports/../.env", // stays inside, still refused: `..` is not resolvable safely
  ];
  for (const spelled of escapes) {
    await withMock({}, async ({ base, seen }) => {
      const r = await runFileRaw({ base, cwd, args: ["--target", CHANNEL, "--path", spelled] });
      assert.equal(r.status, 2, `${spelled} must be refused: ${r.stderr}`);
      assert.match(r.stderr, /'\.\.'/);
      assert.equal(seen.api.length, 0, "a refusal must not have called Slack at all");
    });
  }

  // And a nested legitimate path is unaffected.
  await withMock({}, async ({ base, seen }) => {
    const ok = await runFileRaw({
      base,
      cwd,
      args: ["--target", CHANNEL, "--path", "reports/ok.pdf", "--json"],
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(seen.uploadBody.toString(), "legit");
  });
});

// ── the anchor must not absorb a symlink (found by codex:gpt-5.6-sol) ───────────────────────

test("a self-referential symlink cannot be absorbed into the resolved anchor", async () => {
  // `_components_under_root()` resolves an ANCHOR and descriptor-walks everything below it, so
  // whatever the anchor swallows is never checked. Picking the DEEPEST prefix whose realpath is
  // the root maximised that: with `selflink -> .`, `<ws>/selflink/.env` matched at
  // `<ws>/selflink`, returned just [".env"], and O_NOFOLLOW never saw `selflink`. The workspace
  // .env uploaded. Shallowest keeps every caller-spelled component in the walk.
  const root = mkdtempSync(path.join(tmpdir(), "slack-anchor-"));
  writeFileSync(path.join(root, ".env"), "SLACK_SECRET=leaked");
  writeFileSync(path.join(root, "real.txt"), "fine");
  symlinkSync(".", path.join(root, "selflink"));

  // Both spellings matter: the absolute one is what made the anchor search reach past the link.
  for (const spelled of [path.join(root, "selflink", ".env"), "selflink/.env"]) {
    await withMock({}, async ({ base, seen }) => {
      const r = await runFileRaw({
        base,
        cwd: root,
        args: ["--target", CHANNEL, "--path", spelled],
      });
      assert.equal(r.status, 2, `${spelled} must be refused: ${r.stderr}`);
      assert.match(r.stderr, /symlink/);
      assert.equal(seen.api.length, 0, "a refusal must not have called Slack at all");
    });
  }

  // An absolute path to a real file in the same workspace still works — the anchor search has
  // to keep resolving the /var-vs-/private/var spelling, which is why it exists at all.
  await withMock({}, async ({ base, seen }) => {
    const ok = await runFileRaw({
      base,
      cwd: root,
      args: ["--target", CHANNEL, "--path", path.join(root, "real.txt"), "--json"],
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(seen.uploadBody.toString(), "fine");
  });
});
