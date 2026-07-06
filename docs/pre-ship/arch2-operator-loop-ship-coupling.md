# ARCH2 — Operator loop + ship pipeline coupling review

Parent: Pre-release architecture epic.

## Why

Operator loop and ship pipeline boundaries must be clear before ship.

## What

Review `src/operator-loop/*` vs `scripts/ship.mjs` / `scripts/relay-core.mjs` / `scripts/build.mjs`.
Document ≥2 smells in review doc.

## Acceptance criteria

- Review section covers operator-loop ↔ ship coupling.
- ≥2 smells labeled fix-before-ship or post-ship-debt.
- `npm run aios -- spec eval docs/pre-ship/arch2-operator-loop-ship-coupling.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** review doc section with labeled smells.
- **Operator verifies:** fix-before-ship smells have Linear children or PR links.

## Integration points

- `src/operator-loop/`
- `scripts/ship.mjs`
- `scripts/relay-core.mjs`
- `scripts/build.mjs`

## Deps

Deps: none.

## Scope

Read-only review. Out of scope: refactors.

## Build-with

Build-with: opus / high.

## Testability

Review doc section exists with ≥2 labeled smells.
