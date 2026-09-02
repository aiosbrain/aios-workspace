#!/usr/bin/env node
/**
 * check-retired-routes.mjs — AIO-1072: retired connector routes must stay retired.
 *
 * AIO-1067/AIO-1068 replaced the skill-vendored provider clients (the aios-linear
 * skill's linear.mjs, the linear-direct descriptor CLIs, the slack-personal
 * slack.py + slack-activity-pull.mjs) with the one connector implementation under
 * scripts/connectors/, reached via `aios linear` / `aios slack` (and the governed
 * v3.0.0-boundary compat delegates scripts/linear.mjs / scripts/slack.mjs). The
 * cutover deletes the retired clients; this gate keeps them gone — a re-vendored
 * copy or a script that quietly spawns one would silently fork the connector
 * surface again.
 *
 * The gate rejects EXECUTABLE ownership only, never prose. Three rules:
 *   R1  No file may exist at a retired client path, at any depth:
 *         .claude/skills/aios-linear/linear.mjs
 *         .claude/descriptors/skills/linear-direct/<any>.mjs
 *         .claude/descriptors/skills/slack-personal/slack.py
 *         .claude/descriptors/skills/slack-personal/slack-activity-pull.mjs
 *   R2  No .mjs/.js/.cjs/.sh file outside the allowlist may import, require, or
 *       spawn a retired client (patterns: skills/aios-linear/linear.mjs,
 *       linear-query-client, slack.py, slack-activity-pull). Executable context
 *       only: for JS the pattern must sit on an import/require/spawn-family call
 *       line; for .sh, on a non-comment line. Markdown files and comment lines
 *       never fail the gate.
 *   R3  No .py provider client may live under a .claude/skills or
 *       .claude/descriptors tree (there must be none). "Provider client" is
 *       name-scoped: the sub-path under .claude mentions slack or linear — a
 *       skill's unrelated Python tooling (e.g. evolve's analyze_history.py) is
 *       not a connector route and is not this gate's business.
 *
 * Allowlist (never flagged): scripts/linear.mjs and scripts/slack.mjs (the
 * governed compat delegates), scripts/connectors/**, this gate + its test,
 * CHANGELOG.md, docs/architecture/cli-command-inventory.v1.json.
 *
 * Repo root comes from this file's own location (argv[2] overrides, for tests),
 * never from process.cwd(). Dependency-free (node builtins only), so it runs in
 * CI before `npm ci` like the rest of the `constitution` job.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitFiles } from "./git-files.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(SCRIPT_DIR, ".."));

// Enumeration is git-authoritative (scripts/git-files.mjs — tracked + untracked-not-
// ignored, so .gitignore is honored and ignored build trees are structurally invisible;
// the AIO-517 rule). The readdir walk below is the FALLBACK for non-git targets only
// (the test suite's throwaway fixture sandboxes).
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);
const SKIP_REL_DIRS = new Set(["test/fixtures"]);

// R1 — retired client paths (matched against the /-normalized relative path).
const RETIRED_PATHS = [
  /(^|\/)\.claude\/skills\/aios-linear\/linear\.mjs$/,
  /(^|\/)\.claude\/descriptors\/skills\/linear-direct\/[^/]+\.mjs$/,
  /(^|\/)\.claude\/descriptors\/skills\/slack-personal\/slack\.py$/,
  /(^|\/)\.claude\/descriptors\/skills\/slack-personal\/slack-activity-pull\.mjs$/,
];

// R2 — retired client references that mean executable ownership when they sit
// in an import/require/spawn context.
const RETIRED_REFS = [
  { label: "skills/aios-linear/linear.mjs", re: /skills\/aios-linear\/linear\.mjs/ },
  { label: "linear-query-client", re: /linear-query-client/ },
  { label: "slack.py", re: /slack\.py\b/ },
  { label: "slack-activity-pull", re: /slack-activity-pull/ },
];

// Executable context for JS: an import statement (including the bare `from "…"`
// continuation line of a multi-line import), require(), dynamic import(), or a
// spawn-family child_process call. Prose and plain string assignments don't match.
const JS_EXEC_CONTEXT =
  /(^\s*import\b|\bimport\s*\(|\bfrom\s+["']|\brequire\s*\(|\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\()/;

// Allowlist — never flagged by R2 (exact relative POSIX paths + prefixes).
const ALLOW_FILES = new Set([
  "scripts/linear.mjs",
  "scripts/slack.mjs",
  "scripts/check-retired-routes.mjs",
  "test/check-retired-routes.test.mjs",
  "CHANGELOG.md",
  "docs/architecture/cli-command-inventory.v1.json",
]);
const ALLOW_PREFIXES = ["scripts/connectors/"];

const SCAN_EXTS = new Set([".mjs", ".js", ".cjs", ".sh"]);

function isAllowed(rel) {
  return ALLOW_FILES.has(rel) || ALLOW_PREFIXES.some((p) => rel.startsWith(p));
}

function* walk(dir, rel = "") {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_REL_DIRS.has(entryRel)) continue;
      yield* walk(path.join(dir, entry.name), entryRel);
    } else if (entry.isFile()) {
      yield entryRel;
    }
  }
}

/** Repo-relative POSIX paths: git-authoritative, walk fallback for non-git sandboxes. */
function listFiles(root) {
  const fromGit = gitFiles(root);
  if (fromGit) {
    return fromGit.filter(
      (p) => !p.startsWith("test/fixtures/") && !SKIP_DIRS.has(p.split("/")[0])
    );
  }
  return [...walk(root)];
}

