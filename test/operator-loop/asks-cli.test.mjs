// Asks CLI (AIO-167) — drives the real `aios asks` command as a child process. Proves the
// round-trip (add → list → show → resolve → drain), OFFLINE routing from a repo with NO aios.yaml
// (like `aios time`), the `--repo` flag, JSON output contracts, and error exit codes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASKS_STORE_REL } from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function ws() {
  // A bare temp dir with NO aios.yaml — exercises the offline config path.
  return mkdtempSync(path.join(tmpdir(), "asks-cli-"));
}
// Run against the repo, with cwd set to the bare workspace (so we also prove it does not need to be
// launched from inside the toolkit and finds no aios.yaml walking up).
function run(dir, args) {
  try {
    const stdout = execFileSync("node", [CLI, "asks", ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("mistyped subcommand suggests the nearest valid command", () => {
  const dir = ws();
  try {
    const res = run(dir, ["resovle"]);
    assert.equal(res.code, 1);
    assert.match(String(res.stderr), /did you mean `aios asks resolve`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round-trip: add → list → show → resolve → drain (offline, no aios.yaml)", () => {
  const dir = ws();
  try {
    const add = run(dir, [
      "add",
      "--kind",
      "blocker-thing",
      "--severity",
      "blocker",
      "--title",
      "Need input?",
      "--json",
    ]);
    assert.equal(add.code, 0);
    const { id } = JSON.parse(add.stdout);
    assert.ok(id, "add prints the created id");

    const listed = run(dir, ["list", "--json"]);
    assert.equal(listed.code, 0);
    const parsed = JSON.parse(listed.stdout);
    assert.ok(Array.isArray(parsed.asks) && Array.isArray(parsed.warnings), "list JSON contract");
    assert.equal(parsed.asks.length, 1);
    assert.equal(parsed.asks[0].severity, "blocker");

    const shown = run(dir, ["show", id, "--json"]);
    assert.equal(shown.code, 0);
    assert.equal(JSON.parse(shown.stdout).id, id);

    const resolved = run(dir, ["resolve", id, "--json"]);
    assert.equal(resolved.code, 0);
    assert.deepEqual(JSON.parse(resolved.stdout).resolved, [id]);

    assert.equal(
      JSON.parse(run(dir, ["list", "--json"]).stdout).asks.length,
      0,
      "no open asks left"
    );
    assert.equal(
      JSON.parse(run(dir, ["list", "--status", "resolved", "--json"]).stdout).asks.length,
      1
    );

    const drain = run(dir, ["drain", "--json"]);
    assert.equal(drain.code, 0);
    const d = JSON.parse(drain.stdout);
    for (const k of ["drained", "orphaned", "gcRemoved", "gcSkipped", "remainingOpen"])
      assert.ok(k in d, `drain JSON has ${k}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drain resolves open asks by default (inbox-zero) and reports the count", () => {
  const dir = ws();
  try {
    run(dir, ["add", "--kind", "k", "--severity", "fyi", "--title", "one"]);
    run(dir, ["add", "--kind", "k", "--severity", "fyi", "--title", "two"]);
    const d = JSON.parse(run(dir, ["drain", "--json"]).stdout);
    assert.equal(d.drained, 2);
    assert.equal(JSON.parse(run(dir, ["list", "--json"]).stdout).asks.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drain --keep-open leaves open asks in place (read-only peek)", () => {
  const dir = ws();
  try {
    run(dir, ["add", "--kind", "k", "--severity", "fyi", "--title", "one"]);
    const d = JSON.parse(run(dir, ["drain", "--keep-open", "--json"]).stdout);
    assert.equal(d.drained, 0);
    assert.equal(d.remainingOpen, 1);
    assert.equal(JSON.parse(run(dir, ["list", "--json"]).stdout).asks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("error codes: no subcommand, bad severity, bad status, unknown-id resolve (no write)", () => {
  const dir = ws();
  try {
    assert.notEqual(run(dir, []).code, 0, "no subcommand → usage die");
    assert.notEqual(
      run(dir, ["add", "--kind", "k", "--severity", "urgent", "--title", "t"]).code,
      0,
      "invalid severity rejected"
    );
    assert.notEqual(run(dir, ["list", "--status", "bogus"]).code, 0, "invalid status rejected");
    // Unknown id dies BEFORE any write — the store must not be created.
    assert.notEqual(run(dir, ["resolve", "does-not-exist"]).code, 0);
    assert.equal(
      existsSync(path.join(dir, ASKS_STORE_REL)),
      false,
      "no store written on failed resolve"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("show accepts a unique id prefix", () => {
  const dir = ws();
  try {
    const { id } = JSON.parse(
      run(dir, ["add", "--kind", "k", "--severity", "fyi", "--title", "t", "--json"]).stdout
    );
    const shown = run(dir, ["show", id.slice(0, 8), "--json"]);
    assert.equal(shown.code, 0);
    assert.equal(JSON.parse(shown.stdout).id, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
