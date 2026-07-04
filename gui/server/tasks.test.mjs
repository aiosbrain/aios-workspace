import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveTasksFile,
  readTasks,
  derivePushState,
  applyTaskEdit,
  TaskEditError,
  EDITABLE_FIELDS,
} from "./tasks.mjs";

const TASKS = `---
status: living
owner: alex
access: team
---

# Tasks

| ID | Task | Assignee | Status | Sprint | Due |
|----|------|----------|--------|--------|-----|
| T-01 | Run survey | Riley | done | sprint-1 | 2026-03-12 |
| T-02 | Findings report | Riley | in_progress | sprint-1 | 2026-04-03 |
`;

/** Stamp a throwaway workspace with a tasks.md at the given spine + frontmatter. */
function makeRepo(spine = "03-status", content = TASKS) {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-tasks-"));
  mkdirSync(path.join(repo, spine), { recursive: true });
  writeFileSync(path.join(repo, spine, "tasks.md"), content);
  return repo;
}

test("resolveTasksFile: modern 3-log wins, legacy 03-status is the fallback, else null", () => {
  const legacy = makeRepo("03-status");
  assert.equal(resolveTasksFile(legacy).rel, "03-status/tasks.md");
  const modern = makeRepo("3-log");
  assert.equal(resolveTasksFile(modern).rel, "3-log/tasks.md");
  const empty = mkdtempSync(path.join(tmpdir(), "aios-tasks-empty-"));
  assert.equal(resolveTasksFile(empty), null);
  for (const r of [legacy, modern, empty]) rmSync(r, { recursive: true, force: true });
});

test("readTasks: parses rows + file-level tier from access frontmatter", () => {
  const repo = makeRepo("03-status");
  const out = readTasks(resolveTasksFile(repo));
  assert.equal(out.rel, "03-status/tasks.md");
  assert.equal(out.tier, "team");
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].row_key, "T-01");
  assert.equal(out.rows[0].status, "done");
  rmSync(repo, { recursive: true, force: true });
});

test("readTasks: private access normalizes to admin tier", () => {
  const repo = makeRepo("03-status", TASKS.replace("access: team", "access: private"));
  assert.equal(readTasks(resolveTasksFile(repo)).tier, "admin");
  rmSync(repo, { recursive: true, force: true });
});

test("applyTaskEdit: patches one row, preserves frontmatter + every other row", () => {
  const { content, row } = applyTaskEdit(TASKS, "T-01", { status: "blocked", assignee: "Sam" });
  assert.equal(row.status, "blocked");
  assert.equal(row.assignee, "Sam");
  // frontmatter intact
  assert.ok(content.startsWith("---\nstatus: living"));
  assert.ok(content.includes("access: team"));
  // the edited row changed…
  assert.match(content, /\| T-01 \| Run survey \| Sam \| blocked \|/);
  // …and the untouched row is byte-identical
  assert.match(
    content,
    /\| T-02 \| Findings report \| Riley \| in_progress \| sprint-1 \| 2026-04-03 \|/
  );
});

test("applyTaskEdit: rejects title/body/description edits (400), never mutates", () => {
  for (const bad of [{ title: "x" }, { body: "y" }, { description: "z" }]) {
    assert.throws(
      () => applyTaskEdit(TASKS, "T-01", bad),
      (e) => e instanceof TaskEditError && e.status === 400
    );
  }
  // sanity: the editable set is exactly the five light fields
  assert.deepEqual([...EDITABLE_FIELDS].sort(), [
    "assignee",
    "labels",
    "parent",
    "priority",
    "status",
  ]);
});

test("applyTaskEdit: retired plane: PM link survives a status edit (history kept)", () => {
  const withPm = `---
access: team
---

# Tasks

| ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
|----|------|----------|--------|--------|-----|----|--------|
| T-01 | Run survey | Riley | in_progress | s1 |  | plane:T-01 | http://x |
`;
  const { content, row } = applyTaskEdit(withPm, "T-01", { status: "done" });
  assert.equal(row.status, "done");
  // the retired plane: cell is preserved verbatim (not blanked) and not re-projected as a provider
  assert.equal(row.pm_provider, undefined);
  assert.equal(row.pm_raw, "plane:T-01");
  assert.match(content, /\| plane:T-01 \| http:\/\/x \|/);
  assert.match(content, /\| T-01 \| Run survey \| Riley \| done \| s1 \|/);
});

test("applyTaskEdit: unknown row_key throws 404", () => {
  assert.throws(
    () => applyTaskEdit(TASKS, "T-99", { status: "done" }),
    (e) => e instanceof TaskEditError && e.status === 404
  );
});

test("applyTaskEdit: hierarchy patch widens the table in place", () => {
  const { content } = applyTaskEdit(TASKS, "T-01", { priority: "high", labels: ["urgent", "ops"] });
  assert.match(content, /\| Parent \| Labels \| Priority \|/);
  assert.match(content, /urgent, ops \| high \|/);
});

test("derivePushState: maps rel across new/modified/blocked/clean buckets", () => {
  const rel = "03-status/tasks.md";
  assert.deepEqual(derivePushState({ items: { new: [{ rel }] } }, rel), { state: "new" });
  assert.deepEqual(derivePushState({ items: { modified: [{ rel }] } }, rel), { state: "modified" });
  assert.deepEqual(
    derivePushState({ items: { blocked: [{ rel, reason: "`access: admin` never syncs" }] } }, rel),
    { state: "blocked", reason: "`access: admin` never syncs" }
  );
  assert.deepEqual(derivePushState({ items: { clean: [{ rel }] } }, rel), { state: "clean" });
  assert.equal(derivePushState({ items: {} }, rel), null);
  assert.equal(derivePushState(null, rel), null);
});

test("admin-tier tasks.md: edit still saves locally, badge is blocked (brain never hit)", () => {
  const repo = makeRepo("03-status", TASKS.replace("access: team", "access: admin"));
  const file = resolveTasksFile(repo);
  // tier resolves to admin (never syncs)
  assert.equal(readTasks(file).tier, "admin");
  // a local edit succeeds regardless of tier
  const content = readFileSync(file.abs, "utf8");
  const { content: next } = applyTaskEdit(content, "T-02", { status: "done" });
  writeFileSync(file.abs, next);
  assert.match(readFileSync(file.abs, "utf8"), /\| T-02 \| Findings report \| Riley \| done \|/);
  // status would classify it blocked → badge blocked, no push issued
  const badge = derivePushState(
    { items: { blocked: [{ rel: file.rel, reason: "`access: admin` never syncs" }] } },
    file.rel
  );
  assert.equal(badge.state, "blocked");
  rmSync(repo, { recursive: true, force: true });
});
