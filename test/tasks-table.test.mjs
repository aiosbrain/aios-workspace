#!/usr/bin/env node
// test/tasks-table.test.mjs — parser + writeback merge for the markdown task table,
// including the v1.2 optional Parent | Labels | Priority columns. Zero network, zero deps.
// Run: node test/tasks-table.test.mjs

import { parseTableRows, parseTaskRows, mergeTaskWriteback } from "../scripts/tasks-table.mjs";

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

console.log(failed ? `\n${RED}${failed} failed${NC}` : `\n${GREEN}all passed${NC}`);
process.exit(failed ? 1 : 0);
