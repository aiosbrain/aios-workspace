# UX1 — Onboarding + profile empty-state dogfood

Parent: Pre-release UX epic.

## Why

Cockpit empty state must guide contributors to profile setup.

## What

Verify `gui/client/src/App.tsx` empty state + automated UX test.

## Acceptance criteria

- `node --test test/ux/flows/onboarding-draft-from-link.mjs` exits **0**.
- UX audit doc flow-1 row: pass/fail.
- `npm run aios -- spec eval docs/pre-ship/ux1-onboarding-empty-state.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** UX test green; audit doc row.
- **Operator verifies:** manual empty-state screenshot in audit doc (optional).

## Integration points

- `gui/client/src/App.tsx`
- `test/ux/flows/onboarding-draft-from-link.mjs`

## Deps

Soft dependency on AF3 naming.

## Scope

Dogfood row. Out of scope: redesign.

## Build-with

Build-with: sonnet / medium.

## Testability

- `node --test test/ux/flows/onboarding-draft-from-link.mjs` exit **0**.
