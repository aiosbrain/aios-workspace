import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDecisionRows, redactAdminDecisionRows } from "../scripts/workspace-parse.mjs";

const BODY = `## Decisions

| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
| 1 | 2026-07-01 | Adopt X | public rationale | alex | high | 2 | team |
| 2 | 2026-07-02 | Severance terms | eyes-only rationale | john | high | 3 | private |
| 3 | 2026-07-03 | Ship V1 | go | sam | high | 2 | external |
| 4 | 2026-07-04 | Personnel note | admin-only detail | john | low | 3 | admin |
`;

test("redaction removes private/admin rows from parsed rows and markdown body", () => {
  const out = redactAdminDecisionRows(BODY);

  assert.equal(out.redacted, 2);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1", "3"]
  );
  assert.doesNotMatch(out.body, /Severance terms|eyes-only rationale|admin-only detail/);
  assert.match(out.body, /Adopt X/);
  assert.match(out.body, /Ship V1/);
  assert.match(out.body, /\| # \| Date \| Decision \|/);
});

test("redaction fails closed on case variants, unknown values, and missing audiences", () => {
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Team row | ok | TEAM |
| 2 | Case-private row | secret | Private |
| 3 | Unknown row | secret | partners |
| 4 | Blank row | secret | |
| 5 | External row | ok | External |
`;
  const out = redactAdminDecisionRows(body);

  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1", "5"]
  );
  assert.doesNotMatch(out.body, /Case-private row|Unknown row|Blank row/);
  assert.match(out.body, /Team row/);
  assert.match(out.body, /External row/);
});

test("keeps the markdown separator row so the synced table still renders", () => {
  const body = `| # | Decision | Rationale | Audience |
|---|:---:|---|---|
| 1 | Team row | ok | team |
| 2 | Private row | secret | private |
`;
  const out = redactAdminDecisionRows(body);
  // The delimiter row carries no audience but must survive redaction, or the table breaks.
  assert.match(out.body, /^\|---\|:---:\|---\|---\|$/m);
  assert.match(out.body, /Team row/);
  assert.doesNotMatch(out.body, /Private row/);
});

test("a decision titled Decision is treated as data, not a new table header", () => {
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Decision | private detail | private |
| # | Decision | Rationale | Audience |
| 2 | Keep | ok | team |
`;
  const out = redactAdminDecisionRows(body);

  assert.doesNotMatch(out.body, /private detail/);
  assert.match(out.body, /\| 2 \| Keep \| ok \| team \|/);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["2"]
  );
});

test("a private Decision row keyed # cannot masquerade as a legacy header", () => {
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Keep | ok | team |
| # | Decision | payroll detail | private |
|---|---|---|---|
| # | Decision | Rationale | Audience |
| 2 | Keep two | ok | team |
`;
  const out = redactAdminDecisionRows(body);

  assert.doesNotMatch(out.body, /payroll detail/);
  assert.match(out.body, /Keep two/);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1", "2"]
  );
});

test("each decision table uses its own column indexes", () => {
  const body = `| Decision | Custom | Audience
| Keep | safe | team
| Decision | Other | Team
| PayrollSecret | private detail | team
| Audience | Decision | Rationale
| private | Confidential row | private rationale
  `;
  const parsed = parseDecisionRows(body);
  assert.equal(parsed[1].audience, null);
  assert.equal(parsed[2].audience, "admin");

  const out = redactAdminDecisionRows(body);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].row_key, "Keep");
  assert.doesNotMatch(out.body, /PayrollSecret|Confidential row|private rationale/);
});

test("ambiguous decision tables and malformed rows fail closed", () => {
  const duplicateAudience = `| # | Decision | Audience | Audience |
|---|---|---|---|
| 1 | Confidential | team | private |
`;
  const extraCell = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 2 | Confidential | detail | team | private |
`;
  const missingDecision = `| # | Rationale | Audience |
|---|---|---|
| 3 | confidential detail | private |
`;
  const shortRowFollowedBySeparator = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 4 | Payroll termination | secret reason |
|---|---|---|
`;
  const privateRowMasqueradingAsHeader = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| custom | Payroll | Secret | private |
|---|---|---|---|
| value | more | data | here |
`;
  const unknownRowMasqueradingAsHeader = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| custom | Payroll | Secret | partners |
|---|---|---|---|
| value | more | data | here |
`;

  for (const body of [
    duplicateAudience,
    extraCell,
    missingDecision,
    shortRowFollowedBySeparator,
    privateRowMasqueradingAsHeader,
    unknownRowMasqueradingAsHeader,
  ]) {
    const out = redactAdminDecisionRows(body);
    assert.deepEqual(out.rows, []);
    assert.doesNotMatch(out.body, /Confidential|confidential detail|Payroll|secret reason/);
  }
});

test("a blank Audience cell is private while a missing Audience column stays distinguishable", () => {
  const blank = `| # | Decision | Audience |
|---|---|---|
| 1 | Confidential | |
`;
  const missing = `| # | Decision |
|---|---|
| 2 | Legacy row |
`;

  assert.equal(parseDecisionRows(blank)[0].audience, "admin");
  assert.equal(parseDecisionRows(missing)[0].audience, null);
  assert.deepEqual(redactAdminDecisionRows(blank).rows, []);
  assert.deepEqual(redactAdminDecisionRows(missing).rows, []);
});

test("a second table after a clear boundary is not redacted with a stale audience column", () => {
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Team row | ok | team |
| 2 | Private row | secret | private |

| Metric | Value | Unit | Trend |
|---|---|---|---|
| latency | fast | ms | down |
| notes | internal only | text | stable |
`;
  const out = redactAdminDecisionRows(body);
  // The private decision row is dropped, but the whole second table survives intact.
  assert.doesNotMatch(out.body, /Private row/);
  assert.match(out.body, /\| Metric \| Value \| Unit \| Trend \|/);
  assert.match(out.body, /latency/);
  assert.match(out.body, /notes/);
  assert.match(out.body, /internal only/);
});

