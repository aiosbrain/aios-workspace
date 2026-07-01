// Privacy boundary: telemetry events are admin-tier operational data, so the ledger under
// .aios/loop/telemetry/ must NEVER be syncable. Drives the REAL CLI: emit a telemetry event (via a
// daily run), then `aios status --json`, and assert the sync gate never lists it. Mirrors
// manifest-nonsync.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "c8-telem-nonsync-"));
  mkdirSync(path.join(dir, "3-log"), { recursive: true });
  // sync_include deliberately lists 3-log so a regression that wrote telemetry there (or that
  // walked .aios) would show up in the plan.
  writeFileSync(
    path.join(dir, "aios.yaml"),
    ["version: 1", 'brain_url: ""', "sync_tiers:", "  - team", "sync_include:", "  - 3-log"].join(
      "\n"
    ) + "\n"
  );
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(dir, "3-log", "decision-log.md"),
    "---\naccess: team\n---\n\n| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n|---|---|---|---|---|---|---|---|\n" +
      `| 1 | ${today} | A decision | r | alex | i | 1 | team |\n`
  );
  return dir;
}

test("the telemetry ledger under .aios/loop is never picked up by the sync gate", () => {
  const dir = makeWorkspace();

  // A real owner daily run records a daily.run event into .aios/loop/telemetry/events.jsonl.
  execFileSync("node", [AIOS, "loop", "daily", "--repo", dir], { cwd: REPO, encoding: "utf8" });
  const events = path.join(dir, ".aios", "loop", "telemetry", "events.jsonl");
  assert.ok(existsSync(events), "telemetry ledger was written");

  const out = execFileSync("node", [AIOS, "status", "--json", "--repo", dir], {
    cwd: REPO,
    encoding: "utf8",
  });
  const jsonLine = out
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  assert.ok(jsonLine, `no JSON line in status output:\n${out}`);
  const items = JSON.parse(jsonLine).items;
  const all = [
    ...(items.new || []),
    ...(items.modified || []),
    ...(items.blocked || []),
    ...(items.clean || []),
  ];

  assert.ok(
    !all.some((i) => (i.rel || "").includes(".aios")),
    "no .aios path (telemetry ledger) appears in the sync plan"
  );
  // positive control: the real team-tier file IS seen, proving the gate is active
  assert.ok(
    all.some((i) => (i.rel || "").endsWith("decision-log.md")),
    "decision-log.md is in the plan"
  );
});
