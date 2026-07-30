/**
 * spec-checks/rubric.mjs — spec-readiness rubric loading + resolution. Extracted VERBATIM from
 * scripts/spec-eval.mjs (AIO-594, devtools-lane decoupling): the deterministic spec layer stays
 * in aios-workspace core (spec-author.mjs consumes it) while spec-eval.mjs moves to the
 * aios-devtools repo. Import via the scripts/spec-checks.mjs barrel (R1).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUBRIC_REL = path.join(".claude", "rubrics", "spec-readiness.md");
// The canonical rubric shipped inside this toolkit checkout (…/aios-workspace/.claude/rubrics/…).
const TOOLKIT_RUBRIC_PATH = path.join(SCRIPT_DIR, "..", "..", DEFAULT_RUBRIC_REL);
export const DEFAULT_FIX_BUDGET = 2;

// ── rubric loading ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the spec-readiness rubric: frontmatter (kind/applies_to/budget/pass) + the SR table.
 * Throws (loudly) on a missing/unreadable/malformed rubric — the caller maps that to exit 4.
 */
export function loadRubric(rubricPath) {
  if (!existsSync(rubricPath)) throw new Error(`rubric not found: ${rubricPath}`);
  let raw;
  try {
    raw = readFileSync(rubricPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read rubric ${rubricPath}: ${e.message}`);
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`malformed rubric ${rubricPath}: missing YAML frontmatter`);
  const frontmatter = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  if (frontmatter.kind !== "rubric") {
    throw new Error(`malformed rubric ${rubricPath}: frontmatter kind must be 'rubric'`);
  }
  const budget = Number(frontmatter.budget);
  frontmatter.budget = Number.isInteger(budget) && budget >= 0 ? budget : DEFAULT_FIX_BUDGET;

  // Rows: table lines with 4 cells (ID | Criterion | Check method | Must), skipping the header
  // and the |---| separator. A rubric with no parseable SR row is malformed.
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 4) continue;
    const [id, criterion, method, must] = cells;
    if (!/^SR\d+$/.test(id)) continue; // header / separator / non-SR rows
    rows.push({ id, criterion, method, must });
  }
  if (rows.length === 0) {
    throw new Error(`malformed rubric ${rubricPath}: no SR criteria rows found`);
  }
  return { frontmatter, rows, raw, path: rubricPath };
}

/**
 * Resolve which rubric file to grade against, in precedence order:
 *   1. an explicit `--rubric <path>` (caller override, honored verbatim),
 *   2. the target repo's own `.claude/rubrics/spec-readiness.md` (scaffolded workspaces vendor it),
 *   3. the canonical rubric shipped inside this toolkit checkout.
 * The fallback (3) is what lets the spec gate run in a NON-workspace repo — the Team Brain, or any
 * bare repo — that doesn't vendor a rubric, instead of hard-failing with "rubric not found" (exit 4).
 */
export function resolveRubricPath(repo, explicit = null) {
  if (explicit) return explicit;
  const local = path.join(repo, DEFAULT_RUBRIC_REL);
  if (existsSync(local)) return local;
  return TOOLKIT_RUBRIC_PATH;
}
