/**
 * toolkit-manifest.mjs — the single source of truth for what is TOOLKIT (managed,
 * synced from upstream) vs SEED_IF_ABSENT (create-only starter files) vs
 * PERSONAL (owned by the workspace, never overwritten) vs SCAFFOLD_UNMANAGED.
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
export const CI_WORKFLOW_MANAGED_PATHS = [
  {
    dest: ".github/workflows/scan-on-merge.yml",
    src: "scaffold/.github/workflows/scan-on-merge.yml",
    kind: "file",
  },
  {
    dest: ".github/scripts/fetch-brain-scanner.sh",
    src: "scaffold/.github/scripts/fetch-brain-scanner.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: ".github/scripts/scan_with_health.py",
    src: "scaffold/.github/scripts/scan_with_health.py",
    kind: "file",
  },
];

export const MANAGED_PATHS = [
  // The delegating shim + launcher — how a workspace reaches the canonical toolkit.
  { dest: "scripts/aios.mjs", src: "scaffold/scripts/aios.mjs", kind: "file", exec: true },
  { dest: "bin/aios", src: "scaffold/bin/aios", kind: "file", exec: true },
  // The three `pmTool: "linear"` entries below are split OUT of the wholesale .claude/rules
  // and .claude/skills overlays so a workspace whose aios.yaml says `pm_tool: clickup` (or
  // `none`) never receives Linear-specific governance in its agent's context (AIO-844). Each
  // one must sit BEFORE the dir entry that would otherwise cover it: toolkit-contribute.mjs
  // returns on FIRST match, and the dir branch would misreport them as `excluded: true`.
  {
    dest: ".claude/rules/linear-factory.md",
    src: "scaffold/.claude/rules/linear-factory.md",
    kind: "file",
    pmTool: "linear",
  },
  // Governance read in-place by Claude Code (overlay — personal skills/rules preserved).
  // access-control.md is excluded: it's stamp-time PERSONALIZED (workspaces customize
  // the tier table, team names, context aliases), so blind-overlaying it clobbers
  // legitimate per-workspace divergence and pins the stamp forever on a permanent
  // no-base conflict (AIO-351 dogfood finding on john-workspace).
  {
    dest: ".claude/rules",
    src: "scaffold/.claude/rules",
    kind: "dir",
    exclude: ["access-control.md", "linear-factory.md"],
  },
  {
    dest: ".claude/skills/aios-linear",
    src: "scaffold/.claude/skills/aios-linear",
    kind: "dir",
    pmTool: "linear",
  },
  { dest: ".claude/skills", src: "scaffold/.claude/skills", kind: "dir", exclude: ["aios-linear"] },
  // The spec-readiness rubric is deliberately NOT vendored under scaffold/ — `src` is
  // toolkit-repo-relative and may point outside it (see validation/secret-patterns.txt and
  // every hooks/ entry), so this syncs the ONE canonical copy rather than creating a second
  // file to keep byte-identical. It is ungated: spec quality is PM-tool-agnostic.
  {
    dest: ".claude/rubrics/spec-readiness.md",
    src: ".claude/rubrics/spec-readiness.md",
    kind: "file",
  },
  { dest: ".claude/rubrics", src: "scaffold/.claude/rubrics", kind: "dir" },
  // The issue template `linear-factory.md` tells the agent to author from, and the exact path
  // resolveLinearTemplate() looks for (.claude/skills/aios-linear/linear-template.mjs). Same
  // no-duplicate reasoning as the rubric above.
  {
    dest: "docs/agentic-ergonomics/aios-issue-template.md",
    src: "docs/agentic-ergonomics/aios-issue-template.md",
    kind: "file",
    pmTool: "linear",
  },
  { dest: ".claude/commands", src: "scaffold/.claude/commands", kind: "dir" },
  { dest: ".claude/personalities", src: "scaffold/.claude/personalities", kind: "dir" },
  { dest: ".claude/agents", src: "scaffold/.claude/agents", kind: "dir" },
  { dest: ".claude/descriptors", src: "scaffold/.claude/descriptors", kind: "dir" },
  // Claude Code settings that register the shipped hooks (personal overrides live in
  // .claude/settings.local.json, which stays PERSONAL). Verbatim copy — safe to manage.
  { dest: ".claude/settings.json", src: "scaffold/.claude/settings.json", kind: "file" },
  // Brain reporting CI. MANAGED rather than stamped-once because both the pinned Team Brain
  // scanner SHA and the `@aiosbrain/aios` version range in the workflow go stale — a workspace
  // that never re-syncs would keep scanning against a frozen sidecar. File entries, not a dir
  // overlay, so a person's own workflows in .github/ are never touched.
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
    dest: "hooks/asks-claim-recovery.cjs",
    src: "hooks/asks-claim-recovery.cjs",
    kind: "file",
    exec: true,
  },
  {
    dest: "hooks/decision-capture.mjs",
    src: "hooks/decision-capture.mjs",
    kind: "file",
    exec: true,
  },
  { dest: "hooks/session-pulse.mjs", src: "hooks/session-pulse.mjs", kind: "file", exec: true },
  {
    dest: "hooks/claim-check-guard.mjs",
    src: "hooks/claim-check-guard.mjs",
    kind: "file",
    exec: true,
  },
  {
    dest: "hooks/aios-sync-nudge.sh",
    src: "hooks/aios-sync-nudge.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "hooks/file-governance-guard.mjs",
    src: "hooks/file-governance-guard.mjs",
    kind: "file",
    exec: true,
  },
  // AIO-482: SessionStart adapter that re-hydrates a worktree created by a tool
  // that never called `aios worktree add` (Conductor et al). MANAGED so existing
  // workspaces pick it up on `aios update` and self-heal without re-scaffolding.
  {
    dest: "hooks/worktree-self-heal.mjs",
    src: "hooks/worktree-self-heal.mjs",
    kind: "file",
    exec: true,
  },
  // Claude Code statusLine command: context/rate-limit usage in the terminal footer.
  {
    dest: "hooks/statusline-command.mjs",
    src: "hooks/statusline-command.mjs",
    kind: "file",
    exec: true,
  },
  // AIO-864: the Cursor cross-repo toolkit guard (.cursor/hooks.json +
  // guard-toolkit-primary.sh + toolkit-primary-tripwire.sh) was REMOVED from this list.
  // Rationale in scripts/scaffold-project.sh. Keeping the entries here is what would
  // undo the fix: MANAGED means `aios update` re-seeds the files into every workspace
  // that already deleted them, which is exactly how the guard came back after being
  // disabled once. Dropping them here stops the re-seed but does NOT clean up the copies
  // already on disk — mergeManaged only ever visits the entries it is given, so a path
  // simply deleted from this list becomes permanently unmanaged. RETIRED_PATHS below is
  // what actually removes them.
  { dest: "validation/secret-patterns.txt", src: "validation/secret-patterns.txt", kind: "file" },
  // AIO-965 — the validators the scaffolded `.claude/` docs CITE. Until this list existed, a
  // workspace shipped the rules ("OGR05 checks that every instinct links a real incident") and
  // none of the scripts that make them true, so an agent read "this is enforced", believed it,
  // and proceeded. A claimed check that does not run reads exactly like a passing one.
  //
  // These are file entries, not a `validation` dir overlay, for the same reason hooks are:
  // a workspace's OWN validators (john-workspace has check-ledger.sh + check-manifest.sh,
  // neither of which exists upstream) must survive every update. A dir overlay preserves
  // personal additions too, but file entries make the shipped surface auditable — which is
  // precisely what check-citations.mjs below grades.
  //
  // Kept in lockstep with scripts/scaffold-project.sh; OGR16 fails the build if they diverge.
  {
    dest: "validation/validate-all.sh",
    src: "validation/validate-all.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-frontmatter.sh",
    src: "validation/check-frontmatter.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-rubrics.sh",
    src: "validation/check-rubrics.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-secrets.sh",
    src: "validation/check-secrets.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-structure.sh",
    src: "validation/check-structure.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-aios-config.sh",
    src: "validation/check-aios-config.sh",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-skill-export.mjs",
    src: "validation/check-skill-export.mjs",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-file-governance.mjs",
    src: "validation/check-file-governance.mjs",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/check-agent-readiness.mjs",
    src: "validation/check-agent-readiness.mjs",
    kind: "file",
    exec: true,
  },
  {
    dest: "validation/agent-readiness-lib.mjs",
    src: "validation/agent-readiness-lib.mjs",
    kind: "file",
  },
  {
    dest: "validation/agent-readiness.rubric.json",
    src: "validation/agent-readiness.rubric.json",
    kind: "file",
  },
  {
    dest: "validation/check-citations.mjs",
    src: "validation/check-citations.mjs",
    kind: "file",
    exec: true,
  },
  // Helper modules the validators above import as `../scripts/<name>.mjs`. In THIS repo those
  // two paths are back-compat shims that re-export from packages/foundation (AIO-601); a
  // workspace has no packages/ tree, so syncing the shim would vendor an import of a directory
  // that isn't there. `src` therefore points at the real module and `dest` keeps the path the
  // importers already use — the consumers work unchanged in both trees, with no dual-path
  // resolution logic in the validators. Both are dependency-free (node builtins only), which is
  // what makes them safe to run in a workspace that has never seen an `npm install`.
  {
    dest: "scripts/git-files.mjs",
    src: "packages/foundation/src/git-files.mjs",
    kind: "file",
  },
  {
    dest: "scripts/runtimes.mjs",
    src: "packages/foundation/src/runtimes.mjs",
    kind: "file",
  },
];

/**
 * Toolkit files that were WITHDRAWN — they used to be MANAGED, ship no longer, and must be
 * removed from workspaces that already vendored them.
 *
 * Deleting an entry from MANAGED_PATHS is not enough on its own. `mergeManaged` iterates
 * only the entry lists it is handed, so a path that leaves MANAGED_PATHS is never visited
 * again: it stops being re-seeded, but the copy already in the workspace survives every
 * subsequent `aios update`, permanently unmanaged. `applyDeletions` cannot cover it either —
 * it walks `kind: "dir"` entries only, and these are file entries whose parent directory the
 * toolkit no longer ships at all.
 *
 * So a withdrawal is TWO edits: remove the entry from MANAGED_PATHS, and add it here with the
 * `src` it used to sync from. `src` is a HISTORICAL path — it does not exist in the toolkit
 * working tree any more, and is used only to read the file's content at the workspace's pinned
 * base sha, which is what an untouched vendored copy must equal.
 *
 * Safety is applyDeletions' rule: `mine === base` removes it, anything else is a local edit
 * the owner keeps (reported, never deleted). Entries stay here permanently — they are cheap
 * (one `git show` each against a path that is usually already gone from the base tree, which
 * short-circuits to "keep nothing to do") and removing one would strand any workspace that
 * had not updated since.
 */
