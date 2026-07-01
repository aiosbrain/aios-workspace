import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeStore, collect, buildDailyOrientation } from "../../dist/operator-loop/index.js";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-ws-daily-"));
  mkdirSync(path.join(root, "3-log"));
  return realpathSync(root);
}
const row = (o) => ({
  endIso: o.startIso,
  repo: "aios-workspace",
  runtimeMin: 30,
  tag: "engineering",
  tier: "team",
  confirmed: false,
  taskRef: "",
  ...o,
});
const NOW = new Date("2026-07-02T00:00:00Z");

test("daily: ranByTag includes only in-window (start-attributed) runtime; audience-filtered", () => {
  const root = workspace();
  writeStore(root, [
    row({
      id: "r1",
      startIso: "2026-07-01T12:00:00Z",
      runtimeMin: 40,
      tag: "engineering",
      tier: "team",
    }),
    row({
      id: "r2",
      startIso: "2026-06-29T00:00:00Z",
      runtimeMin: 30,
      tag: "research",
      tier: "team",
    }), // >1d old
    row({
      id: "r3",
      startIso: "2026-07-01T13:00:00Z",
      runtimeMin: 20,
      tag: "admin",
      tier: "admin",
      repo: "personal-life",
    }),
  ]);
  const manifest = collect({ root, cadence: "daily", now: NOW, window: false });

  const owner = buildDailyOrientation({ manifest, prior: null, audience: "owner" }).orientation;
  assert.deepEqual(owner.ranByTag.map((t) => t.tag).sort(), ["admin", "engineering"]); // r2 out of window
  assert.equal(owner.ranByTag.find((t) => t.tag === "engineering").durationMin, 40);

  const team = buildDailyOrientation({ manifest, prior: null, audience: "team" }).orientation;
  assert.deepEqual(
    team.ranByTag.map((t) => t.tag),
    ["engineering"]
  ); // admin row filtered out

  rmSync(root, { recursive: true, force: true });
});

test("daily: ranByTag is empty when no time captured", () => {
  const root = workspace();
  const manifest = collect({ root, cadence: "daily", now: NOW, window: false });
  const o = buildDailyOrientation({ manifest, prior: null, audience: "owner" }).orientation;
  assert.deepEqual(o.ranByTag, []);
  rmSync(root, { recursive: true, force: true });
});
