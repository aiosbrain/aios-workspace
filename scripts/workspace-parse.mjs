// Shared, dependency-light parsers for AIOS workspace content. Extracted verbatim from
// scripts/aios.mjs so both the CLI sync client AND the operator-loop collector
// (src/operator-loop) read frontmatter, tiers, kinds, and decision rows the same way —
// keeping tier normalization single-sourced (the architecture invariant). Behavior is
// unchanged; aios.mjs re-imports these. Guarded by test/sync-plan.test.mjs.

import { parseFlatYaml } from "./flat-yaml.mjs";
import { parseTableRows } from "./tasks-table.mjs";
import {
  parsedFactMarkdownToWire,
  parsedStakeholderMarkdownToWire,
} from "./transcript-adapters.mjs";

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

const ITEM_KINDS = new Set([
  "deliverable",
  "transcript",
  "decision",
  "task",
  "artifact",
  "skill",
  "blueprint",
  "fact",
  "stakeholder_mention",
]);
const ITEM_ACCESS = new Set(["team", "external", "client", "company", "admin", "private"]);
const ROOT_KEYS = new Set([
  "project",
  "path",
  "kind",
  "content_sha256",
  "actor",
  "access",
  "frontmatter",
  "body",
  "rows",
]);
const TASK_KEYS = new Set([
  "row_key",
  "title",
  "assignee",
  "status",
  "sprint",
  "due",
  "parent",
  "labels",
  "priority",
  "pm_provider",
  "pm_external_id",
  "pm_url",
]);
const DECISION_KEYS = new Set([
  "row_key",
  "title",
  "decided_at",
  "rationale",
  "decided_by",
  "impact",
  "tier",
  "audience",
]);
const FACT_KEYS = new Set([
  "row_key",
  "title",
  "occurred_at",
  "fact_type",
  "source_path",
  "source_quote",
]);
const STAKEHOLDER_KEYS = new Set([
  "row_key",
  "name",
  "role",
  "context",
  "source_path",
  "source_quote",
]);
const EVIDENCE_PATHS = {
  fact: new Set(["3-log/facts-private.md", "3-log/facts-team.md", "4-shared/facts.md"]),
  stakeholder_mention: new Set([
    "3-log/stakeholder-mentions-private.md",
    "3-log/stakeholder-mentions-team.md",
    "4-shared/stakeholder-mentions.md",
  ]),
};
const EVIDENCE_ACCESS_BY_PATH = new Map([
  ["3-log/facts-private.md", "admin"],
  ["3-log/facts-team.md", "team"],
  ["4-shared/facts.md", "external"],
  ["3-log/stakeholder-mentions-private.md", "admin"],
  ["3-log/stakeholder-mentions-team.md", "team"],
  ["4-shared/stakeholder-mentions.md", "external"],
]);

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));
const stringWithin = (value, min, max) =>
  typeof value === "string" && value.length >= min && value.length <= max;
const optionalString = (value, max, min = 0) =>
  value === undefined || stringWithin(value, min, max);
const nullableString = (value, max) =>
  value === undefined || value === null || stringWithin(value, 0, max);

function validTaskRow(row) {
  return (
    isRecord(row) &&
    onlyKeys(row, TASK_KEYS) &&
    stringWithin(row.row_key, 1, 200) &&
    stringWithin(row.title, 0, 2000) &&
    optionalString(row.assignee, 200) &&
    optionalString(row.status, 120) &&
    optionalString(row.sprint, 200) &&
    nullableString(row.due, 64) &&
    nullableString(row.parent, 200) &&
    (row.labels === undefined ||
      (Array.isArray(row.labels) &&
        row.labels.length <= 50 &&
        row.labels.every((label) => stringWithin(label, 0, 80)))) &&
    nullableString(row.priority, 20) &&
    (row.pm_provider === undefined ||
      row.pm_provider === null ||
      row.pm_provider === "plane" ||
      row.pm_provider === "linear") &&
    nullableString(row.pm_external_id, 200) &&
    nullableString(row.pm_url, 500)
  );
}

