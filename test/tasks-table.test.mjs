#!/usr/bin/env node
// test/tasks-table.test.mjs — parser + writeback merge for the markdown task table,
// including the v1.2 optional Parent | Labels | Priority columns. Zero network, zero deps.
// Run: node test/tasks-table.test.mjs

import {
  parseTableRows,
  parseTaskRows,
  mergeTaskWriteback,
  planSyncOriginWriteback,
  syncOriginRowsFor,
} from "../scripts/tasks-table.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// ── parseTaskRows ─────────────────────────────────────────────────────────────
const SIX_COL = `
| ID | Task | Assignee | Status | Sprint | Due |
| --- | --- | --- | --- | --- | --- |
| T-01 | Do thing | alex | in_progress | sprint-1 | 2026-03-27 |
`;
const sixRows = parseTaskRows(SIX_COL);
check(
  "six-column parses row_key/title/status",
  sixRows.length === 1 && sixRows[0].row_key === "T-01" && sixRows[0].status === "in_progress"
);
check(
  "six-column emits NO hierarchy keys",
  !("parent" in sixRows[0]) && !("labels" in sixRows[0]) && !("priority" in sixRows[0])
);

const HIER = `
| ID | Task | Assignee | Status | Sprint | Due | Parent | Labels | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | Plane integration | john | done | Wave 1 |  |  | integration, wave-1 | high |
| P0.1 | Register MCP | john | done | Wave 1 |  | P0 | integration | high |
`;
const hierRows = parseTaskRows(HIER);
check("hierarchy parses parent", hierRows[1].parent === "P0");
check(
  "hierarchy parses labels as array",
  Array.isArray(hierRows[0].labels) &&
    hierRows[0].labels.length === 2 &&
    hierRows[0].labels[0] === "integration"
);
check("hierarchy parses priority", hierRows[0].priority === "high");
check("empty parent cell → null", hierRows[0].parent === null);

const escapedPipeRows = parseTableRows(String.raw`| k | odd \| pipe | team |
| k | even \\| private | team`);
check(
  "odd backslash escapes a pipe while even backslashes leave a delimiter",
  escapedPipeRows[0][1] === "odd | pipe" &&
    escapedPipeRows[0][2] === "team" &&
    escapedPipeRows[1][1] === "even \\" &&
    escapedPipeRows[1][2] === "private" &&
    escapedPipeRows[1][3] === "team"
);

// ── mergeTaskWriteback: six-column, no hierarchy edits ────────────────────────
const baseTable = `# Tasks

| ID | Task | Assignee | Status | Sprint | Due |
| --- | --- | --- | --- | --- | --- |
| T-01 | Old title | alex | backlog | s1 |  |
`;
const m1 = mergeTaskWriteback(baseTable, [
  {
    row_key: "T-01",
    title: "New title",
    assignee: "alex",
    status: "done",
    sprint: "s1",
    due: null,
  },
  { row_key: "T-02", title: "Fresh", assignee: "sam", status: "ready", sprint: "s2", due: null },
]);
check(
  "update in place (T-01 title changed)",
  /\| T-01 \| New title \|/.test(m1) && !/Old title/.test(m1)
);
check("append unknown row (T-02)", /\| T-02 \| Fresh \|/.test(m1));
check("stays six-column (no Parent header added)", !/Parent/.test(m1));

// ── mergeTaskWriteback: hierarchy fields upgrade the header in place ──────────
const m2 = mergeTaskWriteback(baseTable, [
  {
    row_key: "T-01",
    title: "Epic",
    assignee: "alex",
    status: "in_progress",
    sprint: "s1",
    due: null,
    parent: null,
    labels: ["frontend", "ui"],
    priority: "high",
  },
]);
check(
  "header upgraded with Parent|Labels|Priority",
  /\| ID \| Task \| Assignee \| Status \| Sprint \| Due \| Parent \| Labels \| Priority \|/.test(m2)
);
check(
  "separator row widened to 9 cols",
  (
    m2
      .split("\n")
      .find((l) => /^\|\s*---/.test(l))
      .match(/---/g) || []
  ).length === 9
);
check("labels comma-joined in cell", /\| frontend, ui \|/.test(m2));
check("priority written", /\| high \|/.test(m2));

