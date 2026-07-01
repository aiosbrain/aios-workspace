// Change-tracking primitive tests (changes.ts). Run after `npm run build:loop` (npm test
// builds first). Content-fingerprint diff + fail-closed snapshot store.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  artifactKey,
  fingerprint,
  canonicalJson,
  diffSignals,
  readSnapshot,
  writeSnapshot,
} from "../../dist/operator-loop/index.js";

const NOW = new Date("2026-06-30T12:00:00.000Z");

const sig = (p, row, tier, kind, summary, payload, occurredAt) => ({
  kind,
  source: kind,
  tier,
  occurredAt: occurredAt ?? "2026-06-30T00:00:00.000Z",
  ref: { path: p, row, tier },
  summary,
  payload,
});

test("artifactKey keys on path plus optional row", () => {
  assert.equal(
    artifactKey(sig("3-log/tasks.md", "T-1", "team", "task", "x", {})),
    "3-log/tasks.md#T-1"
  );
  assert.equal(
    artifactKey(sig("2-work/a.md", undefined, "team", "deliverable", "x", {})),
    "2-work/a.md"
  );
});

test("fingerprint is stable across payload key order and ignores occurredAt", () => {
  const a = sig(
    "t.md",
    "1",
    "team",
    "task",
    "Title",
    { due: "2026-07-01", status: "open" },
    "2026-06-30T00:00:00Z"
  );
  const b = sig(
    "t.md",
    "1",
    "team",
    "task",
    "Title",
    { status: "open", due: "2026-07-01" },
    "2026-06-30T09:00:00Z"
  );
  assert.equal(fingerprint(a), fingerprint(b));
});

test("fingerprint changes when a payload field changes", () => {
  const a = sig("t.md", "1", "team", "task", "Title", { status: "open" });
  const b = sig("t.md", "1", "team", "task", "Title", { status: "blocked" });
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test("fingerprint changes when tier changes (governance re-tag)", () => {
  const a = sig("t.md", "1", "team", "decision", "D", {});
  const b = sig("t.md", "1", "admin", "decision", "D", {});
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test("canonicalJson sorts object keys recursively, preserves array order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}');
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("diffSignals: first run marks every artifact added and seeds the next snapshot", () => {
  const s1 = sig("t.md", "1", "team", "task", "A", { status: "open" });
  const { changes, next } = diffSignals({ prior: null, signals: [s1], now: NOW, scope: "daily" });
  assert.equal(changes.get("t.md#1").changeType, "added");
  assert.equal(next.version, 1);
  assert.equal(next.scope, "daily");
  assert.ok(next.artifacts["t.md#1"]);
});

test("diffSignals: unchanged / modified / added against a prior; timestamps preserved", () => {
  const s1 = sig("t.md", "1", "team", "task", "A", { status: "open" });
  const first = diffSignals({ prior: null, signals: [s1], now: NOW, scope: "daily" }).next;
  const later = new Date("2026-07-01T12:00:00.000Z");

  const s1mod = sig("t.md", "1", "team", "task", "A", { status: "blocked" });
  const s2 = sig("t.md", "2", "team", "task", "B", { status: "open" });
  const { changes } = diffSignals({
    prior: first,
    signals: [s1mod, s2],
    now: later,
    scope: "daily",
  });
  assert.equal(changes.get("t.md#1").changeType, "modified");
  assert.equal(changes.get("t.md#1").firstSeenAt, NOW.toISOString());
  assert.equal(changes.get("t.md#1").lastChangedAt, later.toISOString());
  assert.equal(changes.get("t.md#2").changeType, "added");

  const { changes: c2 } = diffSignals({ prior: first, signals: [s1], now: later, scope: "daily" });
  assert.equal(c2.get("t.md#1").changeType, "unchanged");
  assert.equal(c2.get("t.md#1").lastChangedAt, NOW.toISOString());
});

test("diffSignals: a snapshot from another scope is not a valid baseline (re-baselines)", () => {
  const s1 = sig("t.md", "1", "team", "task", "A", { status: "open" });
  const weekly = diffSignals({ prior: null, signals: [s1], now: NOW, scope: "weekly" }).next;
  const { changes } = diffSignals({ prior: weekly, signals: [s1], now: NOW, scope: "daily" });
  assert.equal(changes.get("t.md#1").changeType, "added");
});

test("writeSnapshot round-trips; readSnapshot is fail-closed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-changes-"));
  assert.equal(readSnapshot(dir, "daily"), null); // missing → null

  const store = {
    version: 1,
    scope: "daily",
    updatedAt: NOW.toISOString(),
    artifacts: {
      "a#1": { fingerprint: "x", firstSeenAt: NOW.toISOString(), lastChangedAt: NOW.toISOString() },
    },
  };
  writeSnapshot(dir, store);
  assert.deepEqual(readSnapshot(dir, "daily"), store);
  assert.equal(readSnapshot(dir, "weekly"), null); // scope mismatch → null

  const p = path.join(dir, ".aios", "loop", "state", "changes-daily.json");
  writeFileSync(p, "{not json");
  assert.equal(readSnapshot(dir, "daily"), null); // corrupt → null

  writeFileSync(p, JSON.stringify({ ...store, version: 2 }));
  assert.equal(readSnapshot(dir, "daily"), null); // wrong version → null
});
