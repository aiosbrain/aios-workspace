# CQ1 — Full test matrix + CI green

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

All test suites must pass on `main` before ship.

## Prerequisites

From the aios-workspace repo root on branch `main`:

```bash
git checkout main
npm install
```

## What

Run:

```bash
npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test
validation/validate-all.sh examples/synthetic-consultant
```

## Acceptance criteria

- Prerequisites above completed (document `git rev-parse --abbrev-ref HEAD` = `main` in triage log).
- Commands above exit **0** on `main`.
- `npm run aios -- spec eval docs/pre-ship/cq1-test-matrix.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** paste command output (exit codes) into `docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md`
  notes column or epic comment; confirm `main` branch.
- **Operator verifies:** CI green on `main` matches local run.

## Integration points

- `package.json`
- `test/operator-loop/*.test.mjs`
- `validation/validate-all.sh`

## Deps

Depends on SEC4 (AIO-157) for ship-related tests.

## Scope

Test execution. Out of scope: new tests.

## Build-with

Build-with: sonnet / low.

## Testability

Named acceptance test (run from repo root after prerequisites):

```bash
npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test && \
  validation/validate-all.sh examples/synthetic-consultant
```

Exit **0** proves CQ1 matrix green.
