// Shared, dependency-light parsers for AIOS workspace content. Extracted verbatim from
// scripts/aios.mjs so both the CLI sync client AND the operator-loop collector
// (src/operator-loop) read frontmatter, tiers, kinds, and decision rows the same way —
// keeping tier normalization single-sourced (the architecture invariant). Behavior is
// unchanged; aios.mjs re-imports these. Guarded by test/sync-plan.test.mjs.

import { parseFlatYaml } from "./flat-yaml.mjs";
import { parseTableRows } from "./tasks-table.mjs";

export function parseFrontmatter(content) {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: content };
  const fmText = content.slice(content.indexOf("\n") + 1, end);
  // When the closing `---` is the last line, there is no newline after it — body is empty.
  // (indexOf returns -1; `-1 + 1` would slice from 0 and leak the whole doc back as body.)
  const bodyStart = content.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : content.slice(bodyStart + 1);
  return { frontmatter: parseFlatYaml(fmText), body };
}

export function normalizeTier(tier) {
  // Friendly labels → canonical engine values. `private` never syncs (= admin);
  // outward tiers `client` (consultant) and `company` (employee) → external.
  if (tier === "private") return "admin";
  if (tier === "client" || tier === "company") return "external";
  return tier;
}

export function classifyKind(rel, frontmatter) {
  // Spine-agnostic: match by filename/role so new (3-log, 2-work) and legacy
  // (03-status, 02-deliverables) spines both classify correctly.
  const base = rel.split("/").pop();
  if (base === "decision-log.md") return "decision";
  if (base === "tasks.md") return "task";
  if (frontmatter?.type === "transcript" || rel.includes("/transcripts/")) return "transcript";
  if (/^(2-work|02-deliverables)[/\\]/.test(rel)) return "deliverable";
  return "artifact";
}

export function parseDecisionRows(body) {
  // | # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  if (!header.includes("decision")) return [];
  const idx = (name) => header.findIndex((h) => h.startsWith(name));
  return rows
    .slice(1)
    .map((cells) => ({
      row_key: cells[idx("#")] ?? cells[0] ?? "",
      decided_at: idx("date") >= 0 ? cells[idx("date")] || null : null,
      title: cells[idx("decision")] || "",
      rationale: idx("rationale") >= 0 ? cells[idx("rationale")] || "" : "",
      decided_by: idx("decided") >= 0 ? cells[idx("decided")] || "" : "",
      impact: idx("impact") >= 0 ? cells[idx("impact")] || "" : "",
      tier: idx("type") >= 0 ? parseInt(cells[idx("type")], 10) || null : null,
      audience: idx("audience") >= 0 ? normalizeTier(cells[idx("audience")] || "team") : "team",
    }))
    .filter((r) => r.row_key);
}
