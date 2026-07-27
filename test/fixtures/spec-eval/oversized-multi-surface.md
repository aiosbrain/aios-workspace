# Spec — unified inbox demo remediation + Telegram alerts + Gmail send

## Why

Three related-feeling improvements to the operator loop and its GUI, batched together so the demo
is complete in one pass.

## What

Ship Telegram ask alerts, native Gmail reply send, and the remaining unified-inbox demo fixes.

## Acceptance criteria

- `aios inbox` surfaces Telegram alerts with exit code 0.
- The GUI reply composer sends a real Gmail message and shows a confirmation toast.
- The demo walkthrough completes with no synthetic errors dropped.

## Tasks

- Wire Telegram alert delivery in `src/operator-loop/inbox/alerts.ts`.
- Add a native Gmail send path in `scripts/inbox.mjs`.
- Add the reply composer to `gui/client/src/components/comms/CommsDetail.tsx`.
- Add the send endpoint to `gui/server/index.mjs`.
- Update the inbox ranking in `src/operator-loop/inbox/rank.ts`.
- Add a redaction lint rule in `scripts/inbox-redaction-lint.mjs`.
- Update the validators in `validation/validate-all.sh`.
- Refresh the demo docs in `docs/v1-operator-loop/domains/unified-inbox.md`.

## Deps

Deps: none.

## Scope

In scope: all three features. Out of scope: nothing.

## Build-with

Build-with: opus / high effort.

## Testability

Demonstrated by `test/operator-loop/inbox-outbox.test.mjs`.
