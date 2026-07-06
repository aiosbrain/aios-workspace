# UX3 — CLI onboard parity + token URL auth

Parent: Pre-release UX epic.

## Why

`aios onboard` must parity GUI; token URL must appear on server start.

## What

Verify:
- `npm run aios -- onboard --help` exit **0**
- GUI server stdout contains `token=` URL on start

## Acceptance criteria

- `npm run aios -- onboard --help` exits **0**.
- UX audit doc flow-3/4 rows: pass/fail for CLI + token auth.
- `npm run aios -- spec eval docs/pre-ship/ux3-cli-onboard-token-auth.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** audit doc rows; help output captured.
- **Operator verifies:** start GUI, confirm token URL in stdout, paste in audit doc.

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

- `npm run aios -- onboard --help` exit **0**.
