---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON3, commands, export]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON3: Command Export Pipeline

## Why

The workspace has 6 Claude Code commands in `.claude/commands/` for draft-email,
draft-whatsapp, granola-digest, process-meeting, process-statement, and publish-meeting.
OpenCode sessions need access to these same workflows.

Manually copying command files per runtime doesn't scale — it creates drift risk and
duplication. The BYOA architecture already solves this for skills (`aios skills export
--runtime <name>`). This spec applies the same pattern to commands: single canonical
source, runtime-specific generated wrappers, committed output.

## What

A small Node.js script and 6 generated files:

1. **`scripts/export-commands.mjs`** — reads `.claude/commands/*.md`, wraps each in
   OpenCode-native YAML frontmatter, writes to `.opencode/command/`. Must be idempotent
   (running twice produces identical output).

2. **6 generated command files** in `.opencode/command/`:
   - `draft-email.md`, `draft-whatsapp.md`, `granola-digest.md`
   - `process-meeting.md`, `process-statement.md`, `publish-meeting.md`

   Each generated file has:
   ```yaml
   ---
   description: <first-line or extracted summary from source command>
   ---
   ```
   Followed by the original command body unchanged, with `$ARGUMENTS` passthrough.

## Acceptance criteria

- `node scripts/export-commands.mjs` exits 0
- Running the generator twice produces identical `.opencode/command/*.md` files (verified
  by `sha256sum` comparison)
- 6 files exist in `.opencode/command/` matching the `.claude/commands/` filenames
- Each generated file has valid YAML frontmatter with a `description` key
- Each generated file contains the string `$ARGUMENTS` (argument passthrough)
- Each generated file's body content matches its source command (aside from frontmatter
  wrapper)

## Integration points

- `.claude/commands/draft-email.md` — source (read)
- `.claude/commands/draft-whatsapp.md` — source (read)
- `.claude/commands/granola-digest.md` — source (read)
- `.claude/commands/process-meeting.md` — source (read)
- `.claude/commands/process-statement.md` — source (read)
- `.claude/commands/publish-meeting.md` — source (read)
- `scripts/aios.mjs` — reference for script conventions (thin shim pattern, Node.js)
- `.opencode/command/*.md` — output (write, committed)

## Deps

- ON2: opencode.json must exist (commands dir is loaded via config)

## Scope

In scope: generator script + 6 generated files. OpenCode-native frontmatter wrapping.
Idempotency guarantee.

Deferred: Codex and GLM 5.2 export targets (add when needed — generator architecture
supports additional `--runtime` flags), CI/git hook for drift detection, automated
regeneration on `.claude/commands/` changes.

## Build-with

sonnet / medium

## Tier-safety

Command files contain workflow instructions (team-tier). No admin data, secrets, or
client-specific information in any command. Generator script is team-tier code. Generated
files are committed — no runtime data leakage.

## Testability

Demonstrated by generator idempotency test (`sha256sum` before/after re-run), file count
check (6 files), frontmatter validity (YAML parse), and content match against source
files. Manual verification: invoke one generated command from OpenCode and confirm it
delegates to the correct workflow.
