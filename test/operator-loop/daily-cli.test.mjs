// `aios loop daily` CLI tests. Drives the real CLI as a child process against a temp workspace.
// Proves: --manifest --json is deterministic and parseable; --manifest writes NOTHING (the
// key C4-vs-weekly property); --as external hides admin content + excluded refs; the human view
// renders three sections + owner marker + empty-state; --as bogus gates non-zero; and a real
// owner run records ONLY the local snapshot, leaving the continuity store untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const ADMIN_SENTINEL = "ZZACQUISITION40M";
const GEN = "2026-06-30T12:00:00.000Z";

const sig = (kind, tier, ref, summary, payload = {}) => ({
  kind,
  source: kind,
  tier,
  occurredAt: GEN,
  ref,
  summary,
  payload,
});

const MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: GEN,
  window: { cadence: "daily", from: "2026-06-29T12:00:00.000Z", to: GEN },
  windowed: false,
  signals: [
    sig(
      "decision",
      "external",
      { path: "4-shared/pub.md", row: "1", tier: "external" },
      "Public decision"
    ),
    sig(
      "task",
      "admin",
      { path: "3-log/tasks.md", row: "T-1", tier: "admin" },
      `Admin task ${ADMIN_SENTINEL}`,
      {
        status: "blocked",
      }
    ),
    sig(
      "carryover",
      "team",
      { path: ".aios/loop/continuity/actions.json", row: "c1", tier: "team" },
      "Carry over: Follow up",
      { title: "Follow up", status: "open", due: "2026-06-30", createdAt: "2026-06-29T00:00:00Z" }
    ),
  ],
  excluded: [{ ref: "3-log/hours.md", reason: "no tier" }],
};

function workspace(manifest = MANIFEST) {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-cli-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  const m = path.join(dir, "manifest.json");
  writeFileSync(m, JSON.stringify(manifest));
  return { dir, m };
}

function run(cwd, args) {
  try {
    const stdout = execFileSync("node", [CLI, "loop", "daily", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("daily --manifest --json emits a parseable, deterministic DailyOrientation", () => {
  const { dir, m } = workspace();
  const r1 = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r1.code, 0, r1.stderr);
  const o = JSON.parse(r1.stdout);
  assert.ok(Array.isArray(o.changed) && Array.isArray(o.blocked) && Array.isArray(o.owedToday));
  const r2 = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r2.stdout, r1.stdout);
});

test("daily --manifest writes nothing — no snapshot, no artifacts (read-only)", () => {
  const { dir, m } = workspace();
  const before = readdirSync(dir).sort();
  const r = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.ok(!existsSync(path.join(dir, ".aios")));
});

test("daily --manifest rejects windowed daily collect manifests", () => {
  const { dir, m } = workspace({ ...MANIFEST, windowed: true });
  const r = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires an unwindowed full-state manifest/);
});

test("daily --manifest without a path fails before any live collect or snapshot write", () => {
  const { dir } = workspace();
  const before = readdirSync(dir).sort();
  const r = run(dir, ["--manifest", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--manifest requires a path/);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.ok(!existsSync(path.join(dir, ".aios")));
});

test("daily --as external hides admin content and withholds excluded refs", () => {
  const { dir, m } = workspace();
  const r = run(dir, ["--manifest", m, "--as", "external", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(ADMIN_SENTINEL), "admin sentinel must not appear in a shared view");
  const o = JSON.parse(r.stdout);
  assert.equal(o.audience, "external");
  assert.equal(o.excluded.length, 0);
  assert.equal(o.counts.excluded, 1);
  assert.ok(![...o.changed, ...o.blocked, ...o.owedToday].some((i) => i.tier === "admin"));
});

test("daily human view: owner marker + three sections; empty manifest → friendly empty-state", () => {
  const { dir, m } = workspace();
  const r = run(dir, ["--manifest", m]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /owner-private/);
  assert.match(r.stdout, /Changed \(/);
  assert.match(r.stdout, /Blocked \(/);
  assert.match(r.stdout, /Owed today \(/);

  const { dir: d2, m: em } = workspace({ ...MANIFEST, signals: [], excluded: [] });
  const r2 = run(d2, ["--manifest", em]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /You're clear/);

  const { dir: d3, m: excludedOnly } = workspace({
    ...MANIFEST,
    signals: [],
    excluded: [{ ref: "3-log/tasks.md#x", reason: "no tier" }],
  });
  const r3 = run(d3, ["--manifest", excludedOnly]);
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /No classifiable daily items/);
  assert.match(r3.stdout, /excluded \(default-deny\)/);
  assert.doesNotMatch(r3.stdout, /You're clear/);
});

test("daily --as bogus exits non-zero with a clear message", () => {
  const { dir, m } = workspace();
  const r = run(dir, ["--manifest", m, "--as", "bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /must be team\|external/);
});

test("owner run records ONLY the local snapshot; continuity store byte-unchanged; nothing outside .aios", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-rec-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  mkdirSync(path.join(dir, ".aios", "loop", "continuity"), { recursive: true });
  const actionsPath = path.join(dir, ".aios", "loop", "continuity", "actions.json");
  const actions = JSON.stringify(
    {
      version: 1,
      actions: [
        {
          id: "c1",
          title: "Follow up",
          status: "open",
          tier: "team",
          createdAt: "2026-06-29T00:00:00Z",
        },
      ],
    },
    null,
    2
  );
  writeFileSync(actionsPath, actions);

  const topBefore = readdirSync(dir).sort();
  const r = run(dir, ["--json"]); // owner → records
  assert.equal(r.code, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  // Carryover is visible somewhere (owed if fresh, blocked if the wall clock makes it stale).
  assert.ok([...o.owedToday, ...o.blocked].some((i) => i.ref.row === "c1"));

  assert.deepEqual(readdirSync(dir).sort(), topBefore); // no new top-level entries
  assert.ok(existsSync(path.join(dir, ".aios", "loop", "state", "changes-daily.json")));
  assert.equal(readFileSync(actionsPath, "utf8"), actions); // continuity untouched
});
