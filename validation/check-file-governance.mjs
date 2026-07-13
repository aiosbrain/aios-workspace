#!/usr/bin/env node
// check-file-governance.mjs — OGR14: anti-sprawl ratchet, layer 2 (AIO-352).
//
// Layer 1 (hooks/file-governance-guard.mjs) catches sprawl at write time; this is the
// commit/CI-time backstop for anything that slipped through (files written outside
// Claude Code, merges, hand edits). Two checks against the SAME pure classification
// rules the hook uses (imported, not reimplemented, so the two layers never drift):
//
//   1. Top-level directory/file allowlist — every entry directly under the workspace
//      root must be a spine dir (0-context .. 5-personal, 6-business when present), a
//      toolkit dir (.claude/, scripts/, hooks/, validation/, bin/), or a known root
//      file/dotfile. Anything else is a WARNING with a routing hint (advisory —
//      doesn't fail the run; this is a ratchet, not a wall).
//   2. Frontmatter structural check across content files (.md/.mdx) — same structural
//      minimum as the hook (frontmatter block exists + a status/access tier field).
//      This is deliberately shallower than OGR02 (which enforces the fuller
//      per-directory field requirements) — OGR14 is the sprawl ratchet, OGR02 stays
//      the frontmatter authority.
//
// Usage: ./validation/check-file-governance.mjs <path-to-workspace-repo>
// Wired into validate-all.sh as OGR14.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  classifyPath,
  checkFrontmatter,
  isContentFile,
  isFrontmatterExempt,
} from "../hooks/file-governance-guard.mjs";

const RED = "\x1b[0;31m",
  YELLOW = "\x1b[1;33m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";

const repo = process.argv[2];
if (!repo) {
  console.error("Usage: check-file-governance.mjs <path-to-workspace-repo>");
  process.exit(1);
}

console.log(`OGR14: Checking file-creation governance (anti-sprawl ratchet) in ${repo}`);
console.log("================================================");

let errors = 0;
let warnings = 0;

// ── Check 1: top-level allowlist ───────────────────────────────────────────

console.log("Top-level allowlist:");
let topEntries = [];
try {
  topEntries = readdirSync(repo).sort();
} catch (e) {
  console.error(`${RED}Error: Directory not found: ${repo}${NC}`);
  process.exit(1);
}

for (const name of topEntries) {
  // classifyPath disambiguates "root file" vs "top-level directory" by path depth —
  // probe with a synthetic child so a real top-level directory hits the directory
  // branch (and its message) rather than the root-file one.
  let isDir = false;
  try {
    isDir = statSync(path.join(repo, name)).isDirectory();
  } catch {
    /* stat failed (broken symlink etc.) — treat as a file for classification */
  }
  const result = classifyPath(isDir ? `${name}/.` : name);
  if (result.allowed) {
    console.log(`  ${GREEN}✓${NC} ${name}${isDir ? "/" : ""}`);
  } else {
    console.log(`  ${YELLOW}!${NC} ${name}${isDir ? "/" : ""} — ${result.reason}`);
    warnings++;
  }
}

// ── Check 2: frontmatter structural minimum across content files ──────────

console.log("");
console.log("Frontmatter structural minimum (.md/.mdx):");

// .claude/ carries its own frontmatter conventions (skill name/description, agent
// frontmatter, etc.) — not the workspace-content status/access tiers this check is
// about. OGR02 (check-frontmatter.sh) excludes it for the same reason; mirror that.
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".aios",
  ".planning",
  ".opencode",
  ".claude",
]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && isContentFile(entry.name)) {
      out.push(full);
    }
  }
}

const contentFiles = [];
walk(repo, contentFiles);
contentFiles.sort();

let checked = 0;
let skipped = 0;

for (const file of contentFiles) {
  const rel = path.relative(repo, file);
  const basename = path.basename(file);

  // Mirror OGR02: skip trivial/empty files.
  let lineCount = 0;
  let content = "";
  try {
    content = readFileSync(file, "utf8");
    lineCount = content.split(/\r?\n/).length;
  } catch {
    continue;
  }
  if (lineCount < 3) {
    skipped++;
    continue;
  }
  if (isFrontmatterExempt(basename)) {
    skipped++;
    continue;
  }

  checked++;
  const fm = checkFrontmatter(content);
  if (!fm.hasBlock) {
    console.log(`  ${YELLOW}!${NC} ${rel} — no frontmatter block`);
    warnings++;
  } else if (!fm.hasTierField) {
    console.log(`  ${YELLOW}!${NC} ${rel} — frontmatter present but missing status/access field`);
    warnings++;
  }
}

console.log("");
console.log(`Checked: ${checked} files | Skipped: ${skipped} files`);

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("");
console.log("================================================");
if (errors === 0 && warnings === 0) {
  console.log(`${GREEN}OGR14 PASSED — no sprawl detected${NC}`);
  process.exit(0);
} else if (errors === 0) {
  console.log(`${YELLOW}OGR14 PASSED with ${warnings} warning(s)${NC}`);
  process.exit(0);
} else {
  console.log(`${RED}OGR14 FAILED — ${errors} error(s), ${warnings} warning(s)${NC}`);
  process.exit(1);
}
