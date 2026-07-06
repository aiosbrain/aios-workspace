# CQ3 — V1 Linear drift + AIO-122 close-out

Parent: Pre-release code quality epic.

## Why

AIO-122 must be closable with C1–C8 Done and no stale blockers.

## What

- `npm run check:v1-linear` exit **0**
- C1–C8 in `docs/v1-operator-loop/README.md` marked Done in Linear
- Remove stale `blocked by AIO-130` on AIO-122

## Acceptance criteria

- `npm run check:v1-linear` exits **0**.
- AIO-122 closable in Linear.
- `npm run aios -- spec eval docs/pre-ship/cq3-v1-linear-drift.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** `check:v1-linear` exit **0** logged.
- **Operator verifies:** AIO-122 state and blocker relations in Linear UI.

## Integration points

- `scripts/check-v1-linear-drift.mjs`
- `docs/v1-operator-loop/README.md`

## Deps

Deps: none.

## Scope

Drift + Linear hygiene. Out of scope: new loop features.

## Build-with

Build-with: sonnet / low.

## Testability

- `npm run check:v1-linear` exit **0**.
