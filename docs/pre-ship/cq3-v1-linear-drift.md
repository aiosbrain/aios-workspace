# CQ3 — V1 Linear drift + AIO-122 close-out

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-122 must be closable with C1–C8 Done and no stale blockers.

## Prerequisites

- `npm run check:v1-linear` script exists (wraps `scripts/check-v1-linear-drift.mjs`)
- `~/.claude/skills/aios-linear/linear.mjs` exists (aios-linear CLI, installed by operator)
- `dotenvx` available in PATH
- `.env` file with `LINEAR_API_KEY` present (gitignored, operator-provided)

## What

1. Run drift check: `npm run check:v1-linear` (wraps `scripts/check-v1-linear-drift.mjs`).
2. Update Linear via aios-linear CLI so C1–C8 in `docs/v1-operator-loop/README.md` are marked **Done**.
3. Remove stale `blocked by AIO-130` relation on AIO-122.

```bash
LIN="dotenvx run --quiet -f .env -- node ~/.claude/skills/aios-linear/linear.mjs"
npm run check:v1-linear   # must exit 0 before Linear edits
# Mark C1–C8 done per README checklist (example — adjust issue IDs from check output):
# $LIN set-state <C-issue-id> done
# $LIN unblock AIO-122
```

Record `check:v1-linear exit: <N>` in PR comment or triage log.

## Acceptance criteria

- `npm run check:v1-linear` exits **0**.
- AIO-122 closable in Linear (no stale AIO-130 blocker; C1–C8 Done per `docs/v1-operator-loop/README.md`).

## Builder vs operator closure

- **Builder delivers:** `check:v1-linear` exit **0** logged; Linear C1–C8 states updated via CLI.
- **Operator verifies:** AIO-122 state and blocker relations in Linear UI.

## Integration points

- `scripts/check-v1-linear-drift.mjs`
- `docs/v1-operator-loop/README.md`
- `~/.claude/skills/aios-linear/linear.mjs` (Linear CLI)

## Deps

Deps: none.

## Scope

Drift + Linear hygiene. Out of scope: new loop features.

## Build-with

Build-with: sonnet / low.

## Testability

Named acceptance test:

```bash
npm run check:v1-linear
```

Exit **0** proves README ↔ Linear alignment. Linear UI state is operator-verified.
