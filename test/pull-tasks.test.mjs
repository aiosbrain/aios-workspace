#!/usr/bin/env node
// test/pull-tasks.test.mjs — the `aios pull` half of the sync-origin return leg
// (brain-api 1.13, AIO-537): feature detection against an older brain, cursor safety, and the
// actual file write. Assertions are derived from docs/brain-api.md § sync-origin return leg.
// Zero network (the feed fetch is injected). Run: node test/pull-tasks.test.mjs

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PAGES, pullSyncOriginTasks, syncOriginRoute } from "../scripts/pull-tasks.mjs";

const TABLE = `# Tasks

| ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | Ship the thing | alex | todo | sprint-1 | — | linear:AIO-1 | http://l/1 |
| T-02 | Review the thing | sam | in_progress | sprint-1 | — |  |  |
`;

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-return-leg-"));
  const tasksPath = path.join(dir, "tasks-team.md");
  writeFileSync(tasksPath, TABLE);
  return tasksPath;
}

const feed = (rows, next_cursor = null) => ({
  mode: "sync-origin",
  tasks: [{ project: "mine", rows }],
  next_cursor,
});

test("requests the versioned mode + project + cursor", () => {
  const route = syncOriginRoute("mine", "2026-07-01T00:00:00Z");
  assert.match(route, /^\/tasks\?/);
  const qs = new URLSearchParams(route.split("?")[1]);
  assert.equal(qs.get("mode"), "sync-origin");
  assert.equal(qs.get("project"), "mine");
  assert.equal(qs.get("since"), "2026-07-01T00:00:00Z");
  assert.equal(new URLSearchParams(syncOriginRoute("mine", null).split("?")[1]).get("since"),
    "1970-01-01T00:00:00Z");
});

test("merges a real brain status change into the markdown", async () => {
  const tasksPath = workspace();
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: null,
    fetchFeed: async () => feed([{ row_key: "T-01", status: "done", assignee: "alex", raw_status: null }]),
  });
  assert.equal(res.supported, true);
  assert.ok(res.cursor > "2026-", "a drained feed advances the cursor to now");
  assert.deepEqual(res.rows.map((r) => r.row_key), ["T-01"]);
  const after = readFileSync(tasksPath, "utf8");
  assert.match(after, /\| T-01 \| Ship the thing \| alex \| done \| sprint-1 \| — \| linear:AIO-1 \| http:\/\/l\/1 \|/);
});

test("a pre-1.13 brain (writeback feed) merges NOTHING and does not advance the cursor", async () => {
  const tasksPath = workspace();
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: "2026-07-01T00:00:00Z",
    // An older brain ignores the unknown `mode` and answers with the dashboard writeback feed.
    fetchFeed: async () => ({
      mode: "writeback",
      tasks: [{ project: "mine", rows: [{ row_key: "T-01", status: "done", assignee: "alex" }] }],
    }),
  });
  assert.equal(res.supported, false);
  assert.equal(res.cursor, "2026-07-01T00:00:00Z", "cursor must not move past unsent changes");
  assert.deepEqual(res.rows, []);
  assert.equal(readFileSync(tasksPath, "utf8"), TABLE);
});

test("a 400/404 (fallback null) is tolerated: no merge, no cursor advance", async () => {
  const tasksPath = workspace();
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: "2026-07-01T00:00:00Z",
    fetchFeed: async () => null, // apiOptional's fallback for a 404/500
  });
  assert.equal(res.supported, false);
  assert.equal(res.cursor, "2026-07-01T00:00:00Z");
  assert.deepEqual(res.rows, []);
  assert.equal(readFileSync(tasksPath, "utf8"), TABLE);
});

// A full page comes back with `next_cursor`; jumping the cursor to now would strand the rest of
// the backlog forever (reachable on the first EPOCH-cursor pull over a long-lived table).
test("drains every page before advancing the cursor", async () => {
  const tasksPath = workspace();
  const seen = [];
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: null,
    fetchFeed: async (route) => {
      seen.push(new URLSearchParams(route.split("?")[1]).get("since"));
      return seen.length === 1
        ? feed([{ row_key: "T-02", status: "done", assignee: "", raw_status: null }], "2026-07-10T00:00:00.000Z")
        : feed([{ row_key: "T-01", status: "blocked", assignee: "", raw_status: null }]);
    },
  });
  assert.deepEqual(seen, ["1970-01-01T00:00:00Z", "2026-07-10T00:00:00.000Z"]);
  assert.deepEqual(res.rows.map((r) => r.row_key), ["T-02", "T-01"]);
  const after = readFileSync(tasksPath, "utf8");
  assert.match(after, /\| T-01 \| Ship the thing \| alex \| blocked \|/);
  assert.match(after, /\| T-02 \| Review the thing \| sam \| done \|/);
});

test("a brain that never stops paging is bounded, and resumes from the last cursor", async () => {
  const tasksPath = workspace();
  let calls = 0;
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: null,
    fetchFeed: async () => {
      calls++;
      return feed([], `2026-07-${String(Math.min(calls, 28)).padStart(2, "0")}T00:00:00.000Z`);
    },
  });
  assert.equal(calls, MAX_PAGES);
  assert.equal(res.cursor, `2026-07-${String(MAX_PAGES).padStart(2, "0")}T00:00:00.000Z`);
});

test("a normalization echo is a supported-but-empty pull (cursor may advance, file untouched)", async () => {
  const tasksPath = workspace();
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: null,
    // The brain only normalized our own `todo` → backlog; raw_status still holds our word.
    fetchFeed: async () =>
      feed([{ row_key: "T-01", status: "backlog", assignee: "alex", raw_status: "todo" }]),
  });
  assert.equal(res.supported, true);
  assert.deepEqual(res.rows, []);
  assert.equal(readFileSync(tasksPath, "utf8"), TABLE);
});
