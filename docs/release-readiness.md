# Release Readiness - V1 Operator Loop

This is the current release-readiness tracker for `aios-workspace`. The canonical
V1 build and dogfood hub is [`docs/v1-operator-loop/README.md`](./v1-operator-loop/README.md).
This page records what must be true before V1 is presented publicly or included in
an OSS release.

## Current Gate Status

| Gate | Command / Evidence | Status |
|---|---|---|
| Docs drift guard | `npm run check:docs` | **Pass** — 2026-07-14 |
| Linear reconciliation | `npm run check:v1-linear` | **Pass** — C1–C8 Done; stale AIO-130 blocker absent |
| Operator-loop tests | `node --test test/operator-loop/*.test.mjs` | **Pass** — 512/512 |
| TypeScript build | `npm run build:loop` | **Pass** — Inbox export collision repaired on `main` (`41da9e8`) |
| Full repo tests | `npm test` | **Pass** — 2026-07-14 on merged `main` |
| Scaffold validators | `validation/validate-all.sh <workspace>` | **Pass** on fresh synthetic workspace; optional warnings only |
| Secret/leak gates | `validation/check-secrets.sh .` and `scripts/leak-gate.sh .` | **Pass** — 2026-07-14 |
| Website alignment | Cross-repo docs sync/review | Required before website says V1 is shipped |

## AIO-122 Exit Criteria Evidence

| Exit criterion | Evidence source | Release state |
|---|---|---|
| Three consecutive weekly dogfood runs per active user with zero admin/private-tier leaks | [2026-07-14 synthetic pack](./evidence/v1-operator-loop/2026-07-14/README.md) | **Gap:** 1 clean synthetic weekly, 0 shipped leaks; longitudinal 3-run criterion not met |
| Daily loop run on majority of working days | [`telemetry.json`](./evidence/v1-operator-loop/2026-07-14/telemetry.json) | **Gap:** 1/1 synthetic day only; not a multi-day adoption window |
| Median weekly closeout under 20 minutes after setup | Synthetic command timing + C8 telemetry | **Pass mechanically:** 0.1 min, n=1; insufficient longitudinal sample |
| Shareable digest passes must-pass verifier criteria in at least 90% of accepted runs | [`verifier-team.json`](./evidence/v1-operator-loop/2026-07-14/verifier-team.json) | **Pass mechanically:** 100%, n=1; team and external passed |
| At least 70% of accepted weekly runs produce approved next-week actions | [`writeback-approved.json`](./evidence/v1-operator-loop/2026-07-14/writeback-approved.json) | **Pass mechanically:** 100%, n=1 after C6 split-task compatibility fix |
| CLI and cockpit parity against same plan/review/approve model | CLI commands plus cockpit loop/task handlers | **Partial:** shared closeout payload exists; MCP still exposes collect only |

The synthetic run is evidence of mechanics, tier enforcement, and writeback behavior. It is not
evidence of human habit adoption. AIO-122 remains In Progress until the longitudinal and cockpit
scope criteria are satisfied or explicitly removed from the public V1 claim.

## Ordered V1 Release Prep

1. Keep [`docs/v1-operator-loop/README.md`](./v1-operator-loop/README.md) current with code and Linear.
   - `npm run check:docs`
   - `npm run check:v1-linear` when `LINEAR_API_KEY` is available.
2. Run the synthetic E2E dogfood path from the V1 hub and record evidence for each exit criterion.
3. Run the operator-loop and full repo verification suite.
   - `npm run build:loop`
   - `node --test test/operator-loop/*.test.mjs`
   - `npm test`
4. Complete the public-release checklist in [`RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md).
5. Reconcile website/public docs. The website must not claim V1 is shipped until this page and
   the V1 hub show the release gates as complete.
6. Run the monorepo release process only after workspace, Team Brain, and website docs are aligned.

## Not Done By This Tracker

- No version bump.
- No tag.
- No website copy changes.
- No Team Brain contract changes.
- No sync protocol version bump unless [`docs/brain-api.md`](./brain-api.md) changes first.
