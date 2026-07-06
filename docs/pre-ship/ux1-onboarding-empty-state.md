# UX1 — Onboarding + profile empty-state dogfood

Parent: Pre-release UX epic. Owner: john@john-ellison.com

## Why

Cockpit empty state must guide contributors to profile setup.

## What

1. Run `node --test test/ux/flows/onboarding-draft-from-link.mjs`.
2. Add **flow-1** row to shared audit doc (see New files).

## New files to create

- `docs/pre-ship/ux-audit-YYYY-MM-DD.md` — if absent, create with table header and flow-1 row
  (`flow_id=flow-1`, `pass/fail`, `session_note`, `owner=john@john-ellison.com`).

## Acceptance criteria

- `node --test test/ux/flows/onboarding-draft-from-link.mjs` exits **0**.
- Audit doc flow-1 row present: `grep -q 'flow-1' docs/pre-ship/ux-audit-YYYY-MM-DD.md`.
- `npm run aios -- spec eval docs/pre-ship/ux1-onboarding-empty-state.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** UX test green; audit doc flow-1 row committed.
- **Operator verifies:** optional empty-state screenshot pasted in audit doc `session_note`.

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

Named acceptance test:

```bash
node --test test/ux/flows/onboarding-draft-from-link.mjs
AUDIT=docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md
test -f "$AUDIT" && grep -q 'flow-1' "$AUDIT"
```

Exit **0** proves automated test + audit row.
