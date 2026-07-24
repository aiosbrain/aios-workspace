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
  // Lowercase + trim first so `Private`/`ADMIN`/` team ` can't slip past the admin
  // block or the decision-row redactor as an "unknown" (publishable) tier.
  const t = String(tier ?? "")
    .trim()
    .toLowerCase();
  if (t === "private") return "admin";
  if (t === "client" || t === "company") return "external";
  return t;
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

// Bumped when the pushed shape of a decision-log must overwrite what the brain already stored (H3
// row redaction). A decision-log whose state entry predates this is re-pushed once even at an
// unchanged file SHA — else a workspace that pushed private rows before the redactor keeps them
// upstream. See `contentShaForDecisionPush` (aios.mjs), which hashes the REDACTED body so the
// brain's content_sha256 dedupe actually replaces the previously-leaked copy.
export const DECISION_REDACTION_VERSION = 1;

// A decision row is publishable ONLY when its audience explicitly resolves to team/external.
// Everything else — private/admin, unknown labels, and (crucially) a blank audience cell — is
// withheld (fail closed). Blank → admin is the deliberate V1 policy: an un-tagged row does NOT sync.
const SYNCABLE_DECISION_AUDIENCES = new Set(["team", "external"]);
const DECISION_HEADER_CELLS = new Set([
  "#",
  "date",
  "decision",
  "rationale",
  "decided by",
  "impact",
  "type",
  "audience",
]);

function isSyncableDecisionAudience(audience) {
  return SYNCABLE_DECISION_AUDIENCES.has(normalizeTier(audience));
}

// A markdown separator row: every cell is dashes with optional leading/trailing colons.
function isTableSeparatorLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function hasUnescapedTablePipe(line) {
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "|") continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) slashCount++;
    if (slashCount % 2 === 0) return true;
  }
  return false;
}

// Classify a table's header row. A decision table is one that names a Decision or Audience column.
// `valid` requires exactly one Decision column and at most one Audience column — an ambiguous shape
// fails closed (its data rows are dropped rather than parsed against the wrong column).
function decisionTableSchema(cells) {
  const header = cells.map((c) => c.trim().toLowerCase());
  const cols = (name) => header.reduce((f, c, i) => (c === name ? [...f, i] : f), []);
  const decisionCols = cols("decision");
  const audienceCols = cols("audience");
  return {
    isDecision: decisionCols.length > 0 || audienceCols.length > 0,
    valid: decisionCols.length === 1 && audienceCols.length <= 1,
    columnCount: cells.length,
    header,
    decisionIdx: decisionCols[0] ?? -1,
    audienceIdx: audienceCols[0] ?? -1,
  };
}

// Parse one decision data row against its table's schema. A cell count that doesn't match the header
// (e.g. from a stray unescaped pipe) → null (dropped). A present-but-blank audience cell → "admin".
function parseDecisionRow(cells, schema) {
  if (!schema.valid || cells.length !== schema.columnCount) return null;
  const idx = (name) => schema.header.findIndex((c) => c.startsWith(name));
  const audienceCell = schema.audienceIdx >= 0 ? cells[schema.audienceIdx]?.trim() : null;
  const row = {
    row_key: cells[idx("#")] ?? cells[0] ?? "",
    decided_at: idx("date") >= 0 ? cells[idx("date")] || null : null,
    title: cells[schema.decisionIdx] || "",
    rationale: idx("rationale") >= 0 ? cells[idx("rationale")] || "" : "",
    decided_by: idx("decided") >= 0 ? cells[idx("decided")] || "" : "",
    impact: idx("impact") >= 0 ? cells[idx("impact")] || "" : "",
    tier: idx("type") >= 0 ? parseInt(cells[idx("type")], 10) || null : null,
    audience: schema.audienceIdx < 0 ? null : audienceCell ? normalizeTier(audienceCell) : "admin",
  };
  return row.row_key ? row : null;
}

