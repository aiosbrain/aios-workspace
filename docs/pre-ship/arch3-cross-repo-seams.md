# ARCH3 — Cross-repo seam review (workspace/brain/website)

Parent: Pre-release architecture epic.

## Why

Three-repo seams must be documented before public ship.

## What

Document in review doc:
- workspace ↔ brain sync (`scripts/aios.mjs`, `scripts/brain-client.mjs`)
- docs alignment (`docs/brain-api.md`)
- design tokens (`@aios-alpha/design` npm package)

Read-only — no cross-repo PRs required to close ARCH3.

## Acceptance criteria

- Review section with seam table covering workspace, brain, website.
- `npm run aios -- spec eval docs/pre-ship/arch3-cross-repo-seams.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** seam table in review doc (this repo).
- **Operator verifies:** table reviewed; optional brain/website checkout notes added.

## Optional follow-up

- Cross-repo doc PRs filed as separate Linear children — not blocking ARCH3.

## Integration points

- `scripts/aios.mjs`
- `scripts/brain-client.mjs`
- `docs/brain-api.md`

## Deps

Deps: none.

## Scope

Read-only documentation. Out of scope: monorepo merge.

## Build-with

Build-with: sonnet / medium.

## Tier-safety

Read-only review — no sync behavior changes. Document that workspace ↔ brain sync respects
`admin`/`team`/`external` tiers, default-deny on missing `access:`, and brain rejects admin at **422**.
This slice does not modify tier policy.

## Testability

Review doc seam table committed in aios-workspace.
