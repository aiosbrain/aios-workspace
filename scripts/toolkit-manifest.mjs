/**
 * toolkit-manifest.mjs — the single source of truth for what is TOOLKIT (managed,
 * synced from upstream) vs PERSONAL (owned by the workspace, never touched).
 *
 * A scaffolded workspace VENDORS the toolkit — it carries its own copy so it is
 * self-contained, offline-capable, and version-pinned. `aios update` re-vendors
 * these managed paths from the canonical toolkit; everything else is the person's.
 *
 * INVARIANT: toolkit changes are made UPSTREAM in `aios-workspace`, never in a
 * personal fork. `aios update` is the one-way flow upstream → fork.
 *
 * Zero dependencies.
 */

/**
 * Managed paths — copied from the toolkit into a workspace. `dest` is
 * workspace-relative; `src` is toolkit-repo-relative. This list is kept in lockstep
 * with what `scaffold-project.sh` writes into a fresh workspace — the two are the
 * single definition of "the workspace toolkit surface".
 *
 * WHY the CLI is NOT here: `scripts/aios.mjs` is a thin **shim** that forwards every
 * command to the one canonical toolkit checkout (see scaffold/scripts/aios.mjs). So the
 * CLI stays current automatically — you never vendor the full CLI (it needs node_modules
 * deps like @anthropic-ai/sdk and would crash in a workspace). We only sync the shim
 * itself + the in-place governance (skills/rules/hooks/validators) that Claude Code and
 * the validators read directly.
 *
 * Directory entries are an OVERLAY (toolkit files overwrite matches, personal additions
 * — e.g. your own skills — are kept). Hooks/validation are specific files, matching the
 * scaffold, so a workspace never inherits the toolkit's dev-only hooks.
 */
export const MANAGED_PATHS = [
  // The delegating shim + launcher — how a workspace reaches the canonical toolkit.
  { dest: "scripts/aios.mjs", src: "scaffold/scripts/aios.mjs", kind: "file", exec: true },
  { dest: "bin/aios", src: "scaffold/bin/aios", kind: "file", exec: true },
  // Governance read in-place by Claude Code (overlay — personal skills/rules preserved).
  { dest: ".claude/rules", src: "scaffold/.claude/rules", kind: "dir" },
  { dest: ".claude/skills", src: "scaffold/.claude/skills", kind: "dir" },
  { dest: ".claude/rubrics", src: "scaffold/.claude/rubrics", kind: "dir" },
  { dest: ".claude/commands", src: "scaffold/.claude/commands", kind: "dir" },
  { dest: ".claude/personalities", src: "scaffold/.claude/personalities", kind: "dir" },
  { dest: ".claude/agents", src: "scaffold/.claude/agents", kind: "dir" },
  { dest: ".claude/descriptors", src: "scaffold/.claude/descriptors", kind: "dir" },
  // Claude Code settings that register the shipped hooks (personal overrides live in
  // .claude/settings.local.json, which stays PERSONAL). Verbatim copy — safe to manage.
  { dest: ".claude/settings.json", src: "scaffold/.claude/settings.json", kind: "file" },
  // Skill/doc router + routing fixtures — shipped into the workspace, updated on sync.
  { dest: "RESOLVER.md", src: "scaffold/RESOLVER.md.tmpl", kind: "file" },
  {
    dest: ".claude/resolver-fixtures.yaml",
    src: "scaffold/.claude/resolver-fixtures.yaml",
    kind: "file",
  },
  // Standalone guardrail hooks + validator data shipped into the workspace (exact files).
  { dest: "hooks/team-ops-guard.sh", src: "hooks/team-ops-guard.sh", kind: "file", exec: true },
  { dest: "hooks/asks-capture.mjs", src: "hooks/asks-capture.mjs", kind: "file", exec: true },
  {
    dest: "hooks/decision-capture.mjs",
    src: "hooks/decision-capture.mjs",
    kind: "file",
    exec: true,
  },
  { dest: "hooks/session-pulse.mjs", src: "hooks/session-pulse.mjs", kind: "file", exec: true },
  {
    dest: "hooks/file-governance-guard.mjs",
    src: "hooks/file-governance-guard.mjs",
    kind: "file",
    exec: true,
  },
  { dest: "validation/secret-patterns.txt", src: "validation/secret-patterns.txt", kind: "file" },
];

/**
 * Personal paths — a workspace's own content + identity + local state. `aios update`
 * MUST NOT read or write these. Listed for the guard/tests and for documentation;
 * the updater is safe by construction (it only ever writes MANAGED_PATHS.dest).
 */
export const PERSONAL_PATHS = [
  "0-context",
  "1-inbox",
  "2-work",
  "3-log",
  "4-shared",
  "5-personal",
  "aios.yaml",
  "workspace.yaml",
  "contacts.yaml",
  ".env",
  ".env.keys",
  ".env.example",
  ".claude/memory",
  ".claude/settings.local.json",
  "CLAUDE.md",
  "AGENTS.md",
  ".git",
  ".aios",
  "node_modules",
];

/**
 * Toolkit paths that `scaffold-project.sh` writes into a fresh workspace but `aios update`
 * deliberately does NOT sync — because they are per-machine hydration/config, generated
 * catalogs, or stamp-time-templated files that can't be blind-overlaid. They are neither
 * "managed" (synced) nor "personal" (a person's own content). Listed explicitly so the
 * manifest↔scaffold parity test can prove every scaffold-written path is classified into
 * exactly one bucket — no silent third category. Update this list when the scaffold
 * starts (or stops) writing one of these.
 */
export const SCAFFOLD_UNMANAGED = [
  ".envrc", // direnv loader — machine/env hydration
  ".mcp.json", // MCP wiring — hydrated per machine, gitignored
  ".mcp.example.json", // MCP example stub
  "opencode.json", // opencode runtime config — hydration
  ".opencode", // opencode export surface — hydration
  ".claude/integrations.json", // generated per-workspace by gen-catalog
  ".aios-toolkit-version", // the sync stamp itself (workspace state, not content)
  ".github", // CI/workflows are toolkit-dev-only; not shipped-then-synced
  ".planning", // scaffolded empty; a person's own planning space
  "CODEOWNERS", // repo-ownership file, stamped once
  // Stamp-time TEMPLATED files: toolkit origin, but personalized on scaffold, so they
  // can't be blind-overlaid (that would clobber the personalization).
  ".claude/CLAUDE.md",
  ".gitignore",
  "package.json",
  "README.md",
];

/** The version stamp a workspace writes to record which toolkit it last synced. */
export const VERSION_FILE = ".aios-toolkit-version";
