// C1 collector tests. Run after `npm run build:loop` (npm test builds first).
// Covers: current + legacy spine, daily/weekly window + kind filter, default-deny exclusion
// with admin retention, and both hours table shapes. Fixtures use content-dated rows + an
// injected `now` for deterministic windowing; deliverable mtimes are set explicitly.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../../dist/operator-loop/index.js";

const NOW = new Date("2026-03-31T12:00:00Z");
const IN_WINDOW = new Date("2026-03-29T00:00:00Z"); // within 7d and 1d? (1d from = 03-30) — weekly only

function ws(spine) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-loop-col-"));
  const names =
    spine === "legacy"
      ? { inbox: "01-intake", work: "02-deliverables", log: "03-status" }
      : { inbox: "1-inbox", work: "2-work", log: "3-log" };
  for (const d of Object.values(names)) mkdirSync(path.join(dir, d), { recursive: true });
  return { dir, names };
}

function write(dir, rel, content, mtime) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mtime) utimesSync(abs, mtime, mtime);
  return abs;
}

const dlog = (rows) =>
  "---\naccess: team\n---\n\n" +
  "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
  "|---|---|---|---|---|---|---|---|\n" +
  rows.map((r) => `| ${r} |`).join("\n") +
  "\n";

function seed(spine) {
  const { dir, names } = ws(spine);
  write(
    dir,
    `${names.log}/decision-log.md`,
    dlog([
      "1 | 2026-03-28 | Adopt X | r | alex | i | 2 | client",
      "2 | 2026-03-29 | Do Y | r | sam | i | 1 | team",
    ])
  );
  write(
    dir,
    `${names.log}/tasks.md`,
    "---\naccess: admin\n---\n\n| ID | Task | Assignee | Status | Sprint | Due |\n|---|---|---|---|---|---|\n| T1 | Build | alex | in_progress | W1 | 2026-03-30 |\n"
  );
  write(
    dir,
    `${names.log}/hours-log.md`,
    "---\naccess: team\n---\n\n| Member | Date | Activity | Hours | Tag |\n|---|---|---|---|---|\n| alex | 2026-03-29 | coding | 3.0 | engineering |\n"
  );
  write(dir, `${names.work}/d1.md`, "---\naccess: team\nstatus: review\nowner: alex\n---\n# Deliverable One\n", NOW);
  return { dir, names };
}

test("weekly collects decisions/tasks/hours/deliverables on the CURRENT spine", () => {
  const { dir } = seed("current");
  const m = collect({ root: dir, cadence: "weekly", now: NOW });
  const kinds = {};
  for (const s of m.signals) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  assert.equal(kinds.decision, 2);
  assert.equal(kinds.task, 1);
  assert.equal(kinds.hours, 1);
  assert.equal(kinds.deliverable, 1);
  // per-row audience drives decision tier: row 1 audience 'client' → external, row 2 → team
  const d1 = m.signals.find((s) => s.ref.row === "1");
  const d2 = m.signals.find((s) => s.ref.row === "2");
  assert.equal(d1.tier, "external");
  assert.equal(d2.tier, "team");
});

test("admin-tier signals are RETAINED in the manifest (not dropped like sync)", () => {
  const { dir } = seed("current");
  const m = collect({ root: dir, cadence: "weekly", now: NOW });
  const task = m.signals.find((s) => s.kind === "task");
  assert.ok(task, "task signal present");
  assert.equal(task.tier, "admin"); // tasks.md is access: admin — kept for the private brief
});

test("daily window is tighter AND excludes hours/inbox kinds (one collector, two configs)", () => {
  const { dir } = seed("current");
  const weekly = collect({ root: dir, cadence: "weekly", now: NOW });
  const daily = collect({ root: dir, cadence: "daily", now: NOW });
  // hours is a weekly-only kind
  assert.ok(weekly.signals.some((s) => s.kind === "hours"));
  assert.ok(!daily.signals.some((s) => s.kind === "hours"));
  // 03-28/03-29 decisions fall outside the 1-day daily window (from = 03-30)
  assert.ok(!daily.signals.some((s) => s.kind === "decision"));
  assert.ok(weekly.signals.some((s) => s.kind === "decision"));
  assert.ok(daily.signals.length < weekly.signals.length);
});

