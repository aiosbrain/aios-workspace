# SEC3 — Hooks + PreToolUse guards audit

Parent: Pre-release security epic. Owner: john@john-ellison.com

## Why

PreToolUse hooks guard secrets and tier boundaries before writes.

## Prerequisites

Before auditing, verify these exist. For any that don't, record "not found" in the checklist and skip that check (do not fail the task):

- `hooks/` directory exists — if absent all hook checks produce "not found" rows
- `scaffold/.claude/settings.json` exists — if absent, record "settings.json not found" for the wiring check
- `examples/synthetic-consultant/` directory exists — if absent, record "fixture missing" in the validation checks and skip them

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

Named acceptance test:

```bash
if [ -d examples/synthetic-consultant ]; then
  validation/check-frontmatter.sh examples/synthetic-consultant
  validation/check-secrets.sh examples/synthetic-consultant
else
  echo "fixture missing — skipping validation checks"
fi
test -f hooks/team-ops-guard.sh && grep -q team-ops-guard scaffold/.claude/settings.json
grep -q 'hooks' docs/pre-ship/security-audit-checklist.md
```

Validation checks are gated on the fixture directory existing (per Prerequisites). All remaining commands exit **0**.
