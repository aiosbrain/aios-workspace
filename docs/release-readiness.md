# Release Readiness - V1 Operator Loop

This is the current release-readiness tracker for `aios-workspace`. The canonical
V1 build and dogfood hub is [`docs/v1-operator-loop/README.md`](./v1-operator-loop/README.md).
This page records what must be true before V1 is presented publicly or included in
an OSS release.

## Current Gate Status

| Gate | Command / Evidence | Status |
|---|---|---|
| Docs drift guard | `npm run check:docs` | Required on every PR and release |
| Linear reconciliation | `npm run check:v1-linear` | Optional in public CI; required locally when credentials are available |
| Operator-loop tests | `npm run build:loop` + `node --test test/operator-loop/*.test.mjs` | Required before V1 release |
| Full repo tests | `npm test` | Required before merge/release |
| Scaffold validators | `validation/validate-all.sh <workspace>` | Required when scaffold or stamped workspace behavior changes |
| Secret/leak gates | `validation/check-secrets.sh .` and `scripts/leak-gate.sh .` | Required before public release |
| Website alignment | Cross-repo docs sync/review | Required before website says V1 is shipped |

## AIO-122 Exit Criteria Evidence

| Exit criterion | Evidence source | Release state |
|---|---|---|
| Three consecutive weekly dogfood runs per active user with zero admin/private-tier leaks | `.aios/loop/closeouts/<stamp>/verifier-*.json`, leak-withheld counts, dogfood notes | Not yet fully recorded |
| Daily loop run on majority of working days | C8 telemetry or local dogfood log | Blocked on C8 |
| Median weekly closeout under 20 minutes after setup | Dogfood timing log | Not yet fully recorded |
| Shareable digest passes must-pass verifier criteria in at least 90% of accepted runs | `verifier-*.json` statuses across accepted runs | Not yet fully recorded |
| At least 70% of accepted weekly runs produce approved next-week actions | `next-week-actions.json`, `aios loop writeback` approval notes | Not yet fully recorded |
| CLI and cockpit parity against same plan/review/approve model | CLI commands are present; MCP currently exposes `aios_loop_collect` only | Cockpit parity remains a release-scoping decision |

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
