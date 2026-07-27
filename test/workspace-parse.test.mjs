// Direct unit coverage for the parse-layer exports of scripts/workspace-parse.mjs that
// the transcript-extraction-contract-v1 spec's Testability block runs by name. Detailed
// row-shape/adapter coverage for fact + stakeholder markdown already lives in
// test/evidence-markdown.test.mjs and the fixture-driven test/item-payload-contract.test.mjs
// — this file focuses on the functions those suites don't already exercise directly:
// parseEvidenceRows' kind dispatch (including the decision → redaction-aware delegate),
// validateItemPayload across every kind, validEvidenceDeclaration's non-evidence-path
// branch, and normalizeTier's fail-closed tier collapsing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFactRows,
  parseStakeholderMentionRows,
  parseEvidenceRows,
  parseDecisionRows,
  redactAdminDecisionRows,
  validateItemPayload,
  validEvidenceDeclaration,
  normalizeTier,
} from "../scripts/workspace-parse.mjs";

test("parseFactRows returns wire-shaped rows from a canonical fact table", () => {
  const rows = parseFactRows(
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
      "|---|---|---|---|---|---|\n" +
      "| fact-abcd1234abcd1234 | Warehouse relocated | 2026-07-24 | fact | 1-inbox/transcripts/a.md | The warehouse moved. |\n"
  );
  assert.deepEqual(rows, [
    {
      row_key: "fact-abcd1234abcd1234",
      title: "Warehouse relocated",
      occurred_at: "2026-07-24",
      fact_type: "fact",
      source_path: "1-inbox/transcripts/a.md",
      source_quote: "The warehouse moved.",
    },
  ]);
});

test("parseFactRows returns no rows when the table header doesn't match", () => {
  assert.deepEqual(parseFactRows("| Name | Role |\n|---|---|\n| Sam | Lead |\n"), []);
  assert.deepEqual(parseFactRows(""), []);
});

test("parseStakeholderMentionRows returns wire-shaped rows from a canonical table", () => {
  const rows = parseStakeholderMentionRows(
    "| Row Key | Name | Role | Context | Source Path | Source Quote |\n" +
      "|---|---|---|---|---|---|\n" +
      "| stakeholder-abcd1234abcd1234 | Sam Rivera | Lead | ops | 1-inbox/transcripts/a.md | Sam runs ops. |\n"
  );
  assert.deepEqual(rows, [
    {
      row_key: "stakeholder-abcd1234abcd1234",
      name: "Sam Rivera",
      role: "Lead",
      context: "ops",
      source_path: "1-inbox/transcripts/a.md",
      source_quote: "Sam runs ops.",
    },
  ]);
});

test("parseStakeholderMentionRows returns no rows when the table header doesn't match", () => {
  assert.deepEqual(
    parseStakeholderMentionRows("| Fact | Source Quote |\n|---|---|\n| x | y |\n"),
    []
  );
});

test("parseEvidenceRows dispatches fact and stakeholder_mention to their own parsers", () => {
  const factBody =
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
    "|---|---|---|---|---|---|\n" +
    "| fact-abcd1234abcd1234 | Launch approved | — | event | 1-inbox/transcripts/a.md | Launch is approved. |\n";
  const stakeholderBody =
    "| Row Key | Name | Role | Context | Source Path | Source Quote |\n" +
    "|---|---|---|---|---|---|\n" +
    "| stakeholder-abcd1234abcd1234 | Sam Rivera | — | — | 1-inbox/transcripts/a.md | Sam owns it. |\n";
  assert.deepEqual(parseEvidenceRows("fact", factBody), parseFactRows(factBody));
  assert.deepEqual(
    parseEvidenceRows("stakeholder_mention", stakeholderBody),
    parseStakeholderMentionRows(stakeholderBody)
  );
});

test("parseEvidenceRows for kind 'decision' delegates to the redaction-aware decision parser", () => {
  const body =
    "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
    "|---|---|---|---|---|---|---|---|\n" +
    "| 1 | 2026-07-24 | Ship v1.12 | ready | Sam | high | 1 | team |\n" +
    "| 2 | 2026-07-24 | Internal-only call | private context | Sam | low | 2 | private |\n";

  // parseEvidenceRows("decision", ...) must be the SAME function as parseDecisionRows —
  // both return every row (kept + redacted), unlike redactAdminDecisionRows which strips
  // non-syncable rows from the returned body/rows. This proves the dispatch target is the
  // redaction-aware decision-table scanner (scanDecisionTables), not a naive table read.
  const viaDispatch = parseEvidenceRows("decision", body);
  const viaDirect = parseDecisionRows(body);
  assert.deepEqual(viaDispatch, viaDirect);
  assert.equal(viaDispatch.length, 2);
  assert.equal(viaDispatch[0].audience, "team");
  // A private-audience row is parsed (not silently dropped) so callers can redact it —
  // that's the redaction-aware behavior: parsing and redaction share one table scanner.
  assert.equal(viaDispatch[1].audience, "admin");

  // redactAdminDecisionRows shares the same table scanner but returns only the KEPT
  // (syncable) rows plus a redacted count — confirming parseEvidenceRows/parseDecisionRows
  // and redactAdminDecisionRows are two views over one scanDecisionTables implementation.
  const redacted = redactAdminDecisionRows(body);
  assert.equal(redacted.rows.length, 1);
  assert.equal(redacted.redacted, 1);
  assert.deepEqual(
    redacted.rows.map((row) => row.row_key),
    viaDispatch.filter((row) => row.audience === "team").map((row) => row.row_key)
  );
});

