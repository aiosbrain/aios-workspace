# EPIC — Pre-release UX audit

Linear epic title: **EPIC: Pre-release UX audit**

## Why

Critical cockpit flows untested at intent level before external users.

## What

Pilot UX on five flows; output `docs/pre-ship/ux-audit-YYYY-MM-DD.md`; children UX1–UX3.

## Acceptance criteria

- Audit doc covers five flows with pass/fail per flow ID.
- `node --test test/ux/flows/onboarding-draft-from-link.mjs` exits **0**.
- P0 bugs filed as Linear children before epic close.
- `npm run aios -- spec eval docs/pre-ship/epic-pre-release-ux.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** audit doc + UX test green + P0 issues filed.
- **Operator verifies:** one manual/agent-browser session logged with token URL.

## Integration points

- `gui/client/src/App.tsx`
- `gui/server/index.mjs`
- `test/ux/flows/onboarding-draft-from-link.mjs`
- `scripts/aios.mjs`

## Deps

Soft dependency on AF3 for realistic onboarding state.

## Scope

Pilot audit + P0 filing. Out of scope: nightly agentic CI; Tauri shell.

## Build-with

Build-with: sonnet / medium.

## Tier-safety

Synthetic profile URLs only; no production secrets in logs.

## Testability

- `node --test test/ux/flows/onboarding-draft-from-link.mjs` exit **0**.
