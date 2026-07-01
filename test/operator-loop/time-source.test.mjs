import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeStore, collect } from "../../dist/operator-loop/index.js";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-ws-src-"));
  mkdirSync(path.join(root, "3-log"));
  return realpathSync(root);
}
const NOW = new Date("2026-07-02T00:00:00Z");
const row = (o) => ({
  id: o.id,
  startIso: o.startIso,
  endIso: o.endIso ?? o.startIso,
  repo: o.repo ?? "aios-workspace",
  runtimeMin: o.runtimeMin ?? 30,
  tag: o.tag ?? "engineering",
  tier: o.tier ?? "team",
  confirmed: o.confirmed ?? false,
  taskRef: o.taskRef ?? "",
});

test("collector: valid time rows emit kind:'time' with per-row tier; admin retained; summary tag-only", () => {
  const root = workspace();
  writeStore(root, [
    row({
      id: "t1",
      startIso: "2026-07-01T09:00:00Z",
      tier: "team",
      tag: "engineering",
      runtimeMin: 40,
    }),
    row({
      id: "t2",
      startIso: "2026-07-01T10:00:00Z",
      tier: "admin",
      tag: "admin",
      runtimeMin: 20,
      repo: "personal-life",
    }),
  ]);
  const m = collect({ root, cadence: "weekly", now: NOW });
  const time = m.signals.filter((s) => s.kind === "time");
  assert.equal(time.length, 2);
  const t1 = time.find((s) => s.ref.row === "t1");
  const t2 = time.find((s) => s.ref.row === "t2");
  assert.equal(t1.tier, "team");
  assert.equal(t2.tier, "admin"); // admin retained in the owner manifest
  assert.equal(t1.source, "session");
  assert.match(t1.summary, /engineering — 40m/);
  assert.ok(!t1.summary.includes("aios-workspace")); // no repo/alias in summary
  assert.ok(!t2.summary.includes("personal-life"));
  assert.equal(t1.occurredAt, new Date("2026-07-01T09:00:00Z").toISOString()); // occurredAt = start
  rmSync(root, { recursive: true, force: true });
});

test("collector: a time row with an unresolvable tier is excluded (default-deny)", () => {
  const root = workspace();
  writeStore(root, [
    row({ id: "bad", startIso: "2026-07-01T09:00:00Z", tier: "nonsense" }),
    row({ id: "ok", startIso: "2026-07-01T09:00:00Z", tier: "team" }),
  ]);
  const m = collect({ root, cadence: "weekly", now: NOW });
  assert.equal(m.signals.filter((s) => s.kind === "time").length, 1);
  assert.ok(m.excluded.some((e) => e.ref.includes("bad") && /default-deny/.test(e.reason)));
  rmSync(root, { recursive: true, force: true });
});

test("collector: time is windowed by start time (row older than 7d excluded)", () => {
  const root = workspace();
  writeStore(root, [
    row({ id: "recent", startIso: "2026-07-01T09:00:00Z", tier: "team" }),
    row({ id: "old", startIso: "2026-06-01T09:00:00Z", tier: "team" }),
  ]);
  const m = collect({ root, cadence: "weekly", now: NOW });
  const ids = m.signals.filter((s) => s.kind === "time").map((s) => s.ref.row);
  assert.deepEqual(ids.sort(), ["recent"]);
  rmSync(root, { recursive: true, force: true });
});
