// AIO-1068 — workspace-containment port tests for `aios slack file`, mirroring the
// slack.py policy the Python suite proved: refusals happen BEFORE any Slack request, on
// the caller-spelled path. Each denial case asserts zero requests in the capture log.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { AIOS, SYNTHETIC_TOKEN, runSlack, scrubbedEnv } from "./helpers/slack-test-env.mjs";

function workspace() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "aio-1068-contain-")));
  mkdirSync(path.join(dir, "reports"));
  writeFileSync(path.join(dir, "reports", "ok.txt"), "fine\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=never-upload-this\n");
  return dir;
}

function upload(cwd, filePath, extraArgs = []) {
  return runSlack(
    AIOS,
    ["slack", "file", "--target", "C0GENERAL", "--path", filePath, ...extraArgs],
    { env: scrubbedEnv({ SLACK_USER_TOKEN: SYNTHETIC_TOKEN }), cwd }
  );
}

function assertRefusedOffline(result, pattern) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, pattern);
  assert.deepEqual(result.requests, [], "a refusal must not have spoken to Slack at all");
}

test("a contained relative and absolute spelling of the same file both upload", () => {
  const ws = workspace();
  try {
    for (const spelling of ["reports/ok.txt", path.join(ws, "reports", "ok.txt")]) {
      const result = upload(ws, spelling);
      assert.equal(result.status, 0, `${spelling}: ${result.stderr}`);
      assert.match(result.stdout, /^uploaded → C0GENERAL: ok\.txt/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("`..` is refused on the caller-spelled path, before any normalization", () => {
  const ws = workspace();
  try {
    assertRefusedOffline(upload(ws, "reports/../reports/ok.txt"), /containing '\.\.'/);
    assertRefusedOffline(upload(ws, "reports/../../outside.txt"), /containing '\.\.'/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a path escaping the workspace is refused without --allow-outside-workspace", () => {
  const ws = workspace();
  const outside = mkdtempSync(path.join(tmpdir(), "aio-1068-outside-"));
  try {
    writeFileSync(path.join(outside, "leak.txt"), "outside bytes\n");
    const refused = upload(ws, path.join(outside, "leak.txt"));
    assertRefusedOffline(refused, /resolves outside this workspace/);
    const allowed = upload(ws, path.join(outside, "leak.txt"), ["--allow-outside-workspace"]);
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked leaf is refused even when it points inside the workspace", () => {
  const ws = workspace();
  try {
    symlinkSync(path.join(ws, ".env"), path.join(ws, "reports", "innocent.txt"));
    assertRefusedOffline(upload(ws, "reports/innocent.txt"), /through a symlink/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a symlinked intermediate directory is refused (the reports -> ~/.ssh attack)", () => {
  const ws = workspace();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "aio-1068-elsewhere-"));
  try {
    writeFileSync(path.join(elsewhere, "id_rsa"), "private key bytes\n");
    symlinkSync(elsewhere, path.join(ws, "keys"));
    assertRefusedOffline(upload(ws, "keys/id_rsa"), /symlinked directory/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a workspace-aliasing symlink anchor cannot absorb caller-spelled components", () => {
  // slack.py's shallowest-anchor rule: with `loop -> .`, /ws/loop/.env must be refused —
  // a deepest-anchor match would silently absorb `loop` and admit `.env`.
  const ws = workspace();
  try {
    symlinkSync(".", path.join(ws, "loop"));
    assertRefusedOffline(upload(ws, path.join(ws, "loop", ".env")), /symlinked directory/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("empty files, directories, and FIFOs are refused from the opened descriptor", () => {
  const ws = workspace();
  try {
    writeFileSync(path.join(ws, "empty.txt"), "");
    assertRefusedOffline(upload(ws, "empty.txt"), /empty file/);
    assertRefusedOffline(upload(ws, "reports"), /[Nn]ot a regular file/);
    const fifo = spawnSync("mkfifo", [path.join(ws, "pipe")], { encoding: "utf8" });
    if (fifo.status === 0) {
      // O_NONBLOCK on the leaf open: a FIFO must refuse promptly, never hang for a writer.
      assertRefusedOffline(upload(ws, "pipe"), /[Nn]ot a regular file/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the size cap is enforced on the bytes read, one byte past the cap", async () => {
  const ws = workspace();
  try {
    const { MAX_UPLOAD_BYTES } = await import("../scripts/connectors/slack/files.mjs");
    writeFileSync(path.join(ws, "big.bin"), Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    assertRefusedOffline(upload(ws, "big.bin"), /upload cap/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
