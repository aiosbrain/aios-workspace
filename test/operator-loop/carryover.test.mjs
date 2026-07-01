// C7 continuity tests. Run after `npm run build:loop` (npm test builds first).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../../dist/operator-loop/index.js";

const NOW = new Date("2026-03-31T12:00:00Z");

function makeWorkspace(actions) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-loop-carry-"));
  mkdirSync(path.join(dir, ".aios", "loop", "continuity"), { recursive: true });
  writeFileSync(
    path.join(dir, ".aios", "loop", "continuity", "actions.json"),
    JSON.stringify({ version: 1, actions }, null, 2)
  );
  return dir;
}

test("unresolved continuity actions surface as carry-over signals in daily and weekly runs", () => {
  const dir = makeWorkspace([
    {
      id: "next-1",
      title: "Follow up on the API decision",
      status: "open",
      tier: "team",
      createdAt: "2026-01-01T00:00:00Z",
      due: "2026-04-01",
      source: { path: "3-log/decision-log.md", row: "7", tier: "team" },
    },
    {
      id: "done-1",
      title: "Already closed",
      status: "done",
      tier: "team",
    },
    {
      id: "completed-1",
      title: "Already completed",
      status: "completed",
      tier: "team",
    },
    {
      id: "complete-1",
      title: "Already complete",
      status: "complete",
      tier: "team",
    },
    {
      id: "missing-tier",
      title: "Do not guess my tier",
      status: "open",
    },
  ]);

  for (const cadence of ["daily", "weekly"]) {
    const manifest = collect({ root: dir, cadence, now: NOW });
    const carry = manifest.signals.filter((s) => s.kind === "carryover");
    assert.equal(carry.length, 1, `${cadence} has one open tiered carry-over`);
    assert.equal(carry[0].summary, "Carry over: Follow up on the API decision (due 2026-04-01)");
    assert.equal(carry[0].occurredAt, NOW.toISOString(), "carry-over remains visible this run");
    assert.equal(carry[0].tier, "team");
    assert.equal(carry[0].ref.path, ".aios/loop/continuity/actions.json");
    assert.equal(carry[0].ref.row, "next-1");
    assert.equal(carry[0].payload.source.path, "3-log/decision-log.md");
    assert.ok(
      !manifest.signals.some((s) => s.ref.row === "done-1"),
      "closed action is not carried"
    );
    assert.ok(
      !manifest.signals.some((s) => s.ref.row === "completed-1"),
      "completed action is not carried"
    );
    assert.ok(
      !manifest.signals.some((s) => s.ref.row === "complete-1"),
      "complete action is not carried"
    );
    assert.ok(
      manifest.excluded.some(
        (e) => e.ref.endsWith("#missing-tier") && /default-deny/.test(e.reason)
      ),
      "missing-tier action is default-denied"
    );
  }
});

test("an unrecognized continuity-store version is rejected (fail closed, no carry-over)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-loop-carry-"));
  mkdirSync(path.join(dir, ".aios", "loop", "continuity"), { recursive: true });
  writeFileSync(
    path.join(dir, ".aios", "loop", "continuity", "actions.json"),
    JSON.stringify(
      {
        version: 2,
        actions: [{ id: "next-1", title: "From a v2 store", status: "open", tier: "team" }],
      },
      null,
      2
    )
  );

  const manifest = collect({ root: dir, cadence: "weekly", now: NOW });
  assert.ok(
    !manifest.signals.some((s) => s.kind === "carryover"),
    "no carry-over signals are emitted from an unsupported store version"
  );
  assert.ok(
    manifest.excluded.some(
      (e) => e.ref === ".aios/loop/continuity/actions.json" && /version 1/.test(e.reason)
    ),
    "the version mismatch is recorded in excluded[]"
  );
});

test("malformed continuity action refs cannot collide with id-based carry-over refs", () => {
  const dir = makeWorkspace([
    {
      id: "1",
      title: "Numeric id should keep id-based ref",
      status: "open",
      tier: "team",
    },
    {
      id: "missing-title",
      status: "open",
      tier: "team",
    },
  ]);

  const manifest = collect({ root: dir, cadence: "daily", now: NOW });
  assert.ok(
    manifest.signals.some(
      (s) =>
        s.kind === "carryover" &&
        s.ref.path === ".aios/loop/continuity/actions.json" &&
        s.ref.row === "1"
    ),
    "valid numeric id keeps the carry-over signal ref"
  );
  assert.ok(
    manifest.excluded.some(
      (e) =>
        e.ref === ".aios/loop/continuity/actions.json#actions[1]" &&
        /missing id\/title/.test(e.reason)
    ),
    "malformed action uses an array-slot ref, not an id-like ref"
  );
});
