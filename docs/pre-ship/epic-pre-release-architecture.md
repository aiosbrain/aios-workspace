# EPIC — Pre-release architecture review

Linear epic title: **EPIC: Pre-release architecture review**  
Owner: john@john-ellison.com

## Why

Modularity/coupling pass before ship — documented smells and fix-or-defer decisions.

## What

Aggregate outputs from child specs into `docs/pre-ship/architecture-review-$(date +%Y-%m-%d).md` (the builder substitutes `$(date +%Y-%m-%d)` with the run date at execution time).
Read-only — no code changes unless trivial doc fix.

| Child | Spec path | Deliverable |
|-------|-----------|-------------|
| ARCH1 | `docs/pre-ship/arch1-sync-contract-drift.md` | Drift + version line in review doc |
| ARCH2 | `docs/pre-ship/arch2-operator-loop-ship-coupling.md` | `arch2-operator-loop-ship-coupling-review.md` |
| ARCH3 | `docs/pre-ship/arch3-cross-repo-seams.md` | `arch3-cross-repo-seams-review.md` |

## Acceptance criteria

- ARCH1: `npm run check:docs` run, version line recorded (per `arch1-sync-contract-drift.md`).
- ARCH2: `docs/pre-ship/arch2-operator-loop-ship-coupling-review.md` exists with ≥2 labelled smells.
- ARCH3: `docs/pre-ship/arch3-cross-repo-seams-review.md` exists with seam table.
- Review doc `docs/pre-ship/architecture-review-$(date +%Y-%m-%d).md` lists **top 5 coupling smells**
  (sourced from ARCH2 + ARCH3) with `fix-before-ship` vs `post-ship-debt` labels.
- `npm run check:docs` exit captured in review doc (ARCH1).
- AIO-249 deferred — Linear child filed only if non-trivial.

## Builder vs operator closure

- **Builder delivers:** architecture review doc + ARCH1–3 deliverables confirmed (drift recorded, coupling review doc, seam table doc).
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

Named acceptance test:

```bash
REVIEW=docs/pre-ship/architecture-review-$(date +%Y-%m-%d).md
test -f "$REVIEW" && grep -q 'fix-before-ship\|post-ship-debt' "$REVIEW"
npm run check:docs
```

Review file + drift check prove epic deliverables. Child specs must each pass `spec eval`.
