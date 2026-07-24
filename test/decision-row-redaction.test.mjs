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
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Keep | safe | team |
| # | Audience | Decision | Rationale |
|---|---|---|---|
| 2 | private | Confidential row | private rationale |
`;
  const parsed = parseDecisionRows(body);
  assert.equal(parsed[1].title, "Confidential row");
  assert.equal(parsed[1].audience, "admin");

  const out = redactAdminDecisionRows(body);
  assert.deepEqual(
    out.rows.map((row) => row.row_key),
    ["1"]
  );
  assert.doesNotMatch(out.body, /Confidential row|private rationale/);
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

  for (const body of [duplicateAudience, extraCell, missingDecision]) {
    const out = redactAdminDecisionRows(body);
    assert.deepEqual(out.rows, []);
    assert.doesNotMatch(out.body, /Confidential|confidential detail/);
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

test("a second table butted against the decision table is not redacted with a stale audience column", () => {
  // No blank line between the decision table and the following table — the decision table must
  // end at its last data row, or the second table's rows get dropped against a stale audienceIdx.
  const body = `| # | Decision | Rationale | Audience |
|---|---|---|---|
| 1 | Team row | ok | team |
| 2 | Private row | secret | private |
| Metric | Value |
|---|---|
| latency | fast |
| notes | internal only |
`;
  const out = redactAdminDecisionRows(body);
  // The private decision row is dropped, but the whole second table survives intact.
  assert.doesNotMatch(out.body, /Private row/);
  assert.match(out.body, /\| Metric \| Value \|/);
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
