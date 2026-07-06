# CQ1 — Full test matrix + CI green

Parent: Pre-release code quality epic.

## Why

All test suites must pass on `main` before ship.

## What

Run:
```bash
npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test
validation/validate-all.sh examples/synthetic-consultant
```

## Acceptance criteria

- Commands above exit **0** on `main`.
- `npm run aios -- spec eval docs/pre-ship/cq1-test-matrix.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** test output pasted in epic comment or triage log.
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

- `npm test` exit **0**.
- `validation/validate-all.sh examples/synthetic-consultant` exit **0**.
