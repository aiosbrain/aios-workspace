# UX3 — CLI onboard parity + token URL auth

Parent: Pre-release UX epic. Owner: john@john-ellison.com

## Why

`aios onboard` must parity GUI; token URL must appear on server start.

## Prerequisites

- `scripts/aios.mjs` must exist (CLI entrypoint).
- `gui/server/index.mjs` must exist (GUI server for token URL verification).

## What

Verify:
- `npm run aios -- onboard --help` exit **0**
- GUI server stdout contains `token=` URL on start (operator captures in audit doc)

Record **flow-3** (CLI help) and **flow-4** (token URL) rows in shared UX audit doc.

## New files to create

- Extend `docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md` with flow-3 and flow-4 rows:
  - `flow_id=flow-3`, `pass/fail=<pass|fail>`, `session_note=<help output excerpt>`, `owner=john@john-ellison.com`
  - `flow_id=flow-4`, `pass/fail=<pass|fail>`, `session_note=<token URL from stdout or "not observed">`, `owner=john@john-ellison.com`
  If the file is absent, create it first with table header (per UX1 column definition).

## Acceptance criteria

- `npm run aios -- onboard --help` exits **0**.
- Audit doc contains `flow-3` and `flow-4` rows.

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
