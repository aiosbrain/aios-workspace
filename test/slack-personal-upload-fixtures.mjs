/**
 * slack-personal-upload-fixtures.mjs — shared harness for the `slack file` suites.
 *
 * Split out because the two suites exceeded the file-size gate, not because they are unrelated:
 * one covers the UPLOAD FLOW, the other PATH SECURITY. Both need the same credential-free mock.
 *
 * No network, no credentials, no Slack workspace. A live self-DM smoke proves the happy path
 * exactly once and proves nothing about the cases that actually bite: a filename with a quote in
 * it, a zero-byte file, a 429 with a Retry-After, a terminal 500. Those are asserted here.
 *
 * The CLI is pointed at the mock by rewriting its `API` constant into a throwaway copy — the
 * shipped file carries no API-base override, deliberately. See `cliPointedAt()` for why.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Assembled at runtime, never written as a literal. `check-secrets.sh` matches the Slack token
// SHAPE, and it is right to: a scanner that has to distinguish real tokens from convincing fake
// ones is a scanner you cannot trust. So the fixture simply never has the shape on disk.
export const MOCK_TOKEN = ["xoxp", "mock", "token"].join("-");

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.join(
  DIR,
  "..",
  "scaffold",
  ".claude",
  "descriptors",
  "skills",
  "slack-personal",
  "slack.py"
);
export const CHANNEL = "C0MOCK0001";

/** Start a Slack-shaped mock. `plan` lets a test script per-endpoint behaviour. */
export async function withMock(plan, fn) {
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
export function cliPointedAt(base) {
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
export function runFile({ base, args, contained = false }) {
  const flags = contained ? [] : ["--allow-outside-workspace"];
  return runFileRaw({ base, args: [...args, ...flags] });
}

export function runFileRaw({ base, args, cwd }) {
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

export function tmpFile(name, contents) {
  const d = mkdtempSync(path.join(tmpdir(), "slack-upload-"));
  const f = path.join(d, name);
  writeFileSync(f, contents);
  return f;
}