function isCommentLine(line, ext) {
  const t = line.trimStart();
  if (ext === ".sh") return t.startsWith("#");
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// scanFile(abs, ext) → [{ line, label }] executable references to retired clients.
function scanFile(abs, ext) {
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line, ext)) continue; // prose in a comment never fails the gate
    if (ext !== ".sh" && !JS_EXEC_CONTEXT.test(line)) continue; // JS: exec context only
    for (const { label, re } of RETIRED_REFS) {
      if (re.test(line)) hits.push({ line: i + 1, label });
    }
  }
  return hits;
}

const violations = [];
for (const posix of listFiles(repo)) {
  const ext = path.extname(posix);

  // R1 — a retired client path exists at all.
  if (RETIRED_PATHS.some((re) => re.test(posix))) {
    violations.push(`${posix} — retired client path exists (must stay deleted, AIO-1072)`);
    continue; // its contents need no second finding
  }

  // R3 — a .py provider client under a .claude/skills or .claude/descriptors tree.
  // Provider-scoped by name (slack/linear in the sub-path under .claude) so a
  // skill's unrelated Python tooling never trips the gate.
  const claudeTree = posix.match(/(^|\/)\.claude\/(skills|descriptors)\/(.+)$/);
  if (ext === ".py" && claudeTree && /(slack|linear)/i.test(claudeTree[3])) {
    violations.push(
      `${posix} — .py provider client under a .claude skills/descriptors tree (none may exist)`
    );
    continue;
  }

  // R2 — executable reference to a retired client from outside the allowlist.
  if (!SCAN_EXTS.has(ext) || isAllowed(posix)) continue;
  for (const { line, label } of scanFile(path.join(repo, posix), ext)) {
    violations.push(`${posix}:${line} — imports/spawns retired client (${label})`);
  }
}

if (violations.length > 0) {
  console.error("✗ retired connector routes are back in executable use (AIO-1072):\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\n  The skill-vendored provider clients are retired. Route Linear through\n" +
      "  `aios linear` and Slack through `aios slack` (scripts/connectors/**), or the\n" +
      "  governed compat delegates scripts/linear.mjs / scripts/slack.mjs.\n" +
      "  Prose mentions (markdown, comments) are fine — this gate flags files at\n" +
      "  retired paths and import/require/spawn references only.\n" +
      "  Deliberate exceptions require editing scripts/check-retired-routes.mjs itself."
  );
  process.exit(1);
}
console.log("✓ no retired connector routes in executable use (paths clean, no imports/spawns)");
