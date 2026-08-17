// test/cli-version.test.mjs — `aios --version` answers with a version, not the usage banner.
//
// Before this, none of `--version`, `-v` or `version` matched a registered command, so the CLI
// fell through to the unknown-command branch: ~190 lines of usage on stdout, `error: unknown
// command: --version` on stderr, exit 1. There was no way to ask an installed CLI what version
// it was — which matters most on a global `npm i -g @aiosbrain/aios`, where there is no
// package.json next to the caller to read instead.
//
// Kept out of test/cli-registry.test.mjs deliberately: that file sits at its grandfathered
// size cap (scripts/size-caps.json), and per scripts/CLAUDE.md a capped file is extracted
// from, never grown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const BANNER = "aios — AIOS Team Brain sync client";
const SPELLINGS = [["--version"], ["-v"], ["version"]];

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [AIOS, ...args], {
    encoding: "utf8",
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmpDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("cli: every version spelling prints the package version and exits 0", () => {
  // The temp cwd is the point: like the help path, this resolves before any repo/config lookup,
  // so it must answer with no workspace anywhere above the caller.
  const dir = tmpDir("aios-version-");
  const expected = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  try {
    for (const args of SPELLINGS) {
      const label = `aios ${args.join(" ")}`;
      const r = run(args, { cwd: dir });
      assert.equal(r.code, 0, `${label} exited ${r.code}: ${r.stderr}`);
      assert.match(
        r.stdout.trim(),
        new RegExp(`^v${expected.replace(/\./g, "\\.")}\\b`),
        `${label} printed ${JSON.stringify(r.stdout)}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: the version flags do not fall through to the unknown-command branch", () => {
  // The exact regression. Asserting only "stdout contains the version" would still pass if the
  // banner came back too, so both halves of the old behavior are pinned as absent.
  const dir = tmpDir("aios-version-noban-");
  try {
    for (const args of SPELLINGS) {
      const label = `aios ${args.join(" ")}`;
      const r = run(args, { cwd: dir });
      assert.ok(!r.stdout.includes(BANNER), `${label} printed the usage banner`);
      assert.ok(!/unknown command/.test(r.stderr), `${label} stderr: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: --version reports the brain-api contract version alongside the semver", () => {
  // docs/brain-api.md is the pinned sync contract, so "which contract does this CLI speak?" is
  // the second question anyone asking for a version actually has. Read from the doc, not a
  // literal, so a contract bump cannot leave this assertion stale.
  const dir = tmpDir("aios-version-contract-");
  const doc = readFileSync(path.join(REPO, "docs", "brain-api.md"), "utf8");
  const contract = /\*\*Version:\s*([0-9]+\.[0-9]+)\*\*/.exec(doc)?.[1];
  try {
    assert.ok(contract, "docs/brain-api.md has no `**Version: N.M**` header");
    const r = run(["--version"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`brain-api ${contract}`), `printed ${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: the help text documents the version flag", () => {
  const dir = tmpDir("aios-version-help-");
  try {
    const r = run(["--help"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\s+-v, --version\s+\S/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
