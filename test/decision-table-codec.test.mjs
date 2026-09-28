import test from "node:test";
import assert from "node:assert/strict";
import { DECISION_CELL_MARKER, encodeTableCell, decodeTableCell, parseDecisionRows, redactAdminDecisionRows } from "../scripts/workspace-parse.mjs";
const header = "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n|---|---|---|---|---|---|---|---|";
test("marked decision cells round-trip hostile valid prose and preserve literal entities", () => {
  const prose = " \u00a0A|B\\\r\nC $& $1 &amp; &#10; <tag>\t\u2003";
  assert.equal(decodeTableCell(encodeTableCell(prose)), prose);
  const row = ["ui-test", "2026-09-28", prose, prose.repeat(2), "sam", prose, "", "team"].map(encodeTableCell);
  const body = `${DECISION_CELL_MARKER}\n${header}\n| ${row.join(" | ")} |`;
  const parsed = parseDecisionRows(body)[0];
  assert.equal(parsed.title, prose);
  assert.equal(parsed.rationale, prose.repeat(2));
  assert.equal(parsed.impact, prose);
  assert.equal(redactAdminDecisionRows(body).rows[0].title, prose);
});
test("unmarked historical tables do not decode entity-looking user text", () => {
  const row = "| old | 2026-09-28 | Literal &amp; &#124; | Rationale | sam | | | team |";
  assert.equal(parseDecisionRows(`${header}\n${row}`)[0].title, "Literal &amp; &#124;");
});
test("encoded private audience remains excluded from both body and rows", () => {
  const body = `${DECISION_CELL_MARKER}\n${header}\n| secret | 2026-09-28 | Hidden | Sensitive | sam | | | &#97;dmin |`;
  const result = redactAdminDecisionRows(body);
  assert.equal(result.rows.length, 0);
  assert.equal(result.body.includes("Sensitive"), false);
});