function validDecisionRow(row) {
  return (
    isRecord(row) &&
    onlyKeys(row, DECISION_KEYS) &&
    stringWithin(row.row_key, 1, 200) &&
    stringWithin(row.title, 0, 2000) &&
    nullableString(row.decided_at, 64) &&
    optionalString(row.rationale, 4000) &&
    optionalString(row.decided_by, 500) &&
    optionalString(row.impact, 4000) &&
    (row.tier === undefined ||
      row.tier === null ||
      (Number.isInteger(row.tier) && row.tier >= 1 && row.tier <= 3)) &&
    (row.audience === undefined || row.audience === "team" || row.audience === "external")
  );
}

function validFactRow(row) {
  return (
    isRecord(row) &&
    onlyKeys(row, FACT_KEYS) &&
    stringWithin(row.row_key, 1, 128) &&
    stringWithin(row.title, 1, 500) &&
    (row.occurred_at === undefined ||
      (stringWithin(row.occurred_at, 1, 64) &&
        /^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(row.occurred_at))) &&
    (row.fact_type === "fact" || row.fact_type === "event") &&
    stringWithin(row.source_path, 1, 500) &&
    stringWithin(row.source_quote, 1, 4000)
  );
}

function validStakeholderRow(row) {
  return (
    isRecord(row) &&
    onlyKeys(row, STAKEHOLDER_KEYS) &&
    stringWithin(row.row_key, 1, 128) &&
    stringWithin(row.name, 1, 200) &&
    optionalString(row.role, 200, 1) &&
    optionalString(row.context, 1000, 1) &&
    stringWithin(row.source_path, 1, 500) &&
    stringWithin(row.source_quote, 1, 4000)
  );
}

export function validateItemPayload(input) {
  if (!isRecord(input) || !onlyKeys(input, ROOT_KEYS)) return { success: false };
  if (
    !stringWithin(input.project, 1, 120) ||
    !stringWithin(input.path, 1, 500) ||
    !ITEM_KINDS.has(input.kind) ||
    !/^[a-f0-9]{64}$/.test(input.content_sha256) ||
    !ITEM_ACCESS.has(input.access) ||
    !stringWithin(input.body, 0, 1_000_000) ||
    !optionalString(input.actor, 120) ||
    (input.frontmatter !== undefined && !isRecord(input.frontmatter))
  ) {
    return { success: false };
  }
  const hasRows = Object.hasOwn(input, "rows");
  if (hasRows && !Array.isArray(input.rows)) return { success: false };
  switch (input.kind) {
    case "task":
      return { success: !hasRows || input.rows.every(validTaskRow) };
    case "decision":
      return { success: !hasRows || input.rows.every(validDecisionRow) };
    case "fact":
      return { success: hasRows && input.rows.length > 0 && input.rows.every(validFactRow) };
    case "stakeholder_mention":
      return { success: hasRows && input.rows.length > 0 && input.rows.every(validStakeholderRow) };
    case "deliverable":
    case "transcript":
    case "artifact":
    case "skill":
    case "blueprint":
      return { success: !hasRows };
    default:
      return { success: false };
  }
}

export function isCanonicalEvidencePath(kind, rel) {
  return EVIDENCE_PATHS[kind]?.has(rel.replaceAll("\\", "/")) ?? false;
}

function evidenceKindForPath(rel) {
  return Object.keys(EVIDENCE_PATHS).find((kind) => isCanonicalEvidencePath(kind, rel));
}

export function validEvidenceDeclaration(rel, declaredKind, declaredAccess) {
  const normalizedRel = rel.replaceAll("\\", "/");
  const expected = evidenceKindForPath(rel);
  if (!expected) return !Object.hasOwn(EVIDENCE_PATHS, declaredKind);
  return (
    declaredKind === expected &&
    normalizeTier(declaredAccess) === EVIDENCE_ACCESS_BY_PATH.get(normalizedRel)
  );
}

export function evidencePayloadContent(kind, frontmatter, body) {
  if (kind === "fact") {
    return { frontmatter: { kind, access: frontmatter.access }, body: "# Approved facts" };
  }
  if (kind === "stakeholder_mention") {
    return {
      frontmatter: { kind, access: frontmatter.access },
      body: "# Approved stakeholder mentions",
    };
  }
  return { frontmatter, body };
}

