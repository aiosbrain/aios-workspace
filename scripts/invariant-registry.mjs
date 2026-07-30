/**
 * invariant-registry.mjs — parse the §8 invariant registry out of the engineering
 * constitution (docs/ENGINEERING-CONSTITUTION.md).
 *
 * The registry is a machine-parseable markdown table |Invariant|Enforcer|Runs in|.
 * Consumers:
 *   - test/invariant-registry.test.mjs — asserts every non-pending row's enforcer
 *     file exists and is reachable from `test:prepare` or a CI workflow.
 *   - the codebase-health rubric's invariants axis (AIO-605) imports the same parser
 *     so the rubric and the test can never disagree about what the registry says.
 *
 * Kept dependency-free (node:fs/node:path only) so it is importable from anywhere.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const CONSTITUTION_RELPATH = path.join("docs", "ENGINEERING-CONSTITUTION.md");

// The §8 heading line. Anchored to a heading so a stray mention elsewhere can't match.
const SECTION_HEADING_RE = /^##\s*8\.\s*Invariant registry\s*$/m;

// A backticked token counts as an enforcer path when it has a directory component
// (contains "/"). This skips npm-script names (`check:size`), bare function names
// (`checkVersionLabels()`), and prose.
const ENFORCER_PATH_RE = /`([^`\s]+\/[^`\s]+)`/g;

// isSeparatorRow("|---|---|---|") → true for the markdown header/body divider.
function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * parseInvariantRegistry(markdown) → array of rows. Pure.
 * Row shape: { invariant, enforcer, runsIn, enforcerPaths: string[], pending: boolean }.
 * A row is `pending` when its Runs-in cell contains the word "pending" — such rows
 * name the issue/PR that will wire the enforcer, and are exempt from wiring checks.
 * Throws when the §8 section or its table is missing (the registry is a contract,
 * not an optional decoration).
 */
export function parseInvariantRegistry(markdown) {
  const headingMatch = SECTION_HEADING_RE.exec(markdown);
  if (!headingMatch) {
    throw new Error(`invariant registry: no "## 8. Invariant registry" heading found`);
  }
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const nextHeading = markdown.slice(sectionStart).search(/^##\s/m);
  const section =
    nextHeading === -1
      ? markdown.slice(sectionStart)
      : markdown.slice(sectionStart, sectionStart + nextHeading);

  const tableLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (tableLines.length < 3) {
    throw new Error(
      "invariant registry: §8 exists but carries no |Invariant|Enforcer|Runs in| table"
    );
  }

  const rows = [];
  for (const line of tableLines) {
    const cells = splitRow(line);
    if (cells.length !== 3) {
      throw new Error(`invariant registry: row does not have exactly 3 cells: ${line}`);
    }
    if (isSeparatorRow(cells)) continue;
    const [invariant, enforcer, runsIn] = cells;
    if (/^invariant$/i.test(invariant)) continue; // header row
    rows.push({
      invariant,
      enforcer,
      runsIn,
      enforcerPaths: [...enforcer.matchAll(ENFORCER_PATH_RE)].map((m) => m[1]),
      pending: /\bpending\b/i.test(runsIn),
    });
  }
  if (rows.length === 0) {
    throw new Error("invariant registry: table parsed to zero data rows");
  }
  return rows;
}

// loadInvariantRegistry(repoRoot) → rows from docs/ENGINEERING-CONSTITUTION.md.
export function loadInvariantRegistry(repoRoot) {
  return parseInvariantRegistry(readFileSync(path.join(repoRoot, CONSTITUTION_RELPATH), "utf8"));
}
