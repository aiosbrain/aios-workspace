// C8 telemetry — CLI tests. Drives the REAL `aios loop` CLI as a child process against a temp
// workspace + saved manifest (no collect/network). Proves the emit points (weekly/writeback/daily),
// the writeback approval matrix, the no-emit paths (preview/dry-run/missing-stamp/opt-out), and the
// `aios loop telemetry` dashboard + its arg parsing.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const STAMP = "2026-06-30T00-00-00-000Z";
const EVENTS_REL = path.join(".aios", "loop", "telemetry", "events.jsonl");

const sig = (p, row, tier, kind, summary, payload) => ({
  kind,
  source: kind,
  tier,
  occurredAt: "2026-06-29T00:00:00.000Z",
  ref: { path: p, row, tier },
  summary,
  ...(payload ? { payload } : {}),
});

const CLEAN_MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: "2026-06-30T00:00:00.000Z",
  window: { cadence: "weekly", from: "2026-06-23", to: "2026-06-30" },
  signals: [
    sig("4-shared/public.md", "1", "external", "deliverable", "Shipped the public widget"),
    sig("3-log/tasks.md", "2", "team", "task", "Follow up on the API decision", {
      status: "in_progress",
    }),
    sig("5-personal/secret.md", "7", "admin", "decision", "Acquisition ZZACQUISITION40M"),
  ],
  excluded: [],
};

// Admin distinctive token ALSO appears in a team summary → C5 withholds it → non-shippable.
const LEAK_MANIFEST = {
  ...CLEAN_MANIFEST,
  signals: [
    sig("5-personal/p.md", "1", "admin", "decision", "ProjectPhoenix budget is 40m"),
    sig("2-work/k.md", "2", "team", "task", "ProjectPhoenix kickoff scheduled"),
  ],
};

