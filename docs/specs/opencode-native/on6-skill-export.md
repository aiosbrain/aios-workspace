---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON6, skills, export]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON6: Skill Export Verification

## Why

AIOS ships 7 multi-agent harnesses in `.claude/skills/`. These are designed for Claude
Code's subagent orchestration and hooks. When exported for OpenCode's native agent loop
(via `aios skills export --runtime opencode`), the BYOA export pipeline applies honest
degradation: multi-agent harnesses degrade to single-agent instruction files, hooks become
manual steps.

This spec verifies the export works cleanly and documents what degrades, so anyone
running OpenCode knows exactly what they're getting.

## What

Two deliverables:

1. **Run `aios skills export --runtime opencode`** for all 7 skills. Verify OGR06
   round-trip validator passes (exit 0).

2. **Add `compatibility` frontmatter** to each skill's `SKILL.md` noting the opencode
   export status: `native` (works as-is), `degraded` (multi-agent → single-agent, hooks
   become manual), or `unsupported` (can't export at all). For degraded skills, document
   exactly what changes.

### Skill inventory

| Skill | Type | Expected opencode status |
|-------|------|-------------------------|
| aios-sync | Single-agent CLI instructions | native |
| cost-monitor | Single-agent CLI instructions | native |
| okf-traverse | Single-agent traversal | native |
| agentic-maturity | Multi-agent harness | degraded |
| decision-audit | Multi-agent harness with adversarial verification | degraded |
| scope-creep | Multi-agent harness with adversarial verification | degraded |
| transcript-decisions | Multi-agent harness with fan-out | degraded |
| weekly-synthesis | Multi-agent harness with rubric-gated self-correction | degraded |

## Acceptance criteria

- `aios skills export --runtime opencode` runs without errors for all 7 skills
- OGR06 (`validation/check-skill-export.mjs`) exits 0 when run against exported skills
- Every `SKILL.md` in `.claude/skills/` has a `compatibility` field in its frontmatter
  with value `native`, `degraded`, or `unsupported`
- Degraded skills have a `degradation` field or section documenting what changes
- At least one degraded skill has been loaded and verified functional in an OpenCode
  session (noted in smoke report ON8)

## Integration points

- `.claude/skills/*/SKILL.md` — all 7 skill files (read, frontmatter edited)
- `validation/check-skill-export.mjs` — OGR06 validator (invoked)
- `scripts/aios.mjs` — CLI that drives skill export

## Deps

None (independent of ON1–ON5)

## Scope

In scope: export verification, compatibility frontmatter, OGR06 pass.
Deferred: Reimplementing AIOS harnesses as native OpenCode multi-agent workflows (would
require OpenCode subagent orchestration parity with Claude's Task tool). This is a
separate effort — the compat layer + honest degradation is sufficient for v1.

## Build-with

sonnet / low

## Tier-safety

No new content pushed to brain. Skill files are team-tier. Compatibility metadata is
team-tier. No admin data touched.

## Testability

Demonstrated by OGR06 exit code (0 = pass), frontmatter field presence (grep for
`compatibility:` in all 7 skill files), and documented degradation notes for degraded
skills.
