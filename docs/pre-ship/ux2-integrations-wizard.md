# UX2 — Integrations connect wizard dogfood

Parent: Pre-release UX epic. Owner: john@john-ellison.com

## Why

Connect wizard must work before external users connect services.

## What

Dogfood `gui/client/src/components/integrations/ConnectWizard.tsx` and validate endpoint.
Record **flow-2** row in shared UX audit doc.

## New files to create

- Extend `docs/pre-ship/ux-audit-YYYY-MM-DD.md` with flow-2 row (`pass/fail`, bad-credentials note).

## Acceptance criteria

- Audit doc flow-2 row: `grep -q 'flow-2' docs/pre-ship/ux-audit-YYYY-MM-DD.md`.
- Bad-credentials path returns expected error from `/api/connectors/:id/validate` (noted in session_note).
- `npm run aios -- spec eval docs/pre-ship/ux2-integrations-wizard.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** audit doc flow-2 row with pass/fail + session note.
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

Named acceptance test:

```bash
AUDIT=docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md
test -f "$AUDIT" && grep -q 'flow-2' "$AUDIT"
```

Exit **0** proves audit row committed.
