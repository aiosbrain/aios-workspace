# EPIC — Pre-release code quality review

Linear epic title: **EPIC: Pre-release code quality review**

## Why

Ship requires test suites, operator-loop build, and PR hygiene green on `main`.

## What

Children CQ1–CQ4: test matrix, AIO-254 deferral, V1 Linear drift, PR triage.

## Acceptance criteria

- `npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test` exits **0** on `main`.
- `validation/validate-all.sh examples/synthetic-consultant` exits **0**.
- AIO-254 deferral documented in Linear comment on AIO-286.
- `docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md` lists open PRs with merge/waive decisions.
- `npm run aios -- spec eval docs/pre-ship/epic-pre-release-code-quality.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** CQ child issues closed; test commands exit **0**; triage log committed.
- **Operator verifies:** AIO-122 closable (C1–C8 Done in Linear); no blocking PRs without waiver.

## Integration points

- `package.json`
- `test/operator-loop/*.test.mjs`
- `scripts/check-v1-linear-drift.mjs`
- `validation/validate-all.sh`

## Deps

Depends on SEC4 (AIO-157 merge) before declaring CQ complete.

## Scope

In scope: test runs, drift, PR triage. Out of scope: AIO-254 implementation.

## Build-with

Build-with: sonnet / medium.

## Tier-safety

N/A — no sync changes.

## Testability

- `npm test` exit **0**.
- `npm run check:v1-linear` exit **0**.
