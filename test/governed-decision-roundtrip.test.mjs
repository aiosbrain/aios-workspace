import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDecisionWriteback } from "../scripts/pull-decisions.mjs";
import { parseDecisionRows, redactAdminDecisionRows } from "../scripts/workspace-parse.mjs";
const header =
  "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
const fixture = {
  row_key: "ui-roundtrip",
  decided_at: "2026-09-28",
  title: "😀".repeat(500),
  rationale: "😀".repeat(25000),
  impact: "🌍".repeat(5000),
  decided_by: "authenticated-actor",
  tier: null,
  audience: "team",
};
test("maximum accepted action content survives the existing pull-to-push representation", () => {
  const doc = mergeDecisionWriteback(header + "\n", [fixture]);
  const outbound = redactAdminDecisionRows(doc);
  assert.deepEqual(outbound.rows, [fixture]);
  assert.deepEqual(parseDecisionRows(outbound.body), [fixture]);
  assert.equal(mergeDecisionWriteback(doc, [fixture]), doc);
});
test("adjacent legacy tables are converted with their own original decoding mode", () => {
  const doc =
    header +
    "\n| old-one | | Literal &amp; | | A | | | team |\n" +
    header +
    "\n| old-two | | Literal &#10; | | B | | | team |\n";
  const merged = mergeDecisionWriteback(doc, [
    { ...fixture, title: "Choice", rationale: "Why", impact: "" },
  ]);
  const parsed = parseDecisionRows(merged);
  assert.equal(parsed.find((r) => r.row_key === "old-one").title, "Literal &amp;");
  assert.equal(parsed.find((r) => r.row_key === "old-two").title, "Literal &#10;");
  assert.equal(parsed.filter((r) => r.row_key === fixture.row_key).length, 1);
});

test("pull preserves missing Audience inheritance through actual sync planning", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildPlan } = await import("../scripts/sync-plan.mjs");
  const cfg = { sync_include: ["3-log"], sync_exclude: [], sync_tiers: ["team", "external"] };
  for (const tier of ["team", "external", "admin", null]) {
    const repo = mkdtempSync(join(tmpdir(), "decision-pull-tier-"));
    try {
      mkdirSync(join(repo, "3-log"));
      const file = join(repo, "3-log", "decision-log.md");
      const original = `---\nkind: decision\n${tier ? `access: ${tier}\n` : ""}---\n| # | Decision |\n| --- | --- |\n| local | Existing &#124; |\n`;
      writeFileSync(file, original);
      const before = buildPlan(repo, cfg, []).plan;
      const incoming = { ...fixture, title: "Choice", rationale: "Why", impact: "" };
      const after = mergeDecisionWriteback(original, [incoming]);
      writeFileSync(file, after);
      const planned = buildPlan(repo, cfg, []).plan;
      if (tier === "team" || tier === "external") {
        assert.equal(before.push[0].rows[0].row_key, "local");
        const legacy = planned.push[0].rows.find((r) => r.row_key === "local");
        assert.equal(legacy.title, "Existing &#124;");
        assert.equal(legacy.audience, tier);
        assert.deepEqual(
          planned.push[0].rows.find((r) => r.row_key === fixture.row_key),
          incoming
        );
      } else {
        assert.equal(before.push.length, 0);
        assert.equal(planned.push.length, 0);
        assert.equal(planned.blocked.length, 1);
      }
      assert.equal(mergeDecisionWriteback(after, [incoming]), after);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("an explicit blank audience stays withheld despite a team file fallback", () => {
  const doc =
    "---\naccess: team\n---\n| # | Decision | Audience |\n| --- | --- | --- |\n| private | local-sentinel | |\n";
  const merged = mergeDecisionWriteback(doc, [
    { ...fixture, title: "Choice", rationale: "Why", impact: "" },
  ]);
  const out = redactAdminDecisionRows(merged, "team");
  assert.ok(!out.rows.some((r) => r.row_key === "private"));
  assert.ok(!out.body.includes("local-sentinel"));
});
