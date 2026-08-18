// AIO-524 — regression guard: every sample item a freshly scaffolded workspace ships must be
// pushable on the very first `aios push`, in ALL THREE contexts (consultant/employee/
// business-owner).
//
// Discovery (staging smoke, pre Jul 29 demo — see AIO-483's discovery note): a throwaway
// consultant workspace's first push landed 9/10 items; the failure was a date-parsing
// rejection. Root cause: `scripts/scaffold-project.sh` seeds the example team task row
// (3-log/tasks-team.md) with `—` (em dash, the workspace-wide "no value" sentinel used in
// every scaffolded markdown table) in the `Due` column. `parseTaskRows` (scripts/tasks-table.mjs)
// treated any non-empty cell as a literal value, so the em dash round-tripped into
// `rows[].due = "—"` — which the Team Brain writes straight into a Postgres `date` column
// (`tasks.due_date date` / `decisions.decided_at date` in aios-team-brain's postgres/schema.sql)
// and 500s with "invalid input syntax for type date". `validateItemPayload` and the vendored
// 1.12 JSON Schema both accept ANY string for `due`/`decided_at` (no `pattern`, unlike
// `occurred_at`) — so this class of bug is invisible to the wire-contract parity suite
// (test/item-payload-schema-parity.test.mjs) and needs its own guard here, encoding the
// stricter shape the Brain's Postgres schema actually requires: `due`/`decided_at` must be
// null or a real (year-first) date-shaped string, never a placeholder character.
//
// parseFactRows/parseStakeholderMentionRows already normalized `—` to `undefined` for their
// own date-ish field (`occurred_at`) — parseTaskRows and the decision-row parser (both in
// scripts/tasks-table.mjs / scripts/workspace-parse.mjs) did not, which is exactly the drift
// this test exists to catch across every context and every syncable file, not just the one
// row that happened to trigger the staging smoke failure.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFrontmatter,
  classifyKind,
  normalizeTier,
  validateItemPayload,
  parseDecisionRows,
  parseEvidenceRows,
  evidencePayloadContent,
} from "../scripts/workspace-parse.mjs";
import { parseTaskRows } from "../scripts/tasks-table.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

// A `due`/`decided_at` value the Brain will actually accept into its Postgres `date` column:
// null (never sent, or explicitly empty), or a year-first date string. The wire contract itself
// only bounds length (docs/contract/item-payload-1.12.schema.json has no `pattern` on either
// field) — this is deliberately STRICTER than the contract, matching what the DB column enforces.
const DATE_SHAPED_OR_NULL = /^\d{4}-\d{2}-\d{2}/;

function isDbSafeDate(value) {
  return value == null || DATE_SHAPED_OR_NULL.test(value);
}