test("ambiguous pipe content remains default-denied until a clear table boundary", () => {
  const body = `| # | Decision | Audience |
|---|---|---|
| 1 | Team row | team |
| latency | fast | ms |
| notes | internal only | n/a |
`;
  const out = redactAdminDecisionRows(body);

  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1"]
  );
  assert.doesNotMatch(out.body, /latency|internal only/);
});

test("an arbitrary row key cannot escape explicit private redaction", () => {
  const body = `| # | Decision | Audience |
|---|---|---|
| custom-key | Confidential | private |
| notes | public appendix | n/a |
`;
  const out = redactAdminDecisionRows(body);

  assert.doesNotMatch(out.body, /Confidential/);
  assert.doesNotMatch(out.body, /public appendix/);
});

test("legacy decision tables without a separator row are still redacted", () => {
  const body = `| Decision | Audience |
| Team row | team |
| Private row | private |
`;
  const out = redactAdminDecisionRows(body);

  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["Team row"]
  );
  assert.match(out.body, /Team row/);
  assert.doesNotMatch(out.body, /Private row/);

  for (const missingAudience of [
    `| Decision |\n| Private row |\n`,
    `| Date | Decision\n| 2026-01-01 | Private row\n`,
    `| Decision | Custom | Audience |\n| Private row | Secret | private |\n`,
    `| Decision | Custom | Audience\n| Private row | Secret | partners\n`,
  ]) {
    const missingOut = redactAdminDecisionRows(missingAudience);
    assert.deepEqual(missingOut.rows, []);
    assert.doesNotMatch(missingOut.body, /Private row/);
  }
});

test("escaped markdown pipes do not shift the Audience column", () => {
  const body = `| # | Decision | Rationale | Type | Audience |
|---|---|---|---|---|
| 1 | Keep this | option A \\| option B | 2 | team |
| 2 | Drop this | private A \\| private B | 3 | private |
`;
  const rows = parseDecisionRows(body);
  assert.equal(rows[0].rationale, "option A | option B");
  assert.equal(rows[0].audience, "team");
  assert.equal(rows[1].audience, "admin");

  const out = redactAdminDecisionRows(body);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1"]
  );
  assert.match(out.body, /Keep this/);
  assert.doesNotMatch(out.body, /Drop this|private A/);
});

test("an even backslash run cannot hide an extra private cell", () => {
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Confidential | payroll \\\\| private | team |
|---|---|---|---|---|
`;
  const out = redactAdminDecisionRows(body);

  assert.deepEqual(out.rows, []);
  assert.doesNotMatch(out.body, /Confidential|payroll|private/);
});