/**
 * Scan a workspace body line-by-line, tracking decision-table structure, and return
 * { body, rows, keptRows, removedRows }:
 *   - body      the input with every NON-syncable decision data row removed (header + separator kept)
 *   - rows      every parsed decision row (both kept and removed) — what parseDecisionRows returns
 *   - keptRows  only the syncable (team/external) rows
 *   - removedRows count dropped
 *
 * Table-scoped so an adjacent table butted against the decision table (detected via separator
 * lookahead / a fresh decision header) starts a new schema instead of being parsed against the stale
 * audience column, and so unrelated tables/prose are never touched. Redaction works on the raw line —
 * NOT a pre-parsed key set — so a blank or escaped-pipe row_key can't slip a sensitive line through.
 */
function scanDecisionTables(body, fallbackAudience = null) {
  const rows = [];
  const keptRows = [];
  let table = null;
  let removedRows = 0;
  const keptBody = body
    .split("\n")
    .filter((line, index, lines) => {
      const trimmed = line.trim();
      if (!hasUnescapedTablePipe(trimmed)) {
        // Blank lines do not terminate a table: hand-edited decision logs often space rows apart,
        // and resetting here lets a later private/admin continuation bypass body redaction.
        if (trimmed) table = null;
        return true;
      }
      if (isTableSeparatorLine(line)) return true; // keep separators

      const cells = parseTableRows(trimmed.startsWith("|") ? line : `|${line}`)[0] || [];
      const candidate = decisionTableSchema(cells);
      const isLegacyDecisionHeader =
        candidate.isDecision &&
        candidate.header.every((cell) => DECISION_HEADER_CELLS.has(cell)) &&
        (candidate.header.includes("#") ||
          (candidate.decisionIdx >= 0 && candidate.audienceIdx >= 0));
      const startsNewTable = isTableSeparatorLine(lines[index + 1]);
      const currentRow =
        table?.isDecision && !isLegacyDecisionHeader ? parseDecisionRow(cells, table) : null;
      const looksLikeHeader = DECISION_HEADER_CELLS.has(candidate.header[0]);

      // A separator-backed line that looks like a header must never be accepted under stale column
      // indexes. Switch to its decision schema, or to an invalid deny-only schema when ambiguous.
      if (startsNewTable && currentRow && looksLikeHeader && !isLegacyDecisionHeader) {
        table = candidate.isDecision ? candidate : { ...candidate, isDecision: true, valid: false };
        removedRows++;
        return false;
      }
      if ((startsNewTable && !currentRow) || isLegacyDecisionHeader) {
        table = candidate;
        return true;
      }
      if (!table?.isDecision) return true;

      const row = currentRow ?? parseDecisionRow(cells, table);
      if (row) rows.push(row);
      if (row && isSyncableDecisionAudience(row.audience ?? fallbackAudience)) {
        keptRows.push(row);
        return true;
      }
      removedRows++; // non-syncable, malformed, or blank-key → drop the line
      return false;
    })
    .join("\n");
  return { body: keptBody, rows, keptRows, removedRows };
}

export function parseDecisionRows(body) {
  // | # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
  return scanDecisionTables(body).rows;
}

/**
 * Redact non-publishable decision rows from BOTH the pushed body and the parsed rows before a
 * team-tier decision-log syncs (H3). File-level tier gating only decides whether the FILE syncs; a
 * `team` decision-log still carried individual rows marked `Audience: private`, leaking their
 * text/rationale/decided-by — contradicting `decision-log.md`'s "admin rows are your machine only".
 * Re-parses `body` internally (no pre-parsed key set) so a blank/malformed/escaped-pipe row_key can't
 * retain a sensitive body line. Returns { body, rows, redacted }.
 */
export function redactAdminDecisionRows(body, fallbackAudience = null) {
  const scanned = scanDecisionTables(body, fallbackAudience);
  return { body: scanned.body, rows: scanned.keptRows, redacted: scanned.removedRows };
}
