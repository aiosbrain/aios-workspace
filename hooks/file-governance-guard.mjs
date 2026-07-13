#!/usr/bin/env node
// file-governance-guard.mjs — PreToolUse hook (AIO-352) — anti-sprawl ratchet, layer 1.
//
// Fires on Write/Edit/MultiEdit tool calls. When a NEW markdown/content file is being
// created it checks two things, purely deterministically (no LLM, no network):
//   (a) does the path land inside a sanctioned root — the numbered spine (0-5, plus
//       6-business when a workspace has one), .claude/, or the toolkit allowlist
//       (scripts/, hooks/, validation/, bin/, dotfiles)?
//   (b) does the file open with a YAML frontmatter block that carries at least one
//       tier-ish field (`status:` or `access:`), per scaffold/.claude/rules/frontmatter.md?
//
// Default posture is WARN, not block: print an advisory to stderr and allow the write.
// A workspace can opt into hard-blocking via `.aios/file-governance.json`:
//   { "mode": "block" }
// or by flipping DEFAULT_MODE below (this is the "config flag" the layer-1 spec asks for).
//
// HARD RULE: this hook must NEVER disturb a session over its own bugs. Everything is
// wrapped in try/catch and the process exit code defaults to 0 (allow) unless the
// classification genuinely calls for BLOCK in "block" mode. A missed check (malformed
// stdin, unreadable config, unexpected tool_input shape) is acceptable; crashing or
// hanging a session is not.
//
// The pure classification functions (classifyPath, checkFrontmatter, isContentFile,
// isFrontmatterExempt) are exported so the layer-2 validator (validation/check-
// file-governance.mjs, OGR14) and unit tests can reuse the exact same rules — the hook
// and the validator must never drift on what counts as "sanctioned".

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STDIN_MAX = 1_000_000;
const DEFAULT_MODE = "warn"; // "warn" | "block" — the in-file escalation switch
const CONFIG_REL = ".aios/file-governance.json";

// ── Sanctioned top-level roots ─────────────────────────────────────────────

// The numbered spine (new intent-named + legacy numbered aliases), plus 6-business
// (accepted whenever present; not required — a sibling PR may add it to scaffold-
// project.sh later, and workspaces stamped before that still validate clean).
export const SPINE_TOP_LEVEL = new Set([
  "0-context",
  "1-inbox",
  "2-work",
  "3-log",
  "4-shared",
  "5-personal",
  "6-business",
  // legacy numbered spine
  "00-project",
  "00-engagement",
  "01-intake",
  "02-deliverables",
  "03-status",
  "04-shared",
  "04-client-surface",
  "06-client-surface",
  "05-workspace",
  "05-personal",
]);

// Toolkit-owned top-level directories a scaffolded workspace ships with.
export const TOOLKIT_TOP_LEVEL = new Set([
  "scripts",
  "hooks",
  "validation",
  "bin",
  "templates", // sanctioned when a workspace/toolkit variant scaffolds one
  // toolkit-repo-only dev dirs (not shipped into a scaffolded workspace, but harmless
  // to allow here too — this module also backs OGR14 which can run against this repo)
  "gui",
  "src-tauri",
  "docs",
  "test",
  "examples",
]);

// Known root-level files a scaffolded workspace ships (non-dotfiles).
export const ROOT_FILE_ALLOWLIST = new Set([
  "README.md",
  "AGENTS.md",
  "RESOLVER.md",
  "CLAUDE.md",
  "aios.yaml",
  "workspace.yaml",
  "project.yaml",
  "engagement.yaml",
  "contacts.yaml",
  "package.json",
  "opencode.json",
  ".aios-toolkit-version",
  "CODEOWNERS",
]);

const CONTENT_EXT_RE = /\.(md|mdx)$/i;

const FRONTMATTER_EXEMPT_NAMES = new Set([
  "README.md",
  "CLAUDE.md",
  "MEMORY.md",
  "AGENTS.md",
  "RESOLVER.md",
  "decision-log.md",
  "hours-log.md",
  "tasks.md",
  "learnings.md",
  "client-surface-log.md",
  "index.md",
]);

export function isContentFile(relPath) {
  return CONTENT_EXT_RE.test(String(relPath ?? ""));
}

export function isFrontmatterExempt(basename) {
  const b = String(basename ?? "");
  if (FRONTMATTER_EXEMPT_NAMES.has(b)) return true;
  if (/^hours-log-.*\.md$/.test(b)) return true;
  return false;
}

/**
 * Classify a workspace-relative path as inside/outside the sanctioned roots.
 * Never throws. `relPath` should already be relative to the workspace root.
 */
