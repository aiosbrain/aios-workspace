// Privacy boundary: run manifests carry admin-tier signals, so they must NEVER be syncable.
// They're written to .aios/loop/ (a dot-dir outside sync_include) as .json. This drives the
// REAL CLI: collect a manifest, then `aios status --json`, and assert the gate never lists it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-loop-nonsync-"));
  mkdirSync(path.join(dir, "3-log"), { recursive: true });
  // sync_include deliberately lists 3-log so a regression that wrote manifests there (or that
  // walked .aios) would show up in the plan.
  writeFileSync(
    path.join(dir, "aios.yaml"),
    ["version: 1", 'brain_url: ""', "sync_tiers:", "  - team", "sync_include:", "  - 3-log"].join(
      "\n"
    ) + "\n"
  );
  const today = new Date().toISOString().slice(0, 10); // in-window date for the collector
  writeFileSync(
    path.join(dir, "3-log", "decision-log.md"),
    "---\naccess: team\n---\n\n| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n|---|---|---|---|---|---|---|---|\n" +
      `| 1 | ${today} | A decision | r | alex | i | 1 | team |\n`
  );
  return dir;
}

test("collected manifests under .aios/loop are never picked up by the sync gate", () => {
  const dir = makeWorkspace();

  execFileSync("node", [AIOS, "loop", "collect", "--weekly", "--repo", dir], {
    cwd: REPO,
    encoding: "utf8",
  });
  const manifestDir = path.join(dir, ".aios", "loop", "manifests");
  assert.ok(existsSync(manifestDir), "manifest dir created");
  assert.ok(
    readdirSync(manifestDir).some((f) => f.endsWith(".json")),
    "a .json manifest was written"
  );

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
    "no .aios path appears in the sync plan"
  );
  // positive control: the real team-tier file IS seen, proving the gate is active
  assert.ok(
    all.some((i) => (i.rel || "").endsWith("decision-log.md")),
    "decision-log.md is in the plan"
  );
});
