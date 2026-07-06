# CQ4 — In-progress PR triage

Parent: Pre-release code quality epic.

## Why

Open PRs blocking ship must be merged, closed, or waived.

## What

Create `docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md` listing every open PR with decision.

## Acceptance criteria

- Triage log lists all open PRs (`gh pr list --state open` output referenced).
- Zero blocking PRs without waiver row.
- `npm run aios -- spec eval docs/pre-ship/cq4-pr-triage.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** triage log file committed.
- **Operator verifies:** ship-blocking PRs merged or waived.

## Integration points

- `.github/workflows/`

## Deps

Depends on SEC4 (AIO-157) for ship-hardening PR.

## Scope

PR triage. Out of scope: new features.

## Build-with

Build-with: sonnet / low.

## Testability

- `gh pr list --state open` reviewed; triage log has one row per PR.