export const RETIRED_PATHS = [
  // AIO-864 — the Cursor cross-repo toolkit guard. ORDER MATTERS, and it is the reverse of
  // the install order: the dispatching config goes FIRST, its helper scripts after. The
  // guard's hooks.json is `failClosed` and gates on a marker (.aios-toolkit-version) that
  // every workspace always has, so "marker present, script missing" returns exit 3 and denies
  // every edit and shell call for the whole session. Removing the helpers first would create
  // exactly that state for as long as the run takes — and permanently if it is interrupted.
  // This order can only ever leave orphaned helper scripts that nothing dispatches to.
  { dest: ".cursor/hooks.json", src: "scaffold/.cursor/hooks.json", kind: "file" },
  {
    dest: ".cursor/hooks/guard-toolkit-primary.sh",
    src: "scaffold/.cursor/hooks/guard-toolkit-primary.sh",
    kind: "file",
  },
  {
    dest: ".cursor/hooks/toolkit-primary-tripwire.sh",
    src: "scaffold/.cursor/hooks/toolkit-primary-tripwire.sh",
    kind: "file",
  },
];

/**
 * Which PM tool this workspace's agent factory targets — `linear` | `clickup` | `none`.
 *
 * A workspace scaffolded before AIO-844 has no `pm_tool` key at all, and MUST keep receiving
 * the Linear assets it already has: an absent key reads as `linear`, never as "no PM tool".
 * `aios update` writes the key explicitly on first run after that (see persistScalar), so the
 * default is a one-time migration bridge rather than a permanent implicit value.
 *
 * `loadConfig` → parseFlatYaml already strips quotes, so `pm_tool: linear` and
 * `pm_tool: "linear"` both land here as the bare string.
 */
