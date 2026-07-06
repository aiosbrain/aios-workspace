---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON2, config]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON2: Project opencode.json

## Why

Without a project-level `opencode.json`, OpenCode sessions in this workspace use global
defaults — no workspace-specific default agent, no instructions pointing to AIOS rules, no
references to the spine, and no project-aware permissions. This means the agent can't
auto-discover that it's in an AIOS workspace and must be told everything every session.

## What

Ship `scaffold/opencode.json` (copied to workspace root on scaffold) with:

- `default_agent: "aios-orchestrator"` — the project agent defined in ON4
- `instructions` array pointing to `.claude/rules/*.md` and `.claude/memory/instincts.md`
  (governance rules + instinct definitions become session context after scaffold copy)
- `references` object with named spine directories so the agent can `@0-context`, etc.
- `plugin` array loading `./.opencode/plugins/aios-instincts.ts` (from ON5)
- `permission` block allowing `bash: aios *` and `bash: git *`, default-deny for
  `external_directory` and sensitive admin paths
- `$schema: https://opencode.ai/config.json` for validation

## Acceptance criteria

- `scaffold/opencode.json` exists and parses as JSON
- `scaffold/opencode.json` has key `default_agent` with value `"aios-orchestrator"`
- `scaffold/opencode.json` has key `instructions` as an array containing at least
  `.claude/rules/access-control.md`
- `scaffold/opencode.json` has key `references` with at least one spine directory key
- `scaffold/opencode.json` has key `plugin` as an array referencing the instincts plugin
- `scaffold/opencode.json` has key `$schema` with URL `https://opencode.ai/config.json`
- `validation/check-opencode-scaffold.mjs` (OGR12) exits 0 on the toolkit repo

## Integration points

- `scaffold/.claude/rules/*.md` — governance rules (referenced in instructions after copy)
- `scaffold/.claude/memory/instincts.md` — instinct definitions (referenced in instructions)
- `scaffold/.opencode/agents/aios-orchestrator.md` — default agent (ON4)
- `scaffold/.opencode/plugins/aios-instincts.ts` — instincts plugin (ON5)
- `scripts/scaffold-project.sh` — copies `scaffold/opencode.json` to workspace root

## Deps

- ON1: AGENTS.md template must exist (orientation context)
- ON4: `aios-orchestrator` agent ships in the same scaffold bundle
- ON5: instincts plugin ships in the same scaffold bundle

## Scope

In scope: `scaffold/opencode.json` + OGR12 validator.
Deferred: MCP server definitions (global OpenCode config), per-agent model overrides.

## Build-with

sonnet / low

## Tier-safety

opencode.json is `access: team`. Contains no secrets, API keys, or admin data. Permissions
default-deny for sensitive paths; bash allowlist restricted to `aios`, `git`, and workspace scripts.

## Testability

Demonstrated by OGR12 (`validation/check-opencode-scaffold.mjs`), JSON parse, and
`node --test test/opencode-native/scaffold.test.mjs`.
