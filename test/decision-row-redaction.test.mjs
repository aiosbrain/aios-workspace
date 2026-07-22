// test/decision-row-redaction.test.mjs — H3: admin/private-audience decision rows must never
// leave the machine on push, even when the decision-log file is team-tier. Covers both the
// parsed-rows payload and the raw markdown body that aios push sends to the brain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecisionRows, redactAdminDecisionRows } from "../scripts/workspace-parse.mjs";

const BODY = `## Decisions

| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
| 1 | 2026-07-01 | Adopt X | public rationale | alex | high | 2 | team |
| 2 | 2026-07-02 | Severance terms for B | eyes-only rationale | john | high | 3 | private |
| 3 | 2026-07-03 | Ship V1 | go | sam | high | 2 | external |
| 4 | 2026-07-04 | Personnel note | admin-only detail | john | low | 3 | admin |
`;

test("redactAdminDecisionRows strips private+admin rows from rows and body", () => {
  const rows = parseDecisionRows(BODY);
  const out = redactAdminDecisionRows(BODY, rows);

  assert.equal(out.redacted, 2, "both private and admin rows counted");
  assert.deepEqual(
    out.rows.map((r) => r.row_key),
    ["1", "3"],
    "only team + external rows survive"
  );

  // The sensitive text is gone from the body that would be pushed.
  assert.ok(!/Severance terms/.test(out.body), "private decision title removed from body");
  assert.ok(!/eyes-only rationale/.test(out.body), "private rationale removed from body");
  assert.ok(!/admin-only detail/.test(out.body), "admin rationale removed from body");

  // Team + external content is preserved intact.
  assert.ok(/Adopt X/.test(out.body) && /public rationale/.test(out.body));
  assert.ok(/Ship V1/.test(out.body));
  // Header + separator (non-data lines) are untouched.
  assert.ok(/\| # \| Date \| Decision \|/.test(out.body));
});

test("redactAdminDecisionRows is a no-op when no admin/private rows exist", () => {
  const body = `| # | Decision | Audience |\n|---|---|---|\n| 1 | Public thing | team |\n`;
  const rows = parseDecisionRows(body);
  const out = redactAdminDecisionRows(body, rows);
  assert.equal(out.redacted, 0);
  assert.equal(out.body, body);
  assert.equal(out.rows.length, rows.length);
});