export const PM_TOOL_DEFAULT = "linear";
export const pmToolOf = (cfg = {}) => String(cfg.pm_tool ?? "").trim() || PM_TOOL_DEFAULT;

export function managedPathsForConfig(cfg = {}) {
  const pmTool = pmToolOf(cfg);
  const base =
    cfg.ci_workflow === true || cfg.ci_workflow === "true"
      ? [...MANAGED_PATHS, ...CI_WORKFLOW_MANAGED_PATHS]
      : MANAGED_PATHS;
  return base.filter((e) => !e.pmTool || e.pmTool === pmTool);
}

/**
 * The managed entries this workspace's `pm_tool` EXCLUDES — i.e. assets it may still be
 * carrying from a previous `pm_tool` value. Filtering an entry out of managedPathsForConfig
 * only stops it syncing; it never removes what is already on disk (applyDeletions only fires
 * for files that vanished from the toolkit SOURCE). `aios update` prunes these separately,
 * and only when the workspace copy still matches the toolkit — an edited file is kept.
 */
export const pmToolPrunable = (cfg = {}) =>
  MANAGED_PATHS.filter((e) => e.pmTool && e.pmTool !== pmToolOf(cfg));

/**
 * Create-only starter files. `aios update` copies these into an existing workspace
 * only when the destination does not exist. An existing destination is never read,
 * merged, overwritten, or deleted — including with `--force`.
 *
 * Seeds may live beneath a PERSONAL directory such as `.aios`: this bucket is the
 * narrow, explicit exception that can fill a missing starter without taking ownership
 * of the surrounding personal state. Add future create-if-absent files here.
 */
