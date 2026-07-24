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
