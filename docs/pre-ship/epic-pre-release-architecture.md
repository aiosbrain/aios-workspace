# EPIC — Pre-release architecture review

Linear epic title: **EPIC: Pre-release architecture review**

## Why

Modularity/coupling pass before ship — documented smells and fix-or-defer decisions.

## What

Produce `docs/pre-ship/architecture-review-YYYY-MM-DD.md` via children ARCH1–ARCH3.
Read-only — no code changes unless trivial doc fix.

## Acceptance criteria

- Review doc lists **top 5 coupling smells** with fix-before-ship vs post-ship-debt labels.
- `npm run check:docs` exits **0**.
- `npm run aios -- spec eval docs/pre-ship/epic-pre-release-architecture.md` exits **0**.
- AIO-249 deferred — Linear child filed only if non-trivial.

## Builder vs operator closure

- **Builder delivers:** architecture review doc + drift checks green.
- **Operator verifies:** smell labels reviewed; fix-before-ship items have Linear children.

## Integration points

- `docs/brain-api.md`
- `scripts/check-docs-drift.mjs`
- `src/operator-loop/`
- `scripts/ship.mjs`

## Deps

Deps: none.

## Scope

Read-only review + doc. Out of scope: large refactors; AIO-249 implementation.

## Build-with

Build-with: opus / high.

## Tier-safety

Review notes tier seams (`access:`, push filter, brain **422**) as non-negotiable.

## Testability

- `npm run check:docs` exit **0**.
