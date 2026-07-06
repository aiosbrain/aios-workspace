---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON1, agents-md]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON1: Workspace AGENTS.md + 0-context/index.md update

## Why

OpenCode sessions opening this workspace have no orientation. The `.claude/CLAUDE.md`
system prompt is read by Claude Code's session loader, but OpenCode reads `AGENTS.md` at
the workspace root. Without it, the agent doesn't know the spine layout, access tiers,
how to sync, which rules to follow, or where to find skills.

Additionally, the `0-context/index.md` navigation file should declare that `.claude/` is
the canonical, runtime-agnostic agent root — establishing the design principle in the
workspace's own documentation.

## What

Two file changes:

1. **Create `AGENTS.md`** at the workspace root (~40 lines). It is a thin orientation
   file that points to the spine for detailed content. Structure:
   - Workspace identity (John, Pravos/Vibrana, AIOS)
   - Spine map (0-context through 5-personal, access tiers)
   - Quick start (decision log → tasks → rules → skills → sync)
   - Agent-layer note (`.claude/` is runtime-agnostic, skills and rules live there)
   - OpenCode-specific footer (`.opencode/agents/`, instincts plugin)

2. **Edit `0-context/index.md`** — add a line or section declaring:
   > The `.claude/` directory is the canonical, runtime-agnostic agent layer. Despite the
   > name, its skills, rules, rubrics, and commands are designed for all agent runtimes,
   > not just Claude Code. See `AGENTS.md` or `.claude/CLAUDE.md` for agent-specific
   > orientation.

## Acceptance criteria

- `test -f AGENTS.md` exits 0
- AGENTS.md contains the string "AIOS" and "Pravos" (workspace identity)
- AGENTS.md contains the string "0-context" and "team" (spine map with tiers)
- AGENTS.md contains the string "scripts/aios.mjs" or "aios status" (brain sync reference)
- AGENTS.md does NOT contain "settings.json", "PreToolUse", "PostToolUse" (no
  Claude-specific hook references)
- AGENTS.md contains the string ".opencode" (OpenCode-specific section)
- `0-context/index.md` contains the string "runtime-agnostic" (design principle declared)
- Claude Code sessions still load `.claude/CLAUDE.md` normally (no change to that file)

## Integration points

- `.claude/CLAUDE.md` — read-only reference for content parity; not modified
- `.claude/rules/` — referenced in AGENTS.md as governance docs
- `.claude/skills/INDEX.md` — referenced in AGENTS.md as skill catalog
- `scripts/aios.mjs` — referenced for brain sync
- `0-context/index.md` — edited in-place (add runtime-agnostic declaration)
- `0-context/role.md` — referenced in AGENTS.md for role context

## Deps

None

## Scope

In scope: AGENTS.md creation, 0-context/index.md edit.
Deferred: updates to scaffold template (not this workspace), AGENTS.md/CLAUDE.md drift
validation script.

## Build-with

sonnet / low

## Tier-safety

AGENTS.md is `access: team`. Contains no admin data, no secrets, no client names. All
paths referenced are team-tier or public.

## Testability

Demonstrated by file-existence checks, grep for required sections, negative grep for
Claude-specific references. Manual verification: open this workspace in a fresh OpenCode
session — the agent should identify it as John's AIOS workspace and navigate the spine
without being told.
