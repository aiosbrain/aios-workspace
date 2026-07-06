# EPIC — Pre-release code quality review

Linear epic title: **EPIC: Pre-release code quality review**  
Owner: john@john-ellison.com

## Why

Ship requires test suites, operator-loop build, and PR hygiene green on `main`.

## What

Execute four child specs:

| Child | Spec path |
|-------|-----------|
| CQ1 | `docs/pre-ship/cq1-test-matrix.md` |
| CQ2 | `docs/pre-ship/cq2-ship-review-loop.md` |
| CQ3 | `docs/pre-ship/cq3-v1-linear-drift.md` |
| CQ4 | `docs/pre-ship/cq4-pr-triage.md` |

## Acceptance criteria

- All four child specs **SPEC_READY**.
- `npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test` exits **0** on `main` (CQ1).
- `validation/validate-all.sh examples/synthetic-consultant` exits **0** (CQ1).
- AIO-254 deferral documented per CQ2 (`docs/pre-ship/cq2-aio254-deferral.md` + Linear comment).
- `docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md` lists open PRs with merge/waive decisions (CQ4).
- `npm run aios -- spec eval docs/pre-ship/epic-pre-release-code-quality.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** CQ1–CQ4 child PRs closed; all child specs `SPEC_READY`; triage log committed.
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

Named acceptance tests:

```bash
npm run aios -- spec eval docs/pre-ship/cq1-test-matrix.md
npm run aios -- spec eval docs/pre-ship/cq2-ship-review-loop.md
npm run aios -- spec eval docs/pre-ship/cq3-v1-linear-drift.md
npm run aios -- spec eval docs/pre-ship/cq4-pr-triage.md
npm test
npm run check:v1-linear
```

All exit **0** before epic close.
