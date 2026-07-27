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
import { pullSyncOriginTasks, syncOriginRoute } from "../scripts/pull-tasks.mjs";

const TABLE = `# Tasks

| ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | Ship the thing | alex | todo | sprint-1 | — | linear:AIO-1 | http://l/1 |
`;

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-return-leg-"));
  const tasksPath = path.join(dir, "tasks-team.md");
  writeFileSync(tasksPath, TABLE);
  return tasksPath;
}

const feed = (rows) => ({
  mode: "sync-origin",
  tasks: [{ project: "mine", rows }],
  next_cursor: null,
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
  assert.deepEqual(res.rows.map((r) => r.row_key), ["T-01"]);
  const after = readFileSync(tasksPath, "utf8");
  assert.match(after, /\| T-01 \| Ship the thing \| alex \| done \| sprint-1 \| — \| linear:AIO-1 \| http:\/\/l\/1 \|/);
});

test("a pre-1.13 brain (writeback feed) merges NOTHING and does not advance the cursor", async () => {
  const tasksPath = workspace();
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: null,
    // An older brain ignores the unknown `mode` and answers with the dashboard writeback feed.
    fetchFeed: async () => ({
      mode: "writeback",
      tasks: [{ project: "mine", rows: [{ row_key: "T-01", status: "done", assignee: "alex" }] }],
    }),
  });
  assert.equal(res.supported, false);
  assert.deepEqual(res.rows, []);
  assert.equal(readFileSync(tasksPath, "utf8"), TABLE);
});

test("a 400/404 (fallback null) is tolerated: no merge, no cursor advance", async () => {
  const tasksPath = workspace();
  const res = await pullSyncOriginTasks({
    project: "mine",
    tasksPath,
    since: null,
    fetchFeed: async () => null, // apiOptional's fallback for 400/404
  });
  assert.equal(res.supported, false);
  assert.deepEqual(res.rows, []);
  assert.equal(readFileSync(tasksPath, "utf8"), TABLE);
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
