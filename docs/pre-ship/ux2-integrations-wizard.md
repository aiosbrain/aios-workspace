# UX2 — Integrations connect wizard dogfood

Parent: Pre-release UX epic.

## Why

Connect wizard must work before external users connect services.

## What

Dogfood `gui/client/src/components/integrations/ConnectWizard.tsx` and validate endpoint.

## Acceptance criteria

- UX audit doc flow-2 row: pass/fail with session note.
- Bad-credentials path returns expected error from `/api/connectors/:id/validate`.
- `npm run aios -- spec eval docs/pre-ship/ux2-integrations-wizard.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** audit doc row with pass/fail.
- **Operator verifies:** manual wizard session or agent-browser transcript in audit doc.

## Integration points

- `gui/client/src/components/integrations/ConnectWizard.tsx`
- `gui/server/index.mjs`

## Deps

Deps: none.

## Scope

Dogfood row. Out of scope: new connectors.

## Build-with

Build-with: sonnet / medium.

## Testability

UX audit doc flow-2 row committed with pass/fail.
