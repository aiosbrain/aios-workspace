// test/decision-row-redaction.test.mjs — H3: non-syncable decision rows must never leave the
// machine on push, even when the decision-log file is team-tier. Covers the parsed-rows payload,
// the raw markdown body that aios push sends, and the fail-closed edges the release review found
// (blank/escaped row_key, blank audience → admin, adjacent-table boundary, separator rows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecisionRows, redactAdminDecisionRows } from "../scripts/workspace-parse.mjs";

const HEADER = `| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |`;
const SEP = `|---|------|----------|-----------|------------|--------|------|----------|`;
const table = (...dataLines) => ["## Decisions", "", HEADER, SEP, ...dataLines, ""].join("\n");

test("strips private+admin rows from rows and body; keeps team+external", () => {
  const body = table(
    `| 1 | 2026-07-01 | Adopt X | public | alex | high | 2 | team |`,
    `| 2 | 2026-07-02 | Severance terms | eyes-only | john | high | 3 | private |`,
    `| 3 | 2026-07-03 | Ship V1 | go | sam | high | 2 | external |`,
    `| 4 | 2026-07-04 | Personnel note | admin detail | john | low | 3 | admin |`
  );
  const out = redactAdminDecisionRows(body);
  assert.equal(out.redacted, 2);
  assert.deepEqual(
    out.rows.map((r) => r.row_key),
    ["1", "3"]
  );
  assert.ok(!/Severance terms/.test(out.body) && !/eyes-only/.test(out.body));
  assert.ok(!/admin detail/.test(out.body));
  assert.ok(/Adopt X/.test(out.body) && /Ship V1/.test(out.body));
  assert.ok(out.body.includes(HEADER) && out.body.includes(SEP), "header + separator kept");
});

test("fail closed: capitalized `Private`, unknown, and BLANK audience are all dropped", () => {
  const body = table(
    `| 1 | d | Public | ok | a | h | 2 | team |`,
    `| 2 | d | Capitalized secret | hush | j | h | 3 | Private |`,
    `| 3 | d | Unknown-audience secret | hush | j | h | 3 | wat |`,
    `| 4 | d | Blank-audience secret | hush | j | h | 3 |  |`
  );
  const out = redactAdminDecisionRows(body);
  assert.deepEqual(
    out.rows.map((r) => r.row_key),
    ["1"],
    "blank audience → admin (V1 policy): only explicit team survives"
  );
  for (const s of ["Capitalized secret", "Unknown-audience secret", "Blank-audience secret"]) {
    assert.ok(!out.body.includes(s), `${s} removed from body`);
  }
  assert.equal(out.redacted, 3);
});

test("blank/malformed row_key private row cannot leak in the body (Fable #2)", () => {
  const body = table(
    `| 1 | d | Public | ok | a | h | 2 | team |`,
    `|  | d | SECRET-blank-key | hush | j | h | 3 | private |`
  );
  const out = redactAdminDecisionRows(body);
  assert.ok(!out.body.includes("SECRET-blank-key"), "blank-# private line removed from body");
  assert.deepEqual(
    out.rows.map((r) => r.row_key),
    ["1"]
  );
});

test("escaped pipe in a cell does not misparse Audience, and a private escaped-key row cannot leak", () => {
  // A team row whose rationale contains an escaped \\| must survive.
  const okBody = table(`| 1 | d | Ship it | costs \\| benefits | a | h | 2 | team |`);
  const ok = redactAdminDecisionRows(okBody);
  assert.equal(ok.redacted, 0);
  assert.deepEqual(
    ok.rows.map((r) => r.row_key),
    ["1"]
  );
  // A private row whose # cell contains an escaped pipe must NOT leave its line in the body.
  const leakBody = table(`| a\\|b | d | SECRET-escaped-key | hush | j | h | 3 | private |`);
  const leak = redactAdminDecisionRows(leakBody);
  assert.ok(!leak.body.includes("SECRET-escaped-key"), "escaped-key private line removed");
  assert.equal(leak.rows.length, 0);
});

test("adjacent non-decision table is NOT over-redacted", () => {
  const body = [
    HEADER,
    SEP,
    `| 1 | d | Adopt X | ok | a | h | 2 | team |`,
    `| 2 | d | Secret | hush | j | h | 3 | private |`,
    "",
    "| Name | Role |",
    "|------|------|",
    "| Alex | Eng |",
    "| 2 | Ops |",
  ].join("\n");
  const out = redactAdminDecisionRows(body);
  assert.ok(!out.body.includes("Secret"), "private decision row dropped");
  assert.ok(/\| Alex \| Eng \|/.test(out.body), "unrelated table row kept");
  assert.ok(
    /\| 2 \| Ops \|/.test(out.body),
    "unrelated row whose # collides with a dropped key kept"
  );
});

test("separator-less decision table still fails closed (no leak)", () => {
  // A decision table whose separator row was hand-deleted must NOT pass private lines through.
  const body = [
    "## Decisions",
    "",
    HEADER,
    `| 1 | d | Public | ok | a | h | 2 | team |`,
    `| 2 | d | SECRET-nosep | hush | j | h | 3 | private |`,
    "",
  ].join("\n");
  const out = redactAdminDecisionRows(body);
  assert.ok(
    !out.body.includes("SECRET-nosep"),
    "private line dropped even without a separator row"
  );
  assert.deepEqual(
    out.rows.map((r) => r.row_key),
    ["1"]
  );
});