export const SEED_IF_ABSENT = [
  {
    dest: ".aios/comms-config.json",
    src: "scaffold/comms-config.json",
    kind: "file",
  },
  // AIO-482: Conductor's own repo-scoped config. Seed-only — a workspace owner's
  // `[scripts]`/`[git]` customisations here are theirs, and the two other hydration
  // layers (post-checkout hook + SessionStart self-heal) cover the file's absence.
  {
    dest: ".conductor/settings.toml",
    src: "scaffold/.conductor/settings.toml",
    kind: "file",
  },
];

/**
 * Personal paths — a workspace's own content + identity + local state. `aios update`
 * MUST NOT merge or overwrite existing content here. Listed for the guard/tests and
 * documentation; the narrower SEED_IF_ABSENT entries may only fill a missing child
 * destination, never take ownership of the surrounding personal state.
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
  // A workspace owner's own Conductor config (run scripts, git prefs, env). Same
  // shape as `.aios`: PERSONAL as a whole, with one narrow SEED_IF_ABSENT child
  // (`.conductor/settings.toml`) allowed to fill it in when it's missing entirely.
  ".conductor",
  "node_modules",
];

/**
 * Toolkit paths that `scaffold-project.sh` writes into a fresh workspace but `aios update`
 * deliberately does NOT sync — because they are per-machine hydration/config, generated
 * catalogs, or stamp-time-templated files that can't be blind-overlaid. They are neither
 * "managed" (synced) nor "personal" (a person's own content). Listed explicitly so the
 * manifest↔scaffold parity test can prove every scaffold-written path is classified into
 * exactly one effective bucket — no silent category. Update this list when the scaffold
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
  // `.github` as a whole is NOT unmanaged any more: the scan-on-merge workflow and its two
  // helper scripts are MANAGED (see MANAGED_PATHS) so a pinned-SHA or toolkit-range fix
  // reaches every workspace through `aios update`. Only CODEOWNERS is stamped once — it names
  // this workspace's owner, which the toolkit must never overwrite. A person's own workflows
  // sit alongside and are untouched, because these are file entries, not a dir overlay.
  ".github/CODEOWNERS",
  ".planning", // scaffolded empty; a person's own planning space
  "CODEOWNERS", // repo-ownership file, stamped once
  // Stamp-time TEMPLATED files: toolkit origin, but personalized on scaffold, so they
  // can't be blind-overlaid (that would clobber the personalization).
  ".claude/CLAUDE.md",
  ".gitignore",
  "package.json",
  "README.md",
  // scaffold writes this (from scaffold/.claude/rules/access-control.md), but `aios
  // update` must not touch it — it's personalized per workspace (tier table, team
  // names, context aliases) at scaffold time. See the exclude on the .claude/rules
  // MANAGED_PATHS entry above.
  ".claude/rules/access-control.md",
];

/** The version stamp a workspace writes to record which toolkit it last synced. */
export const VERSION_FILE = ".aios-toolkit-version";
