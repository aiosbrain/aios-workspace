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

// Direct unit-level regression for the exact scaffold-shipped placeholder, independent of the
// scaffold-+-walk above — pins the precise fixture that broke the staging smoke test, without
// the cost of shelling out to scaffold-project.sh.
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
