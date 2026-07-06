# UX2 — Integrations connect wizard dogfood

Parent: Pre-release UX epic. Owner: john@john-ellison.com

## Why

Connect wizard must work before external users connect services.

## Prerequisites

- `gui/client/src/components/integrations/ConnectWizard.tsx` must exist. If absent, record "ConnectWizard not found" in the audit doc and stop.
- `gui/server/index.mjs` must exist for endpoint validation.

## What

Dogfood `gui/client/src/components/integrations/ConnectWizard.tsx` and validate endpoint.
Record **flow-2** row in shared UX audit doc.

## New files to create

- Extend `docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md` with flow-2 row:
  `flow_id=flow-2`, `pass/fail=<pass|fail>`, `session_note=<wizard interaction + bad-credentials result>`, `owner=john@john-ellison.com`.
  If the file is absent, create it first with table header (per UX1 column definition).

## Acceptance criteria

- Audit doc flow-2 row: `grep -q 'flow-2' docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md`.
- Bad-credentials path returns expected error from `/api/connectors/:id/validate` (noted in session_note).

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