test("LEGACY spine (00/01/02/03) is resolved and collected", () => {
  const { dir } = seed("legacy");
  const m = collect({ root: dir, cadence: "weekly", now: NOW });
  const dec = m.signals.find((s) => s.kind === "decision");
  assert.ok(dec, "decision collected from legacy spine");
  assert.ok(dec.ref.path.startsWith("03-status/"), `legacy path, got ${dec.ref.path}`);
});

test("missing/unresolvable tier is excluded (default-deny) and logged", () => {
  const { dir, names } = seed("current");
  // inbox note with NO access frontmatter → excluded (inbox is a weekly kind)
  write(dir, `${names.inbox}/note.md`, "# raw note\nno frontmatter here\n", NOW);
  const m = collect({ root: dir, cadence: "weekly", now: NOW });
  assert.ok(
    m.excluded.some((e) => e.ref.includes("note.md") && /default-deny/.test(e.reason)),
    "unresolved-tier inbox note is in excluded[]"
  );
  assert.ok(!m.signals.some((s) => s.ref.path.includes("note.md")), "excluded note not in signals");
});

test("blank/invalid row date falls back to file mtime (no NaN window bypass)", () => {
  const { dir } = ws("current");
  // hours row with an EMPTY date cell — must not produce occurredAt=NaN (which would bypass
  // the window filter and always be included). Falls back to the file mtime instead.
  write(
    dir,
    "3-log/hours-log.md",
    "---\naccess: team\n---\n\n| Date | Activity | Hours | Tag |\n|---|---|---|---|\n|  | coding | 2.0 | engineering |\n",
    IN_WINDOW // file mtime within the weekly window
  );
  const m = collect({ root: dir, cadence: "weekly", now: NOW });
  const h = m.signals.find((s) => s.kind === "hours");
  assert.ok(h, "hours signal produced despite blank date");
  assert.ok(Number.isFinite(Date.parse(h.occurredAt)), "occurredAt is a valid date, not NaN");
  assert.equal(h.occurredAt, IN_WINDOW.toISOString(), "fell back to file mtime");

  // And a far-out-of-window mtime with a blank date is correctly EXCLUDED by the window.
  const old = new Date("2020-01-01T00:00:00Z");
  write(
    dir,
    "3-log/hours-log.md",
    "---\naccess: team\n---\n\n| Date | Activity | Hours | Tag |\n|---|---|---|---|\n|  | old work | 1.0 | admin |\n",
    old
  );
  const m2 = collect({ root: dir, cadence: "weekly", now: NOW });
  assert.ok(!m2.signals.some((s) => s.kind === "hours"), "blank-date row outside window is filtered out");
});

test("hours source supports BOTH header shapes", () => {
  for (const header of [
    "| Date | Activity | Hours | Tag | Task Ref |",
    "| Member | Date | Activity | Hours | Tag |",
  ]) {
    const { dir } = ws("current");
    const row =
      header.startsWith("| Date")
        ? "| 2026-03-29 | coding | 3.0 | engineering | T1 |"
        : "| alex | 2026-03-29 | coding | 3.0 | engineering |";
    write(
      dir,
      "3-log/hours-log.md",
      `---\naccess: team\n---\n\n${header}\n|---|---|---|---|---|\n${row}\n`
    );
    const m = collect({ root: dir, cadence: "weekly", now: NOW });
    const h = m.signals.find((s) => s.kind === "hours");
    assert.ok(h, `hours signal for header: ${header}`);
    assert.match(h.summary, /coding/);
    assert.match(h.summary, /3\.0h/);
    assert.match(h.summary, /engineering/);
    assert.equal(h.payload.tag, "engineering");
  }
});
