// `aios loop verify` CLI tests: input validation (a user-visible contract) and the anti-leak
// guarantee on stdout. Drives the real CLI as a child process against temp fixture files.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
// `aios loop` resolves a workspace root from cwd before dispatching; run from the synthetic
// sample workspace so the command reaches `verify`. Fixture files use absolute paths, so the
// cwd only matters for workspace resolution, not for locating the manifest/ledger.
const SAMPLE_WS = path.join(ROOT, "examples", "sample-engagement");

// Run the CLI; return { code, stdout, stderr }. Never throws on non-zero exit.
function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, "loop", "verify", ...args], {
      cwd: SAMPLE_WS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: "2026-06-30T00:00:00.000Z",
  window: { cadence: "weekly", from: "2026-06-23", to: "2026-06-30" },
  signals: [
    {
      kind: "deliverable",
      source: "deliverable",
      tier: "external",
      occurredAt: "2026-06-29T00:00:00.000Z",
      ref: { path: "4-shared/x.md", row: "1", tier: "external" },
      summary: "shipped X",
    },
    {
      kind: "decision",
      source: "decision-log",
      tier: "admin",
      occurredAt: "2026-06-29T00:00:00.000Z",
      ref: { path: "5-personal/acme-acquisition-secret.md", row: "7", tier: "admin" },
      summary: "margin",
    },
  ],
  excluded: [],
};

function fixtures(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "c3-cli-"));
  const m = path.join(dir, "m.json");
  const l = path.join(dir, "l.json");
  writeFileSync(m, JSON.stringify(MANIFEST));
  writeFileSync(l, JSON.stringify({ entries }));
  return { dir, m, l };
}

test("--ledger without --manifest is a usage error (non-zero)", () => {
  const { dir, l } = fixtures([]);
  const r = run(["--ledger", l, "--as", "external"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--ledger requires a matching --manifest/);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid --as audience is a usage error", () => {
  const { dir, m, l } = fixtures([]);
  const r = run(["--manifest", m, "--ledger", l, "--as", "nobody"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--as must be owner\|team\|external/);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid ledger JSON fails loud with a clear message", () => {
  const { dir, m, l } = fixtures([]);
  writeFileSync(l, "{ not json ");
  const r = run(["--manifest", m, "--ledger", l, "--as", "external"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /invalid JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test("a malformed ledger entry (evidence not an array) is rejected", () => {
  const { dir, m, l } = fixtures([]);
  writeFileSync(l, JSON.stringify({ entries: [{ claim: "x", evidence: "nope" }] }));
  const r = run(["--manifest", m, "--ledger", l, "--as", "external"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /evidence must be an array/);
  rmSync(dir, { recursive: true, force: true });
});

test("valid manifest+ledger with a mixed claim → FAILED, exit 1, no admin leak in --json", () => {
  const { dir, m, l } = fixtures([
    { claim: "We shipped X", evidence: [{ path: "4-shared/x.md", row: "1", tier: "external" }] },
    {
      claim: "We shipped X at a 40pct margin",
      evidence: [
        { path: "4-shared/x.md", row: "1", tier: "external" },
        { path: "5-personal/acme-acquisition-secret.md", row: "7", tier: "admin" },
      ],
    },
  ]);
  const r = run(["--manifest", m, "--ledger", l, "--as", "external", "--json"]);
  assert.equal(r.code, 1, "a failed verification must gate (exit 1)");
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, "failed");
  assert.ok(!r.stdout.includes("40pct"), "mixed admin-derived text must not leak");
  assert.ok(!r.stdout.includes("acme-acquisition-secret"), "admin path must not leak");
  rmSync(dir, { recursive: true, force: true });
});

test("a malformed manifest signal (missing ref) is rejected with a clear error", () => {
  const { dir, m, l } = fixtures([{ claim: "x", evidence: [] }]);
  writeFileSync(
    m,
    JSON.stringify({ ...MANIFEST, signals: [{ kind: "decision", source: "x", tier: "team" }] })
  );
  const r = run(["--manifest", m, "--ledger", l, "--as", "external"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /signals\[0\]\.ref: path must be a string/);
  rmSync(dir, { recursive: true, force: true });
});

test("conflicting --daily --weekly is rejected", () => {
  const { dir, m, l } = fixtures([
    { claim: "We shipped X", evidence: [{ path: "4-shared/x.md", row: "1", tier: "external" }] },
  ]);
  const r = run(["--manifest", m, "--ledger", l, "--daily", "--weekly"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /mutually exclusive/);
  rmSync(dir, { recursive: true, force: true });
});

test("valid clean ledger → PASS, exit 0", () => {
  const { dir, m, l } = fixtures([
    { claim: "We shipped X", evidence: [{ path: "4-shared/x.md", row: "1", tier: "external" }] },
  ]);
  const r = run(["--manifest", m, "--ledger", l, "--as", "external", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).status, "pass");
  rmSync(dir, { recursive: true, force: true });
});
