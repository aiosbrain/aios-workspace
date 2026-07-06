# CQ2 — Ship review-loop (AIO-254) triage

Parent: Pre-release code quality epic.

## Why

AIO-254 needs explicit deferral before ship — no scope ambiguity.

## What

Document AIO-254 **deferred** with reason in Linear comment on AIO-286.

## Acceptance criteria

- Linear comment on AIO-286 states deferral reason.
- No AIO-254 code changes in pre-release CQ scope.
- `npm run aios -- spec eval docs/pre-ship/cq2-ship-review-loop.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** deferral comment on AIO-286.
- **Operator verifies:** AIO-254 remains backlog/deferred, not in-progress for ship.

## Integration points

- `scripts/ship.mjs`

## Deps

Deps: none.

## Scope

Deferral only. Out of scope: AIO-254 implementation.

## Build-with

Build-with: sonnet / low.

## Testability

Linear comment exists on AIO-286 with deferral text.