test("table butted directly after the decision table (no blank line) is NOT over-redacted", () => {
  const body = [
    HEADER,
    SEP,
    `| 1 | d | Adopt X | ok | a | h | 2 | team |`,
    `| 2 | d | Secret | hush | j | h | 3 | private |`,
    "| Name | Role |", // no blank line before this second table
    "|------|------|",
    "| Alex | Eng |",
  ].join("\n");
  const out = redactAdminDecisionRows(body);
  assert.ok(!out.body.includes("Secret"), "private decision row still dropped");
  assert.ok(/\| Name \| Role \|/.test(out.body), "butted table header kept");
  assert.ok(/\| Alex \| Eng \|/.test(out.body), "butted table data row kept");
});

test("blank lines cannot let later private decision rows escape body redaction", () => {
  const body = `| # | Decision | Audience |
|---|---|---|
| 1 | Team row | team |

| 2 | Payroll detail | private |

| Metric | Value |
|---|---|
| latency | fast |
`;
  const out = redactAdminDecisionRows(body);

  assert.equal(out.redacted, 1);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1"]
  );
  assert.doesNotMatch(out.body, /Payroll detail/);
  assert.match(out.body, /\| latency \| fast \|/);
});

test("a private continuation row cannot masquerade as a header before a separator", () => {
  const body = `| # | Decision | Audience |
|---|---|---|
| 1 | Team row | team |
| 2 | Payroll detail | private |
|---|---|---|
| 3 | Personnel detail | admin |
`;
  const out = redactAdminDecisionRows(body);

  assert.equal(out.redacted, 2);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1"]
  );
  assert.doesNotMatch(out.body, /Payroll detail|Personnel detail/);
});

test("separator-backed headers cannot leave stale audience indexes active", () => {
  const reordered = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Team row | ok | team |
| # | Audience | Decision | Owner |
|---|---|---|---|
| 2 | private | Confidential row | team |
`;
  const ambiguous = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Team row | ok | team |
| # | Visibility | Subject | Owner |
|---|---|---|---|
| 2 | private | Confidential row | team |
`;

  for (const body of [reordered, ambiguous]) {
    const out = redactAdminDecisionRows(body);
    assert.deepEqual(
      out.rows.map((row) => row.row_key),
      ["1"]
    );
    assert.doesNotMatch(out.body, /Confidential row/);
  }
});

test("syncable data rows survive stray separators, including header-named titles", () => {
  for (const title of ["Team row", "Decision", "Audience"]) {
    const body = `| # | Decision | Audience |
|---|---|---|
| 1 | ${title} | team |
|---|---|---|
| 2 | Private row | private |
`;
    const out = redactAdminDecisionRows(body);

    assert.deepEqual(
      out.rows.map((row) => row.row_key),
      ["1"]
    );
    assert.match(out.body, new RegExp(`\\| 1 \\| ${title} \\| team \\|`));
    assert.doesNotMatch(out.body, /Private row/);
  }
});

test("optional leading pipes are recognized and even slash parity cannot hide a delimiter", () => {
  const noLeadingPipes = `# | Decision | Audience
---|---|---
1 | Team row | team
2 | Confidential row | private
`;
  const evenSlashRun = String.raw`| # | Decision | Audience |
|---|---|---|
| 1 | Team row | team |
| 2 | Restricted detail \\| private | team |
`;

  for (const body of [noLeadingPipes, evenSlashRun]) {
    const out = redactAdminDecisionRows(body);
    assert.deepEqual(
      out.rows.map((row) => row.row_key),
      ["1"]
    );
    assert.doesNotMatch(out.body, /Confidential row|Restricted detail/);
  }
});

test("legacy tables without Audience inherit an explicit file tier only", () => {
  const body = `| # | Decision |
|---|---|
| 1 | Legacy row |
`;

  assert.deepEqual(redactAdminDecisionRows(body).rows, [], "no fallback remains default-deny");
  for (const tier of ["team", "external"]) {
    const out = redactAdminDecisionRows(body, tier);
    assert.deepEqual(
      out.rows.map((row) => row.row_key),
      ["1"]
    );
    assert.match(out.body, /Legacy row/);
  }
  assert.deepEqual(redactAdminDecisionRows(body, "admin").rows, []);
});

test("no-op body + rows when every row is syncable", () => {
  const body = table(`| 1 | d | Public | ok | a | h | 2 | team |`);
  const out = redactAdminDecisionRows(body);
  assert.equal(out.redacted, 0);
  assert.equal(out.rows.length, 1);
});

test("parseDecisionRows returns all rows (kept and dropped) with the expected shape", () => {
  const body = table(
    `| 1 | 2026-07-01 | Adopt X | why | alex | high | 2 | team |`,
    `| 2 | 2026-07-02 | Secret | hush | john | high | 3 | private |`
  );
  const rows = parseDecisionRows(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].audience, "team");
  assert.equal(rows[1].audience, "admin"); // normalizeTier(private) → admin
  assert.equal(rows[0].title, "Adopt X");
});
