/**
 * slack-personal-upload-paths.test.mjs — PATH SECURITY for `slack file`.
 *
 * Every case here was a real finding: symlinked leaf, symlinked directory, self-referential
 * symlink absorbed into the resolved anchor, `..` collapsed by normalisation before it could be
 * rejected, a non-https upload URL, and an env override that handed the bearer token to whoever
 * could set it. Each one could put a workspace secret into a Slack channel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CHANNEL,
  CLI,
  runFile,
  runFileRaw,
  tmpFile,
  withMock,
} from "./slack-personal-upload-fixtures.mjs";

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