test("parseEvidenceRows returns undefined for kinds without row parsing", () => {
  assert.equal(parseEvidenceRows("task", "irrelevant"), undefined);
  assert.equal(parseEvidenceRows("deliverable", "irrelevant"), undefined);
  assert.equal(parseEvidenceRows("artifact", "irrelevant"), undefined);
});

const BASE_PAYLOAD = {
  project: "synthetic-project",
  path: "2-work/report.md",
  content_sha256: "a".repeat(64),
  actor: "eval",
  access: "team",
  frontmatter: {},
  body: "hello",
};

test("validateItemPayload accepts a minimal valid payload for every item kind", () => {
  const rowless = ["deliverable", "transcript", "artifact", "skill", "blueprint"];
  for (const kind of rowless) {
    assert.equal(validateItemPayload({ ...BASE_PAYLOAD, kind }).success, true, kind);
  }
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      kind: "task",
      rows: [{ row_key: "t1", title: "Do the thing" }],
    }).success,
    true,
    "task"
  );
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      kind: "decision",
      rows: [{ row_key: "d1", title: "Ship it" }],
    }).success,
    true,
    "decision"
  );
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      path: "3-log/facts-team.md",
      kind: "fact",
      rows: [
        {
          row_key: "fact-abcd1234abcd1234",
          title: "Warehouse relocated",
          fact_type: "fact",
          source_path: "1-inbox/transcripts/a.md",
          source_quote: "The warehouse moved.",
        },
      ],
    }).success,
    true,
    "fact"
  );
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      path: "3-log/stakeholder-mentions-team.md",
      kind: "stakeholder_mention",
      rows: [
        {
          row_key: "stakeholder-abcd1234abcd1234",
          name: "Sam Rivera",
          source_path: "1-inbox/transcripts/a.md",
          source_quote: "Sam owns it.",
        },
      ],
    }).success,
    true,
    "stakeholder_mention"
  );
});

test("validateItemPayload rejects a payload with an unknown root key", () => {
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      kind: "deliverable",
      unexpected_key: "nope",
    }).success,
    false
  );
});

test("validateItemPayload rejects a row with an unknown key", () => {
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      kind: "task",
      rows: [{ row_key: "t1", title: "Do the thing", not_a_real_key: true }],
    }).success,
    false
  );
});

test("validateItemPayload requires at least one row for fact and stakeholder_mention kinds", () => {
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      path: "3-log/facts-team.md",
      kind: "fact",
      rows: [],
    }).success,
    false
  );
  assert.equal(
    validateItemPayload({
      ...BASE_PAYLOAD,
      path: "3-log/stakeholder-mentions-team.md",
      kind: "stakeholder_mention",
      rows: [],
    }).success,
    false
  );
});

test("validEvidenceDeclaration allows a non-evidence path declaring a non-evidence kind", () => {
  assert.equal(validEvidenceDeclaration("2-work/report.md", "deliverable", "team"), true);
  assert.equal(validEvidenceDeclaration("2-work/report.md", "artifact", "external"), true);
});

test("validEvidenceDeclaration rejects a non-evidence path declaring an evidence kind", () => {
  assert.equal(validEvidenceDeclaration("2-work/report.md", "fact", "team"), false);
  assert.equal(validEvidenceDeclaration("2-work/report.md", "stakeholder_mention", "team"), false);
});

test("normalizeTier fails closed: blank, 'Private', and 'ADMIN' never resolve to a syncable tier", () => {
  // Blank/whitespace-only tiers pass through untouched — they are NOT coerced into any
  // canonical tier (in particular, never "team"/"external"), so the default-deny boundary
  // downstream (ITEM_ACCESS / validateItemPayload) rejects them rather than silently syncing.
  assert.equal(normalizeTier(""), "");
  assert.equal(normalizeTier(undefined), "");
  assert.equal(normalizeTier("   "), "");
  assert.equal(
    validateItemPayload({ ...BASE_PAYLOAD, kind: "deliverable", access: normalizeTier("") })
      .success,
    false
  );

  // Case/whitespace variants of "private" and "admin" collapse to the single canonical
  // "admin" tier — never treated as an unrecognized (and therefore possibly-syncable) label.
  assert.equal(normalizeTier("Private"), "admin");
  assert.equal(normalizeTier(" PRIVATE "), "admin");
  assert.equal(normalizeTier("ADMIN"), "admin");
  assert.equal(normalizeTier(" admin "), "admin");

  // None of these ever normalize into either syncable tier.
  for (const input of ["", undefined, "Private", "ADMIN", "private", "admin"]) {
    const normalized = normalizeTier(input);
    assert.notEqual(normalized, "team");
    assert.notEqual(normalized, "external");
  }
});

test("normalizeTier still maps friendly outward-audience labels to external", () => {
  assert.equal(normalizeTier("client"), "external");
  assert.equal(normalizeTier("company"), "external");
  assert.equal(normalizeTier(" Team "), "team");
});