// regression: brain writeback always includes the keys (parent null, labels [], priority "none")
// but with NO meaningful value → a six-column table must NOT be widened on pull.
const m2b = mergeTaskWriteback(baseTable, [
  {
    row_key: "T-01",
    title: "Still six",
    assignee: "alex",
    status: "done",
    sprint: "s1",
    due: null,
    parent: null,
    labels: [],
    priority: "none",
  },
]);
check(
  "empty hierarchy values do NOT widen six-column table",
  !/Parent/.test(m2b) && /\| T-01 \| Still six \|/.test(m2b)
);
const m2c = mergeTaskWriteback(baseTable, [
  {
    row_key: "T-01",
    title: "x",
    assignee: "",
    status: "done",
    sprint: "",
    due: null,
    parent: "",
    labels: [],
    priority: "",
  },
]);
check("blank-string hierarchy values do NOT widen", !/Parent/.test(m2c));

// existing untouched six-column rows get padded, not corrupted
const baseTwoRows = `| ID | Task | Assignee | Status | Sprint | Due |
| --- | --- | --- | --- | --- | --- |
| T-01 | A | a | done | s1 |  |
| T-09 | B | b | backlog | s1 |  |
`;
const m3 = mergeTaskWriteback(baseTwoRows, [
  {
    row_key: "T-01",
    title: "A",
    assignee: "a",
    status: "done",
    sprint: "s1",
    due: null,
    parent: null,
    labels: [],
    priority: "low",
  },
]);
const t09 = m3.split("\n").find((l) => l.startsWith("| T-09"));
check("untouched row padded to 9 cells", t09.split("|").slice(1, -1).length === 9);

// ── $-safety: title with $ does not break String.replace ─────────────────────
const m4 = mergeTaskWriteback(baseTable, [
  {
    row_key: "T-01",
    title: "Cost is $5 & $0.50",
    assignee: "",
    status: "done",
    sprint: "",
    due: null,
  },
]);
check("title with $ preserved literally", m4.includes("Cost is $5 & $0.50"));

// ── PM columns preserved when present ─────────────────────────────────────────
const pmTable = `| ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | x | a | backlog | s1 |  | plane:T-01 | http://x |
`;
const m5 = mergeTaskWriteback(pmTable, [
  {
    row_key: "T-01",
    title: "x",
    assignee: "a",
    status: "done",
    sprint: "s1",
    due: null,
    pm_provider: "plane",
    pm_external_id: "T-01",
    pm_url: "http://x",
  },
]);
check("PM cell rebuilt as provider:id", /\| plane:T-01 \| http:\/\/x \|/.test(m5));

// ── retired provider (plane) survives a parse → edit → merge round-trip ────────
// Plane is retired: parsePmCell no longer treats `plane:` as a live provider, but the raw cell
// must round-trip verbatim (history is kept, not blanked). Regression for the cockpit edit path.
const planeRows = parseTaskRows(pmTable);
check(
  "plane: cell parsed as pm_raw (not a live pm_provider)",
  planeRows[0].pm_raw === "plane:T-01"
);
check("retired plane: cell has no live pm_provider", planeRows[0].pm_provider === undefined);
const edited = { ...planeRows[0], status: "done" }; // simulate a light status edit
const m6 = mergeTaskWriteback(pmTable, [edited]);
check("plane:T-01 PM link survives a status edit", /\| plane:T-01 \| http:\/\/x \|/.test(m6));
check("the status edit still applied", /\| T-01 \| x \| a \| done \| s1 \|/.test(m6));

// ── sync-origin return leg (brain-api 1.13, AIO-537) ──────────────────────────
// The brain→Linear projection is one-way and the dashboard writeback feed is UI-origin only, so a
// row this workspace PUSHED could move to Done in Linear and never come back — `3-log/tasks-team.md`
// decayed (field audit: 6 rows read `todo` while Linear said Done/In Progress). These assert the
// merge semantics from docs/brain-api.md § sync-origin return leg, not the implementation.
const RETURN_TABLE = `
| ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | Ship the thing | alex | todo | sprint-1 | — | linear:AIO-1 | http://l/1 |
| T-02 | Review the thing | alex | In Progress | sprint-1 | — |  |  |
`;
const planned = (rows) => planSyncOriginWriteback(RETURN_TABLE, rows);

