import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect, runDaily } from "../../dist/operator-loop/index.js";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-ws-comms-"));
  mkdirSync(path.join(root, "1-inbox", "comms"), { recursive: true });
  mkdirSync(path.join(root, "3-log"), { recursive: true });
  return realpathSync(root);
}

function writeActivity(root, records) {
  const file = path.join(root, "1-inbox", "comms", "activity.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const NOW = new Date("2026-07-02T00:00:00Z");

test("comms source: emits kind:'comms' signals with tier + evidence ref + payload contract", () => {
  const root = workspace();
  writeActivity(root, [
    {
      source: "slack",
      tier: "team",
      occurredAt: "2026-07-01T12:00:00Z",
      ref: "msg-1",
      channel: "#eng",
      direction: "inbound",
      summary: "Waiting on design review",
      waitingOn: "alex",
    },
  ]);

  const m = collect({ root, cadence: "weekly", now: NOW });
  const comms = m.signals.filter((s) => s.kind === "comms");
  assert.equal(comms.length, 1);
  const s = comms[0];
  assert.equal(s.source, "slack");
  assert.equal(s.tier, "team");
  assert.equal(s.ref.row, "msg-1");
  assert.equal(s.ref.path, "1-inbox/comms/activity.jsonl");
  assert.equal(s.payload.channel, "#eng");
  assert.equal(s.payload.direction, "inbound");
  assert.equal(s.payload.summary, "Waiting on design review");
  assert.equal(s.payload.waitingOn, "alex");
});

test("comms source: a record with no resolvable tier is default-denied (excluded, never emitted)", () => {
  const root = workspace();
  writeActivity(root, [
    { source: "email", occurredAt: "2026-07-01T12:00:00Z", ref: "e1", summary: "no tier" },
    {
      source: "email",
      tier: "bogus",
      occurredAt: "2026-07-01T12:00:00Z",
      ref: "e2",
      summary: "bad tier",
    },
  ]);

  const m = collect({ root, cadence: "weekly", now: NOW });
  assert.equal(m.signals.filter((s) => s.kind === "comms").length, 0);
  assert.equal(m.excluded.filter((e) => /no resolvable tier/.test(e.reason)).length, 2);
});

test("comms source: fixed max lookback bounds the source; collector's cadence window trims further", () => {
  const root = workspace();
  writeActivity(root, [
    {
      source: "slack",
      tier: "team",
      occurredAt: "2026-07-01T12:00:00Z",
      ref: "today",
      summary: "within 1d",
    },
    {
      source: "slack",
      tier: "team",
      occurredAt: "2026-06-29T12:00:00Z",
      ref: "midweek",
      summary: "3d old",
    },
    {
      source: "slack",
      tier: "team",
      occurredAt: "2026-06-20T12:00:00Z",
      ref: "ancient",
      summary: "12d old",
    },
  ]);

  // Daily (1d) window: the collector filter keeps only the record inside the last day.
  const daily = collect({ root, cadence: "daily", now: NOW });
  const dailyRefs = daily.signals.filter((s) => s.kind === "comms").map((s) => s.ref.row);
  assert.deepEqual(dailyRefs, ["today"]);

  // Unwindowed: the source's own 168h max bound still drops the 12-day-old record, but keeps
  // the 3-day-old one (inside the source max, outside the daily cadence window).
  const all = collect({ root, cadence: "daily", now: NOW, window: false });
  const allRefs = all.signals
    .filter((s) => s.kind === "comms")
    .map((s) => s.ref.row)
    .sort();
  assert.deepEqual(allRefs, ["midweek", "today"]);
});

test("comms source: future-dated records are dropped by the source's max-bound", () => {
  const root = workspace();
  writeActivity(root, [
    {
      source: "calendar",
      tier: "team",
      occurredAt: "2026-07-10T00:00:00Z",
      ref: "future",
      summary: "later",
    },
  ]);
  const m = collect({ root, cadence: "weekly", now: NOW, window: false });
  assert.equal(m.signals.filter((s) => s.kind === "comms").length, 0);
});

test("daily loop: comms waiting-on items populate the blocked section (AIO-140 acceptance)", () => {
  const root = workspace();
  writeActivity(root, [
    {
      source: "slack",
      tier: "team",
      occurredAt: "2026-07-01T20:00:00Z",
      ref: "wait-1",
      channel: "#eng",
      summary: "Need sign-off before deploy",
      waitingOn: "sam",
    },
    {
      source: "slack",
      tier: "team",
      occurredAt: "2026-07-01T20:05:00Z",
      ref: "chatter",
      channel: "#eng",
      summary: "lunch plans", // no waitingOn, not blocked → not a daily blocker
    },
  ]);

  const orientation = runDaily({ root, now: NOW, record: false });
  const blockedComms = orientation.blocked.filter((i) => i.kind === "comms");
  assert.equal(blockedComms.length, 1);
  assert.equal(blockedComms[0].ref.row, "wait-1");
});

test("daily loop: an external-tier comms blocker is hidden from a team audience projection", () => {
  const root = workspace();
  writeActivity(root, [
    {
      source: "email",
      tier: "admin",
      occurredAt: "2026-07-01T20:00:00Z",
      ref: "admin-wait",
      summary: "private blocker",
      waitingOn: "owner",
    },
  ]);
  // Owner sees it; a team-audience view filters admin out.
  const owner = runDaily({ root, now: NOW, record: false, audience: "owner" });
  assert.equal(owner.blocked.filter((i) => i.kind === "comms").length, 1);
  const team = runDaily({ root, now: NOW, record: false, audience: "team" });
  assert.equal(team.blocked.filter((i) => i.kind === "comms").length, 0);
});