export function classifyKind(rel, frontmatter) {
  // Spine-agnostic: match by filename/role so new (3-log, 2-work) and legacy
  // (03-status, 02-deliverables) spines both classify correctly.
  const base = rel.split("/").pop();
  if (isCanonicalEvidencePath(frontmatter?.kind, rel)) return frontmatter.kind;
  if (base === "decision-log.md") return "decision";
  // AIO-364: tasks now live in tier-explicit homes (tasks-team.md, tasks-private.md),
  // not just the legacy single tasks.md — match any of them so the brain-api "task"
  // kind (and its row parsing) still applies to the split files.
  if (/^tasks(-.*)?\.md$/.test(base)) return "task";
  if (frontmatter?.type === "transcript" || rel.includes("/transcripts/")) return "transcript";
  if (/^(2-work|02-deliverables)[/\\]/.test(rel)) return "deliverable";
  return "artifact";
}

export function parseFactRows(body) {
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((value) => value.toLowerCase());
  if (!header.includes("fact") || !header.includes("source quote")) return [];
  const idx = (name) => header.findIndex((value) => value.startsWith(name));
  return rows
    .slice(1)
    .map((cells) =>
      parsedFactMarkdownToWire({
        rowKey: cells[idx("row key")] ?? cells[0] ?? "",
        title: cells[idx("fact")] ?? "",
        occurredAt:
          idx("occurred") >= 0 && cells[idx("occurred")] !== "—"
            ? cells[idx("occurred")]
            : undefined,
        factType: cells[idx("type")] === "event" ? "event" : "fact",
        sourcePath: cells[idx("source path")] ?? "",
        sourceQuote: cells[idx("source quote")] ?? "",
      })
    );
}

export function parseStakeholderMentionRows(body) {
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((value) => value.toLowerCase());
  if (!header.includes("name") || !header.includes("source quote")) return [];
  const idx = (name) => header.findIndex((value) => value.startsWith(name));
  return rows
    .slice(1)
    .map((cells) =>
      parsedStakeholderMarkdownToWire({
        rowKey: cells[idx("row key")] ?? cells[0] ?? "",
        name: cells[idx("name")] ?? "",
        role: idx("role") >= 0 && cells[idx("role")] !== "—" ? cells[idx("role")] : undefined,
        context:
          idx("context") >= 0 && cells[idx("context")] !== "—"
            ? cells[idx("context")]
            : undefined,
        sourcePath: cells[idx("source path")] ?? "",
        sourceQuote: cells[idx("source quote")] ?? "",
      })
    );
}

export function parseEvidenceRows(kind, body) {
  if (kind === "decision") return parseDecisionRows(body);
  if (kind === "fact") return parseFactRows(body);
  if (kind === "stakeholder_mention") return parseStakeholderMentionRows(body);
  return undefined;
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
        // Prose after a decision table enters deny-only state until a clear table header appears:
        // an orphan pipe row after prose is ambiguous and must not survive in the outbound body.
        if (trimmed) {
          table = table?.isDecision ? { ...table, valid: false } : null;
        }
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
      const looksLikeHeader =
        candidate.header.includes("#") ||
        (candidate.decisionIdx >= 0 && candidate.audienceIdx >= 0) ||
        (currentRow && !isSyncableDecisionAudience(currentRow.audience ?? fallbackAudience));

      // A separator-backed line that looks like a header must never be accepted under stale column
      // indexes. Switch to its decision schema, or to an invalid deny-only schema when ambiguous.
      if (startsNewTable && currentRow && looksLikeHeader && !isLegacyDecisionHeader) {
        table = candidate.isDecision ? candidate : { ...candidate, isDecision: true, valid: false };
        removedRows++;
        return false;
      }
      if (startsNewTable && currentRow) {
        rows.push(currentRow);
        keptRows.push(currentRow);
        table = { ...table, valid: false };
        return true;
      }
      if (isLegacyDecisionHeader) {
        table = candidate;
        return true;
      }
      const recoverableDenyOnlyRow =
        table?.isDecision && !table.valid
          ? parseDecisionRow(cells, { ...table, valid: true })
          : null;
      const staleAudienceCell =
        table?.isDecision && table.audienceIdx >= 0 ? cells[table.audienceIdx] : null;
      const staleAudienceLooksRestricted =
        staleAudienceCell != null &&
        staleAudienceCell !== "" &&
        !isSyncableDecisionAudience(staleAudienceCell);
      if (
        startsNewTable &&
        !currentRow &&
        (recoverableDenyOnlyRow || staleAudienceLooksRestricted)
      ) {
        removedRows++;
        return false;
      }
      if (startsNewTable && !currentRow) {
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