// 1. A REAL brain-side change overwrites an unknown local status (`todo`). The brain cleared
//    raw_status when Linear set the status authoritatively, which is what makes it real.
const real = planned([
  { row_key: "T-01", status: "done", assignee: "alex", raw_status: null },
]);
check("real brain status change is applied to an unknown local status", real.rows.length === 1);
check("…with the brain's status", real.rows[0]?.status === "done");
const realMerged = mergeTaskWriteback(RETURN_TABLE, real.rows);
check(
  "…and every other column survives verbatim (due `—`, PM cell, URL)",
  /\| T-01 \| Ship the thing \| alex \| done \| sprint-1 \| — \| linear:AIO-1 \| http:\/\/l\/1 \|/.test(
    realMerged
  )
);
check("…the untouched row is left alone", /\| T-02 \| Review the thing \| alex \| In Progress \|/.test(realMerged));

// 2. ECHO GUARD: a non-null raw_status proves NO authoritative writer has touched this row since
//    our push (the brain clears it on every authoritative status write) — so the brain's `backlog`
//    is only its normalization of the `todo` we pushed and must NOT clobber the author's status.
const echo = planned([
  { row_key: "T-01", status: "backlog", assignee: "alex", raw_status: "todo" },
]);
check("normalization echo (raw_status non-null) is skipped", echo.rows.length === 0);
check("…and reported as skipped", echo.skipped.includes("T-01"));

// 2b. STALE echo: the owner edited the cell after the push (todo → done) and pulls before pushing.
//     raw_status still reads `todo` and no longer equals the local cell — comparing the two would
//     revert the unpushed edit to `backlog`. Non-null raw_status alone must stop the write.
const staleEcho = planSyncOriginWriteback(
  RETURN_TABLE.replace("| alex | todo |", "| alex | done |"),
  [{ row_key: "T-01", status: "backlog", assignee: "alex", raw_status: "todo" }]
);
check("a stale echo never reverts a newer local status edit", staleEcho.rows.length === 0);

// 3. A formatting-only difference ("In Progress" vs in_progress) is not a change either.
const formatting = planned([
  { row_key: "T-02", status: "in_progress", assignee: "alex", raw_status: null },
]);
check("canonicalization-only difference is skipped", formatting.rows.length === 0);

// 4. Assignee rides along with a REAL status change only. The brain has no independent assignee
//    author for sync-origin rows, so on an otherwise-unchanged row its value is the echo of our own
//    last push — merging it would silently revert a local reassignment made before the next push.
const reassignedOnly = planned([
  { row_key: "T-02", status: "in_progress", assignee: "sam", raw_status: null },
]);
check(
  "an assignee-only difference never reverts a local reassignment",
  reassignedOnly.rows.length === 0
);
const movedAndReassigned = planned([
  { row_key: "T-02", status: "done", assignee: "sam", raw_status: null },
]);
check("a real status change carries the brain assignee too", movedAndReassigned.rows[0]?.assignee === "sam");
check("…with the new status", movedAndReassigned.rows[0]?.status === "done");
const blanked = planned([{ row_key: "T-02", status: "done", assignee: "", raw_status: null }]);
check("an empty brain assignee never blanks the local one", blanked.rows[0]?.assignee === "alex");

// 5. The return leg never CREATES a row: an unknown row_key is skipped, not appended (it would
//    resurrect a row the owner deliberately deleted).
const unknown = planned([{ row_key: "T-99", status: "done", assignee: "x", raw_status: null }]);
check("unknown row_key is not merged", unknown.rows.length === 0 && unknown.skipped.includes("T-99"));
check(
  "…and nothing is appended to the table",
  !/T-99/.test(mergeTaskWriteback(RETURN_TABLE, unknown.rows))
);

// 6. Feature detection: a pre-1.13 brain ignores `mode` and answers with the dashboard writeback
//    feed. Merging that as sync-origin would apply the wrong semantics, so only an echoed
//    `mode: "sync-origin"` counts — and only the caller's own project.
check(
  "a pre-1.13 (writeback) response yields no sync-origin rows",
  syncOriginRowsFor(
    { mode: "writeback", tasks: [{ project: "mine", rows: [{ row_key: "T-01", status: "done" }] }] },
    "mine"
  ).length === 0
);
check("a missing/404 response yields no rows", syncOriginRowsFor(null, "mine").length === 0);
const detected = syncOriginRowsFor(
  {
    mode: "sync-origin",
    tasks: [
      { project: "mine", rows: [{ row_key: "T-01", status: "done" }] },
      { project: "theirs", rows: [{ row_key: "Z-9", status: "done" }] },
    ],
  },
  "mine"
);
check("a 1.13 response yields only this project's rows", detected.length === 1 && detected[0].row_key === "T-01");

console.log(failed ? `\n${RED}${failed} failed${NC}` : `\n${GREEN}all passed${NC}`);
process.exit(failed ? 1 : 0);
