# UX3 — CLI onboard parity + token URL auth

Parent: Pre-release UX epic. Owner: john@john-ellison.com

## Why

`aios onboard` must parity GUI; token URL must appear on server start.

## What

Verify:
- `npm run aios -- onboard --help` exit **0**
- GUI server stdout contains `token=` URL on start (operator captures in audit doc)

Record **flow-3** (CLI help) and **flow-4** (token URL) rows in shared UX audit doc.

## New files to create

- Extend `docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md` with flow-3 and flow-4 rows.

## Acceptance criteria

- `npm run aios -- onboard --help` exits **0**.
- Audit doc contains `flow-3` and `flow-4` rows.
- `npm run aios -- spec eval docs/pre-ship/ux3-cli-onboard-token-auth.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** audit doc rows; help output captured in flow-3 session_note.
- **Operator verifies:** start GUI, confirm token URL in stdout, paste in flow-4 session_note.

## Integration points

- `scripts/aios.mjs`
- `gui/server/index.mjs`

## Deps

Deps: none.

## Scope

Dogfood rows. Out of scope: new auth system.

## Build-with

Build-with: sonnet / low.

## Testability

Named acceptance test:

```bash
npm run aios -- onboard --help
AUDIT=docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md
test -f "$AUDIT" && grep -q 'flow-3' "$AUDIT" && grep -q 'flow-4' "$AUDIT"
```

Exit **0** proves CLI help + audit rows.
