import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBlocks, tagBlock } from "../../dist/operator-loop/index.js";

const T = (iso) => Date.parse(iso);
const ev = (sessionId, iso, cwd, extra = {}) => ({
  sessionId,
  tsMs: T(iso),
  cwdRealpath: cwd,
  gitBranch: null,
  actor: "user",
  toolName: null,
  ...extra,
});

const NOW = T("2026-07-02T00:00:00Z"); // well after the test events → all finalize
const IDLE = 25;

test("deriveBlocks: idle gap splits; short block kept, single-event run dropped", () => {
  const evs = [
    ev("s1", "2026-07-01T09:00:00Z", "/repo"),
    ev("s1", "2026-07-01T09:10:00Z", "/repo"),
    ev("s1", "2026-07-01T09:40:00Z", "/repo"), // gap 30 > 25 → new run (single → dropped)
  ];
  const blocks = deriveBlocks(evs, { nowMs: NOW, idleGapMin: IDLE });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].runtimeMin, 10);
  assert.equal(blocks[0].cwdRealpath, "/repo");
  assert.equal(blocks[0].id.length, 10);
});

test("deriveBlocks: out-of-order events are sorted before segmentation", () => {
  const evs = [
    ev("s1", "2026-07-01T09:20:00Z", "/repo"),
    ev("s1", "2026-07-01T09:00:00Z", "/repo"),
    ev("s1", "2026-07-01T09:10:00Z", "/repo"),
  ];
  const blocks = deriveBlocks(evs, { nowMs: NOW, idleGapMin: IDLE });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].runtimeMin, 20);
});

test("deriveBlocks: ongoing block (last event within idle window of now) is not finalized", () => {
  const evs = [
    ev("s1", "2026-07-01T09:00:00Z", "/repo"),
    ev("s1", "2026-07-01T09:10:00Z", "/repo"),
  ];
  const openNow = T("2026-07-01T09:20:00Z"); // 10m after last < idle 25 → still open
  assert.equal(deriveBlocks(evs, { nowMs: openNow, idleGapMin: IDLE }).length, 0);
  const idleNow = T("2026-07-01T10:00:00Z"); // gone idle → finalizes
  assert.equal(deriveBlocks(evs, { nowMs: idleNow, idleGapMin: IDLE }).length, 1);
});

test("deriveBlocks: concurrent sessions both count (runtime SUMS, no union)", () => {
  const evs = [
    ev("s1", "2026-07-01T09:00:00Z", "/repoA"),
    ev("s1", "2026-07-01T09:20:00Z", "/repoA"),
    ev("s2", "2026-07-01T09:05:00Z", "/repoB"), // overlaps s1
    ev("s2", "2026-07-01T09:25:00Z", "/repoB"),
  ];
  const blocks = deriveBlocks(evs, { nowMs: NOW, idleGapMin: IDLE });
  assert.equal(blocks.length, 2);
  assert.equal(
    blocks.reduce((a, b) => a + b.runtimeMin, 0),
    40
  ); // 20 + 20, not a ~25 union
});

test("deriveBlocks: a run with no attributable cwd is dropped", () => {
  const evs = [ev("s1", "2026-07-01T09:00:00Z", null), ev("s1", "2026-07-01T09:10:00Z", null)];
  assert.equal(deriveBlocks(evs, { nowMs: NOW, idleGapMin: IDLE }).length, 0);
});

test("tagBlock: tool-mix and path drive the tag", () => {
  assert.equal(
    tagBlock({ cwdRealpath: "/x/repo", toolCounts: { Edit: 5, Bash: 3 } }),
    "engineering"
  );
  assert.equal(tagBlock({ cwdRealpath: "/x/repo", toolCounts: { WebSearch: 4 } }), "research");
  assert.equal(
    tagBlock({ cwdRealpath: "/x/repo", toolCounts: { mcp__slack__send: 3 } }),
    "communication"
  );
  assert.equal(
    tagBlock({ cwdRealpath: "/x/repo", toolCounts: { mcp__granola__list: 2 } }),
    "meetings"
  );
  assert.equal(tagBlock({ cwdRealpath: "/ws/0-context", toolCounts: {} }), "strategy");
  assert.equal(tagBlock({ cwdRealpath: "/x/repo", toolCounts: {} }), "engineering"); // fallback
});
