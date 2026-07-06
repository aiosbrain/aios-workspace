# SEC3 — Hooks + PreToolUse guards audit

Parent: Pre-release security epic.

## Why

PreToolUse hooks guard secrets and tier boundaries before writes.

## What

Verify:
- `hooks/team-ops-guard.sh` exists and is wired in `scaffold/.claude/settings.json`
- `hooks/aios-sync-nudge.sh` exists
- `validation/check-secrets.sh examples/synthetic-consultant` exit **0**
- `validation/check-frontmatter.sh examples/synthetic-consultant` exit **0**

## Acceptance criteria

- Hook files exist under `hooks/`.
- `validation/check-frontmatter.sh examples/synthetic-consultant` exits **0**.
- Checklist row per hook in `docs/pre-ship/security-audit-checklist.md`.
- `npm run aios -- spec eval docs/pre-ship/sec3-hooks-guards-audit.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** checklist audit rows + confirm settings.json wiring.
- **Operator verifies:** spot-check hook blocks a test secret write (manual note in checklist).

## Integration points

- `hooks/team-ops-guard.sh`
- `hooks/aios-sync-nudge.sh`
- `validation/check-frontmatter.sh`
- `scaffold/.claude/settings.json`

## Deps

Deps: none.

## Scope

Audit + checklist. Out of scope: new hooks.

## Build-with

Build-with: sonnet / low.

## Testability

- `validation/check-frontmatter.sh examples/synthetic-consultant` exit **0**.
- `validation/check-secrets.sh examples/synthetic-consultant` exit **0**.