export function classifyPath(relPath) {
  const norm = String(relPath ?? "")
    .replace(/^\.\//, "")
    .replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length === 0) return { allowed: true };

  const top = parts[0];
  if (top.startsWith(".")) return { allowed: true }; // dotfiles/dirs — toolkit hydration

  if (parts.length === 1) {
    // A root-level file.
    if (ROOT_FILE_ALLOWLIST.has(top)) return { allowed: true };
    if (SPINE_TOP_LEVEL.has(top) || TOOLKIT_TOP_LEVEL.has(top)) return { allowed: true };
    return {
      allowed: false,
      reason:
        `"${top}" is not a recognized root file (spine dirs, .claude/, scripts/hooks/` +
        `validation/bin, or a known toolkit file). Route content into the numbered spine ` +
        `(0-context .. 5-personal, 6-business) instead.`,
    };
  }

  if (SPINE_TOP_LEVEL.has(top) || TOOLKIT_TOP_LEVEL.has(top)) return { allowed: true };

  return {
    allowed: false,
    reason:
      `"${top}/" is not a sanctioned top-level directory. Route this file into the ` +
      `numbered spine (0-context, 1-inbox, 2-work, 3-log, 4-shared, 5-personal, or ` +
      `6-business when scaffolded) instead of a new ad-hoc top-level dir.`,
  };
}

/**
 * Structural-minimum frontmatter check (deliberately shallow — the OGR02 validator
 * enforces the fuller per-directory field requirements from
 * scaffold/.claude/rules/frontmatter.md; this just catches "no frontmatter at all" and
 * "frontmatter with no tier signal" at write time).
 */
export function checkFrontmatter(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i] === undefined || lines[i].trim() !== "---") {
    return { hasBlock: false, hasTierField: false };
  }
  let closeIdx = -1;
  for (let j = i + 1; j < lines.length && j < i + 200; j++) {
    if (lines[j].trim() === "---") {
      closeIdx = j;
      break;
    }
  }
  if (closeIdx === -1) return { hasBlock: false, hasTierField: false };
  const block = lines.slice(i + 1, closeIdx).join("\n");
  const hasTierField = /^\s*(access|status)\s*:/m.test(block);
  return { hasBlock: true, hasTierField };
}

function loadConfig(root) {
  try {
    const raw = readFileSync(path.join(root, CONFIG_REL), "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      mode: parsed.mode === "block" ? "block" : parsed.mode === "warn" ? "warn" : DEFAULT_MODE,
    };
  } catch {
    return { enabled: true, mode: DEFAULT_MODE };
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > STDIN_MAX) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // no/garbage stdin — allow
  }
  if (!payload || typeof payload !== "object") return;

  const toolName = payload.tool_name;
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") return;

  const input = payload.tool_input || {};
  const filePath = input.file_path || input.path;
  if (!filePath || typeof filePath !== "string") return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..")) return; // outside the project root — not ours to police

  if (!isContentFile(rel)) return;

  // Only govern brand-new files. Edit/MultiEdit require an existing file (Claude Code's
  // own tool contract), so they're never a "new file" creation; Write on an existing
  // path is an overwrite, not a creation.
  let existedBefore = false;
  try {
    existedBefore = existsSync(abs);
  } catch {
    return; // can't tell — fail open
  }
  if (toolName !== "Write" || existedBefore) return;

  const config = loadConfig(root);
  if (!config.enabled) return;

  const warnings = [];
  const pathResult = classifyPath(rel);
  if (!pathResult.allowed) warnings.push(pathResult.reason);

  const basename = path.basename(rel);
  if (!isFrontmatterExempt(basename)) {
    const content = typeof input.content === "string" ? input.content : "";
    const fm = checkFrontmatter(content);
    if (!fm.hasBlock) {
      warnings.push(
        "missing YAML frontmatter block (see scaffold/.claude/rules/frontmatter.md — " +
          "every non-trivial markdown file should open with `---\\nstatus: draft\\n---`)."
      );
    } else if (!fm.hasTierField) {
      warnings.push(
        "frontmatter present but has no `status:`/`access:` tier field — untagged " +
          "content never syncs (default-deny), which is probably not what you want."
      );
    }
  }

  if (warnings.length === 0) return;

  const mode = config.mode === "block" ? "block" : "warn";
  const label = mode === "block" ? "BLOCKED" : "WARN";
  const message =
    `[file-governance-guard] ${label}: ${rel}\n` + warnings.map((w) => `  - ${w}`).join("\n");

  process.stderr.write(message + "\n");
  if (mode === "block") process.exitCode = 2;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main()
    .catch(() => {})
    .finally(() => {
      if (process.exitCode !== 2) process.exitCode = 0;
    });
}