function scaffold(context, output) {
  execFileSync(
    "bash",
    [
      SCAFFOLD_SCRIPT,
      "--context",
      context,
      "--slug",
      "test-ws",
      "--stakeholder",
      "Acme",
      "--owner",
      "tester",
      "--team",
      "alex,sam",
      "--output",
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function tmpOut(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); // scaffold refuses a non-empty existing dir
  return output;
}

const SKIP_DIRS = new Set([".git", "node_modules", "5-personal", "6-business"]);

// Walk every candidate syncable file in the scaffolded workspace exactly like buildPlan
// (scripts/aios.mjs) does — skip admin/no-access files, classify kind, parse rows — without
// needing buildPlan itself exported: same helpers, same order of operations.
function collectPushItems(repo) {
  const items = [];
  const visit = (absDir, relDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(absDir, entry.name), path.posix.join(relDir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const rel = path.posix.join(relDir, entry.name);
      const abs = path.join(absDir, entry.name);
      const raw = readFileSync(abs, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      if (!frontmatter || !frontmatter.access) continue; // default-deny
      const tier = normalizeTier(frontmatter.access);
      if (tier === "admin") continue; // never syncs
      const kind = classifyKind(rel, frontmatter);

      let rows;
      let pushFrontmatter = frontmatter;
      let pushBody = body;
      if (kind === "task") rows = parseTaskRows(body);
      else if (kind === "decision") rows = parseDecisionRows(body);
      else if (kind === "fact" || kind === "stakeholder_mention") {
        rows = parseEvidenceRows(kind, body);
        ({ frontmatter: pushFrontmatter, body: pushBody } = evidencePayloadContent(
          kind,
          frontmatter,
          body
        ));
      }
      items.push({ rel, kind, tier, frontmatter: pushFrontmatter, body: pushBody, rows });
    }
  };
  visit(repo, "");
  return items;
}

for (const context of ["consultant", "employee", "business-owner"]) {
  test(`scaffold --context ${context}: every sample item pushes clean (payload + AIO-524 date shape)`, () => {
    const output = tmpOut(`scaffold-push-${context}-`);
    try {
      scaffold(context, output);
      const items = collectPushItems(output);
      assert.ok(items.length > 0, "expected at least one syncable sample item");

      const taskAndDecisionItems = items.filter(
        (item) => item.kind === "task" || item.kind === "decision"
      );
      assert.ok(
        taskAndDecisionItems.length > 0,
        "expected at least one task/decision file in a fresh scaffold"
      );

      for (const item of items) {
        const payload = {
          project: "test-ws",
          path: item.rel,
          kind: item.kind,
          content_sha256: "a".repeat(64), // shape-only; not exercising the sha itself here
          actor: "tester",
          access: item.tier,
          frontmatter: item.frontmatter || {},
          body: item.body,
        };
        if (item.rows) payload.rows = item.rows;
        const verdict = validateItemPayload(payload);
        assert.equal(
          verdict.success,
          true,
          `${item.rel} (${item.kind}) failed local Brain API 1.12 payload validation`
        );

        if (item.kind !== "task" && item.kind !== "decision") continue;
        const field = item.kind === "task" ? "due" : "decided_at";
        for (const row of item.rows || []) {
          assert.ok(
            isDbSafeDate(row[field]),
            `${item.rel}: row ${JSON.stringify(row.row_key)} has a non-date-shaped ` +
              `${field} (${JSON.stringify(row[field])}) — the Team Brain writes this straight ` +
              `into a Postgres \`date\` column and will reject anything that isn't null or ` +
              `year-first (AIO-524: a literal \`—\` placeholder previously slipped through)`
          );
        }
      }
    } finally {
      rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
}

// SAMPLEROW-1 — a freshly scaffolded workspace must ship NO task rows.
//
// Every row in `3-log/tasks-team.md` syncs to the Team Brain, and the brain projects each one into
// the team's connected PM tool (Linear/Plane) with no status or audience filter. So a shipped sample
// row is not inert — it is a work item on a real board. Until aios-team-brain#588 it was worse than
// that: the brain resolved an existing issue by the footer `aios-ext: <row_key>` alone, and this
// row's key is `TT1` in every workspace, so a fresh scaffold's sample row ADOPTED whoever already
// had an issue keyed `TT1`. Two projects in the AIOS install did that to the same real issue and
// renamed it "Example team task". #588 closed the adoption path, which leaves creation: without this
// guard every new workspace mints a junk issue on its board.
//
// TWO ASSERTIONS, AND BOTH ARE LOAD-BEARING:
//   • the plan CONTAINS `3-log/tasks-team.md` — without this, `rows=0` is asserted over an empty set
//     and the guard passes for a scaffold that LOST its task surface (rename the emitted file, or
//     break task classification, and the mutant survives). The pre-existing assertion one level up
//     (`at least one task/decision file`) does not close this: `decision-log.md` satisfies it alone.
//   • that line reports `rows=0`.
//
// AND IT ASSERTS AGAINST THE REAL PLANNER, not `collectPushItems` above. That helper walks all
// markdown minus a hardcoded skip list; what actually leaves the machine is `buildPlan` over
// `aios.yaml` `sync_include` (scripts/sync-plan.mjs). They disagree in both directions — drop the
// file from `sync_include` and a walker-based guard stays green while nothing syncs; add a team-tier
// task-shaped file outside it and the guard fails for a file that can never reach a board.
function pushPlanLines(repo) {
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts", "aios.mjs"), "push", "--dry-run"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return stdout.split("\n");
}

for (const context of ["consultant", "employee", "business-owner"]) {
  test(`scaffold --context ${context}: ships ZERO projectable task rows (SAMPLEROW-1)`, () => {
    const output = tmpOut(`scaffold-norows-${context}-`);
    try {
      scaffold(context, output);
      const lines = pushPlanLines(output);

      const teamTaskLines = lines.filter((l) => l.includes("3-log/tasks-team.md"));
      assert.equal(
        teamTaskLines.length,
        1,
        `expected the push plan to list 3-log/tasks-team.md exactly once — if it is absent, this ` +
          `guard's rows=0 assertion below would pass vacuously over an empty set. Plan was:\n${lines.join("\n")}`
      );
      const rowCount = /\brows=(\d+)\b/.exec(teamTaskLines[0]);
      assert.ok(rowCount, `no rows= count in plan line: ${teamTaskLines[0]}`);
      assert.equal(
        rowCount[1],
        "0",
        `a freshly scaffolded workspace must ship NO task rows — every row here becomes a real ` +
          `issue on the team's PM board on the first push (SAMPLEROW-1). Plan line: ${teamTaskLines[0]}`
      );

      // The table SHAPE survives, even though the rows are gone. `rows=0` cannot see this: item
      // classification is path/frontmatter-based, so deleting the header and separator outright
      // still plans as `[task, team] rows=0` and every other assertion here stays green (verified
      // by mutation — round-3 review found this surviving mutant). The header is load-bearing:
      // `mergeTaskWriteback` (packages/foundation/src/tasks-table.mjs:311-333) falls back to a
      // LEGACY SIX-COLUMN append when it finds no `id`/`task` header, silently dropping the
      // `Linear` column from written-back rows — and its own comment justifies that branch with
      // "the scaffold always ships one". This is that guarantee, asserted.
      const emitted = readFileSync(path.join(output, "3-log", "tasks-team.md"), "utf8");
      assert.match(
        emitted,
        /^\| ID \| Task \| Assignee \| Status \| Sprint \| Due \| Linear \|$/m,
        "the scaffolded team task table must keep its 7-column header — writeback degrades to a " +
          "six-column legacy append without it, dropping the Linear column"
      );
      assert.match(
        emitted,
        /^\|-+\|-+\|-+\|-+\|-+\|-+\|-+\|$/m,
        "the scaffolded team task table must keep its separator row"
      );

      // The private sibling must not appear in the plan AT ALL — neither pushed nor held.
      //
      // "Not pushed as a task" was too weak (round-2 review): add `3-log/tasks-private.md` to the
      // scaffolded `sync_include` and, because its frontmatter stays `access: private` (→ `admin`),
      // buildPlan HOLDS it (scripts/sync-plan.mjs:167). It then appears in the held list with no
      // `[task` marker, so a "not pushed" assertion passes while the file has in fact been added to
      // `sync_include` — which is the thing AIO-364 says never to do. Assert the absence of any
      // mention, and assert the generated `sync_include` directly, so neither half can drift.
      assert.equal(
        lines.filter((l) => l.includes("tasks-private")).length,
        0,
        `3-log/tasks-private.md must appear nowhere in the push plan — pushed OR held (AIO-364). ` +
          `Plan was:\n${lines.join("\n")}`
      );
      // Read the generated sync_include list itself: the scaffolded aios.yaml also *mentions*
      // tasks-private.md in a comment saying never to add it, so grepping the file would match that
      // comment. Take only the indented list items under `sync_include:`.
      const yaml = readFileSync(path.join(output, "aios.yaml"), "utf8").split("\n");
      const start = yaml.findIndex((l) => l.startsWith("sync_include:"));
      assert.ok(start >= 0, "generated aios.yaml has no sync_include block");
      const syncInclude = [];
      for (const line of yaml.slice(start + 1)) {
        // Blank lines and comments sit INSIDE the block in the shipped template, so stopping at the
        // first non-list line would end the walk early and miss every entry after them (round-3
        // review). Only a non-list, non-comment, non-blank line — i.e. the next top-level key —
        // ends the block.
        if (/^\s*(#.*)?$/.test(line)) continue;
        const item = /^\s+-\s*(.+?)\s*$/.exec(line);
        if (!item) break;
        syncInclude.push(item[1]);
      }
      assert.ok(
        syncInclude.includes("3-log/tasks-team.md"),
        `sync_include parsed wrong: ${syncInclude}`
      );
      assert.deepEqual(
        syncInclude.filter((p) => p.includes("tasks-private")),
        [],
        "3-log/tasks-private.md must never be added to the generated sync_include (AIO-364)"
      );
    } finally {
      rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
}

// Direct unit-level regression for the exact scaffold-shipped placeholder, independent of the
// scaffold-+-walk above — pins the precise fixture that broke the staging smoke test, without
// the cost of shelling out to scaffold-project.sh.
//
// SAMPLEROW-1 note: this is now the ONLY guard on `parseTaskRows`' em-dash handling. The per-context
// walk above no longer iterates any scaffolded task rows (the table ships empty by design), and it
// never iterated decision rows either — a fresh `decision-log.md` ships zero data rows too. So the
// fixture below is load-bearing, not a convenience copy of a case the walk also covers.
test("a '—' placeholder cell normalizes to null for both due (task) and decided_at (decision)", () => {
  const taskRows = parseTaskRows(
    [
      "| ID | Task | Assignee | Status | Sprint | Due | Linear |",
      "|----|------|----------|--------|--------|-----|--------|",
      "| TT1 | Example team task | alex | Todo | — | — | — |",
    ].join("\n")
  );
  assert.equal(taskRows.length, 1);
  assert.equal(taskRows[0].due, null);

  const decisionRows = parseDecisionRows(
    [
      "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |",
      "|---|------|----------|-----------|------------|--------|------|----------|",
      "| 1 | — | Went with X | because | alex | high | 1 | team |",
    ].join("\n")
  );
  assert.equal(decisionRows.length, 1);
  assert.equal(decisionRows[0].decided_at, null);
});