function workspace(manifest = CLEAN_MANIFEST) {
  const dir = mkdtempSync(path.join(tmpdir(), "c8-cli-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  mkdirSync(path.join(dir, "3-log"), { recursive: true });
  writeFileSync(
    path.join(dir, "3-log", "tasks.md"),
    "---\naccess: team\n---\n\n# Tasks\n\n| Key | Title | Status | Assignee | Sprint | Due |\n|-----|-------|--------|----------|--------|-----|\n"
  );
  const m = path.join(dir, "manifest.json");
  writeFileSync(m, JSON.stringify(manifest));
  return { dir, m };
}

function run(dir, args, env = {}) {
  try {
    const stdout = execFileSync("node", [CLI, "loop", ...args, "--repo", dir], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const readEvents = (dir) => {
  const p = path.join(dir, EVENTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
};
const kinds = (dir) => readEvents(dir).map((e) => e.kind);

test("weekly emits run + verify + shipped(clean); telemetry --json returns six metrics, leak 0", () => {
  const { dir, m } = workspace();
  try {
    const w = run(dir, ["weekly", "--manifest", m]);
    assert.equal(w.code, 0);
    const evs = readEvents(dir);
    assert.deepEqual(kinds(dir).sort(), ["weekly.run", "weekly.shipped", "weekly.verify"].sort());
    const shipped = evs.find((e) => e.kind === "weekly.shipped");
    assert.equal(shipped.payload.tierLeak, false);
    assert.ok(
      evs.every((e) => e.tier === "admin"),
      "all events admin-tier"
    );

    const t = run(dir, ["telemetry", "--json"]);
    assert.equal(t.code, 0);
    const m2 = JSON.parse(t.stdout);
    for (const k of [
      "tierLeakCount",
      "weeklyWallClock",
      "verifierShippableRate",
      "nextWeekActionAcceptance",
      "dailyRunFrequency",
      "consecutiveCleanWeeklies",
    ])
      assert.ok(m2[k], `metric ${k} present`);
    assert.equal(m2.tierLeakCount.value, 0);
    assert.equal(m2.tierLeakCount.met, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-shippable (leak-withheld) weekly writes NO weekly.shipped; tier-leak stays 0", () => {
  const { dir, m } = workspace(LEAK_MANIFEST);
  try {
    const w = run(dir, ["weekly", "--manifest", m]);
    assert.equal(w.code, 1, "non-shippable gates non-zero");
    assert.ok(!kinds(dir).includes("weekly.shipped"), "no shipped event for a withheld digest");
    const t = JSON.parse(run(dir, ["telemetry", "--json"]).stdout);
    assert.equal(t.tierLeakCount.value, 0, "nothing shipped → no leak on record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeback --local → approve with 0 task rows (ends clock, 0 accepted actions)", () => {
  const { dir, m } = workspace();
  try {
    run(dir, ["weekly", "--manifest", m]);
    const before = readEvents(dir).length;
    const r = run(dir, ["writeback", STAMP, "--local"]);
    assert.equal(r.code, 0);
    const approve = readEvents(dir).find((e) => e.kind === "weekly.approve");
    assert.ok(approve, "approve emitted");
    assert.deepEqual(approve.payload.targets, ["local"]);
    assert.deepEqual(approve.payload.taskRowsWritten, [], "no task rows under --local");
    assert.equal(readEvents(dir).length, before + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeback --sync → approve with a task row_key (accepted next-week action)", () => {
  const { dir, m } = workspace();
  try {
    run(dir, ["weekly", "--manifest", m, "--all"]);
    const r = run(dir, ["writeback", STAMP, "--sync"]);
    assert.equal(r.code, 0);
    const approve = readEvents(dir).find((e) => e.kind === "weekly.approve");
    assert.deepEqual(approve.payload.targets, ["sync"]);
    assert.ok(approve.payload.taskRowsWritten.length >= 1, "at least one accepted action row_key");
    assert.equal(approve.payload.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeback preview (no target) and --dry-run emit NO approval event", () => {
  const { dir, m } = workspace();
  try {
    run(dir, ["weekly", "--manifest", m]);
    const before = readEvents(dir).length;
    run(dir, ["writeback", STAMP]); // preview
    run(dir, ["writeback", STAMP, "--sync", "--dry-run"]); // dry-run
    assert.equal(readEvents(dir).length, before, "no approval events written");
    assert.ok(!kinds(dir).includes("weekly.approve"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeback with a missing stamp dies and writes NO event", () => {
  const { dir } = workspace();
  try {
    const r = run(dir, ["writeback", "2099-01-01T00-00-00-000Z", "--local"]);
    assert.notEqual(r.code, 0, "missing closeout fails loud");
    assert.equal(existsSync(path.join(dir, EVENTS_REL)), false, "no telemetry file created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daily records daily.run; --no-record and --manifest do not", () => {
  const { dir, m } = workspace();
  try {
    run(dir, ["daily"]);
    assert.deepEqual(kinds(dir), ["daily.run"]);
    run(dir, ["daily", "--no-record"]);
    assert.equal(kinds(dir).filter((k) => k === "daily.run").length, 1, "--no-record adds nothing");
    // --manifest is the inspection path; it needs an unwindowed daily manifest — but even a rejected
    // one must not record. Reuse the weekly manifest (wrong shape) → dies, records nothing.
    run(dir, ["daily", "--manifest", m]);
    assert.equal(kinds(dir).filter((k) => k === "daily.run").length, 1, "--manifest adds nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry --window parsing: rejects 0 / negative / non-numeric / --window+--all", () => {
  const { dir } = workspace();
  try {
    for (const bad of [
      ["--window", "0"],
      ["--window", "-1"],
      ["--window", "abc"],
      ["--window", "7", "--all"],
    ]) {
      const r = run(dir, ["telemetry", ...bad]);
      assert.notEqual(r.code, 0, `rejected: ${bad.join(" ")}`);
    }
    assert.equal(run(dir, ["telemetry", "--window", "30"]).code, 0, "a valid window is accepted");
    assert.equal(run(dir, ["telemetry", "--all"]).code, 0, "--all is accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AIOS_LOOP_TELEMETRY=0 disables recording for a weekly run", () => {
  const { dir, m } = workspace();
  try {
    const w = run(dir, ["weekly", "--manifest", m], { AIOS_LOOP_TELEMETRY: "0" });
    assert.equal(w.code, 0);
    assert.equal(existsSync(path.join(dir, EVENTS_REL)), false, "no telemetry file written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
