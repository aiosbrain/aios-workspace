// Shared, dependency-light parsers for AIOS workspace content. Extracted verbatim from
// scripts/aios.mjs so both the CLI sync client AND the operator-loop collector
// (src/operator-loop) read frontmatter, tiers, kinds, and decision rows the same way —
// keeping tier normalization single-sourced (the architecture invariant). aios.mjs
// re-imports these shared implementations. Guarded by test/sync-plan.test.mjs.

import { parseFlatYaml } from "./flat-yaml.mjs";
import { parseTableRows } from "./tasks-table.mjs";

export const DECISION_SYNC_VERSION = 1;
const SYNCABLE_DECISION_AUDIENCES = new Set(["team", "external"]);

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
  // AIO-364: tasks now live in tier-explicit homes (tasks-team.md, tasks-private.md),
  // not just the legacy single tasks.md — match any of them so the brain-api "task"
  // kind (and its row parsing) still applies to the split files.
  if (/^tasks(-.*)?\.md$/.test(base)) return "task";
  if (frontmatter?.type === "transcript" || rel.includes("/transcripts/")) return "transcript";
  if (/^(2-work|02-deliverables)[/\\]/.test(rel)) return "deliverable";
  return "artifact";
}

function isSyncableDecisionAudience(audience) {
  const normalized = normalizeTier(
    String(audience ?? "")
      .trim()
      .toLowerCase()
  );
  return SYNCABLE_DECISION_AUDIENCES.has(normalized);
}

function isTableSeparatorLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = trimmed
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function decisionTableSchema(cells) {
  const header = cells.map((cell) => cell.trim().toLowerCase());
  const indexes = (name) =>
    header.reduce((found, cell, index) => (cell === name ? [...found, index] : found), []);
  const decisionIndexes = indexes("decision");
  const audienceIndexes = indexes("audience");
  const isDecision = decisionIndexes.length > 0 || audienceIndexes.length > 0;
  return {
    isDecision,
    valid: decisionIndexes.length === 1 && audienceIndexes.length <= 1,
    columnCount: cells.length,
    header,
    decisionIdx: decisionIndexes[0] ?? -1,
    audienceIdx: audienceIndexes[0] ?? -1,
  };
}

function parseDecisionRow(cells, schema) {
  if (!schema.valid || cells.length !== schema.columnCount) return null;
  const idx = (name) => schema.header.findIndex((cell) => cell.startsWith(name));
  const audienceCell = schema.audienceIdx >= 0 ? cells[schema.audienceIdx]?.trim() : null;
  const row = {
    row_key: cells[idx("#")] ?? cells[0] ?? "",
    decided_at: idx("date") >= 0 ? cells[idx("date")] || null : null,
    title: cells[schema.decisionIdx] || "",
    rationale: idx("rationale") >= 0 ? cells[idx("rationale")] || "" : "",
    decided_by: idx("decided") >= 0 ? cells[idx("decided")] || "" : "",
    impact: idx("impact") >= 0 ? cells[idx("impact")] || "" : "",
    tier: idx("type") >= 0 ? parseInt(cells[idx("type")], 10) || null : null,
    audience:
      schema.audienceIdx < 0
        ? null
        : audienceCell
          ? normalizeTier(audienceCell.toLowerCase())
          : "admin",
  };
  return row.row_key ? row : null;
}

function scanDecisionTables(body) {
  const rows = [];
  const keptRows = [];
  let table = null;
  let removedRows = 0;
  const keptBody = body
    .split("\n")
    .filter((line, index, lines) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) {
        table = null;
        return true;
      }
      if (isTableSeparatorLine(line)) return true;

      const cells = parseTableRows(line)[0] || [];
      const candidateTable = decisionTableSchema(cells);
      const followedBySeparator = isTableSeparatorLine(lines[index + 1]);
      if (!table?.isDecision && followedBySeparator) {
        table = candidateTable;
        return true;
      }
      if (!table) {
        if (candidateTable.isDecision) {
          table = candidateTable;
          return true;
        }
        return true;
      }
      if (!table.isDecision) {
        if (candidateTable.isDecision) {
          table = candidateTable;
          removedRows++;
          return false;
        }
        return true;
      }

      const row = parseDecisionRow(cells, table);
      if (candidateTable.isDecision) {
        table = candidateTable;
        removedRows++;
        return false;
      }
      if (row) rows.push(row);
      if (row && isSyncableDecisionAudience(row.audience)) {
        keptRows.push(row);
        return true;
      }
      removedRows++;
      return false;
    })
    .join("\n");
  return { body: keptBody, rows, keptRows, removedRows };
}

export function parseDecisionRows(body) {
  return scanDecisionTables(body).rows;
}

/**
 * Keep only explicitly team/external decision rows in both outbound payload forms. Unknown,
 * missing, private, and admin audiences are default-denied. Markdown rows are parsed directly
 * as well as filtering the structured rows so malformed or duplicate row keys cannot retain a
 * sensitive body line.
 */
export function redactAdminDecisionRows(body) {
  const scanned = scanDecisionTables(body);
  return {
    body: scanned.body,
    rows: scanned.keptRows,
    redacted: scanned.removedRows,
  };
}
