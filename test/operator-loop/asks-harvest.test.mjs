// Asks harvest (AIO-167) — the REAL production caller, driven as `aios asks harvest` child
// processes against temp workspaces. Proves the full collect → detect → dispatch → sink path
// creates asks, re-harvest suppresses open duplicates, and gate rejections are counted (not written).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const NOW = "2026-07-01T12:00:00Z";

const dlog = (rows) =>
  "---\naccess: team\n---\n\n" +
  "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
  "|---|---|---|---|---|---|---|---|\n" +
  rows.map((r) => `| ${r} |`).join("\n") +
  "\n";

// A workspace with a decision-log (the detectable loop events) + a comms config (the sender's
// destination gate). `audience` on each row is the event tier; the channel tier authorizes it.
function workspace({ audience = "team", channelTier = "team", on = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-harvest-"));
  mkdirSync(path.join(dir, "3-log"), { recursive: true });
  mkdirSync(path.join(dir, ".aios"), { recursive: true });
  writeFileSync(
    path.join(dir, "3-log", "decision-log.md"),
    dlog([`1 | 2026-07-01 | Adopt new arch | r | alex | i | 3 | ${audience}`])
  );
  writeFileSync(
    path.join(dir, ".aios", "comms-config.json"),
    JSON.stringify({ sender: { channel: "#loop", on }, channels: { "#loop": channelTier } })
  );
  return dir;
}

function harvest(dir, extra = []) {
  const out = execFileSync(
    "node",
    [CLI, "asks", "harvest", "--cadence", "daily", "--now", NOW, "--json", "--repo", dir, ...extra],
    { cwd: ROOT, encoding: "utf8" }
  );
  return JSON.parse(out);
}
function list(dir) {
  const out = execFileSync("node", [CLI, "asks", "list", "--json", "--repo", dir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out).asks;
}

test("harvest creates an ask through the full pipeline; re-harvest suppresses the open duplicate", () => {
  const dir = workspace();
  try {
    const first = harvest(dir);
    assert.equal(first.events, 1);
    assert.equal(first.delivered, 1);
    assert.equal(first.suppressed, 0);
    const asks = list(dir);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].kind, "decision");
    assert.equal(asks[0].severity, "decision");
    assert.equal(asks[0].ref, "3-log/decision-log.md#1");
    assert.ok(asks[0].dedupeKey, "harvested ask carries a dedupeKey");

    const second = harvest(dir);
    assert.equal(second.events, 1);
    assert.equal(second.delivered, 0);
    assert.equal(second.suppressed, 1);
    assert.equal(list(dir).length, 1, "no duplicate open ask on re-harvest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harvest counts a gate rejection (team event, external channel) and writes nothing", () => {
  // Team content must NOT reach an external-audience channel → audience-not-authorized.
  const dir = workspace({ audience: "team", channelTier: "external" });
  try {
    const res = harvest(dir);
    assert.equal(res.events, 1);
    assert.equal(res.delivered, 0);
    assert.equal(res.rejected, 1);
    assert.equal(res.byReason["audience-not-authorized"], 1);
    assert.equal(list(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harvest counts a trigger-gate no-op (sender.on excludes the event) and writes nothing", () => {
  const dir = workspace({ on: ["scope-change"] }); // decision event is not in sender.on
  try {
    const res = harvest(dir);
    assert.equal(res.events, 1);
    assert.equal(res.delivered, 0);
    assert.equal(res.noop, 1);
    assert.equal(res.byReason["not-triggered"], 1);
    assert.equal(list(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
