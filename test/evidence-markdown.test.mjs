import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyKind,
  parseFactRows,
  parseStakeholderMentionRows,
  validateItemPayload,
  validEvidenceDeclaration,
} from "../scripts/workspace-parse.mjs";

test("frontmatter classifies the two Brain API 1.12 evidence kinds", () => {
  assert.equal(classifyKind("3-log/facts-team.md", { kind: "fact" }), "fact");
  assert.equal(
    classifyKind("4-shared/stakeholder-mentions.md", {
      kind: "stakeholder_mention",
    }),
    "stakeholder_mention"
  );
});

test("fact markdown adapts explicitly to the wire row contract", () => {
  const rows = parseFactRows(
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
      "|---|---|---|---|---|---|\n" +
      "| fact-abcd1234abcd1234 | Launch approved | 2026-07-24 | event | 1-inbox/transcripts/a.md | Launch is approved. |\n"
  );
  assert.deepEqual(rows, [
    {
      row_key: "fact-abcd1234abcd1234",
      title: "Launch approved",
      occurred_at: "2026-07-24",
      fact_type: "event",
      source_path: "1-inbox/transcripts/a.md",
      source_quote: "Launch is approved.",
    },
  ]);
});

test("fact markdown omits the placeholder for an optional date", () => {
  const rows = parseFactRows(
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
      "|---|---|---|---|---|---|\n" +
      "| fact-abcd1234abcd1234 | Warehouse in Jakarta | — | fact | 1-inbox/transcripts/a.md | The warehouse is in Jakarta. |\n"
  );
  assert.equal(Object.hasOwn(rows[0], "occurred_at"), false);
});

test("stakeholder markdown omits empty optional wire fields", () => {
  const rows = parseStakeholderMentionRows(
    "| Row Key | Name | Role | Context | Source Path | Source Quote |\n" +
      "|---|---|---|---|---|---|\n" +
      "| stakeholder-abcd1234abcd1234 | Sam Rivera | — | — | 1-inbox/transcripts/a.md | Sam owns it. |\n"
  );
  assert.deepEqual(rows, [
    {
      row_key: "stakeholder-abcd1234abcd1234",
      name: "Sam Rivera",
      source_path: "1-inbox/transcripts/a.md",
      source_quote: "Sam owns it.",
    },
  ]);
});

test("evidence frontmatter is honored only at canonical approval paths", () => {
  assert.equal(classifyKind("2-work/arbitrary.md", { kind: "fact" }), "deliverable");
  assert.equal(
    classifyKind("4-shared/arbitrary.md", { kind: "stakeholder_mention" }),
    "artifact"
  );
  assert.equal(validEvidenceDeclaration("3-log/facts-team.md", undefined, "team"), false);
  assert.equal(validEvidenceDeclaration("3-log/facts-team.md", "fact", "team"), true);
  assert.equal(validEvidenceDeclaration("3-log/facts-private.md", "fact", "private"), true);
  assert.equal(validEvidenceDeclaration("3-log/facts-private.md", "fact", "team"), false);
  assert.equal(
    validEvidenceDeclaration(
      "4-shared/stakeholder-mentions.md",
      "stakeholder_mention",
      "external"
    ),
    true
  );
  assert.equal(
    validEvidenceDeclaration(
      "4-shared/stakeholder-mentions.md",
      "stakeholder_mention",
      "admin"
    ),
    false
  );
  assert.equal(validEvidenceDeclaration("2-work/arbitrary.md", "fact", "team"), false);
});

test("malformed evidence rows are retained so whole-item validation fails", () => {
  const rows = parseFactRows(
    "| Row Key | Fact | Occurred At | Type | Source Path | Source Quote |\n" +
      "|---|---|---|---|---|---|\n" +
      "| fact-abcd1234abcd1234 | Launch approved | 2026-07-24 | event | 1-inbox/transcripts/a.md | Launch is approved. |\n" +
      "| | Missing key | — | fact | 1-inbox/transcripts/a.md | Missing key. |\n"
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].row_key, "");
  assert.equal(
    validateItemPayload({
      project: "synthetic-project",
      path: "3-log/facts-team.md",
      kind: "fact",
      content_sha256: "a".repeat(64),
      access: "team",
      body: "# Approved facts",
      rows,
    }).success,
    false
  );
});
