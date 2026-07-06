```markdown
# CQ1 — Full test matrix + CI green

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

All test suites must pass on `main` before ship.

## Prerequisites

From the aios-workspace repo root on branch `main`:

```bash
git checkout main
npm install
# The validation fixture is a repo-tracked example directory:
# examples/synthetic-consultant/ exists in the repo; if absent, skip the
# validate-all.sh step and record "fixture missing" in the triage log.
```

## What

Run:

```bash
npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test && \
  (if [ -d examples/synthetic-consultant ]; then validation/validate-all.sh examples/synthetic-consultant; else echo "fixture missing" >> docs/pre-ship/cq4-pr-triage-$(date +%Y-%m-%d).md; fi)
```

## Acceptance criteria

- Prerequisites above completed (document `git rev-parse --abbrev-ref HEAD` = `main` in triage log).
- The commands above exit **0** on `main`.
- `npm run aios -- spec eval docs/pre-ship/cq1-test-matrix.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** Run the acceptance tests below and paste exit codes into `docs/pre-ship/cq4-pr-triage-$(date +%Y-%m-%d).md` notes column or epic comment; confirm `main` branch.
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

Acceptance tests (run from repo root after prerequisites):

1. Core test matrix:
   ```bash
   npm run build:loop && node --test test/operator-loop/*.test.mjs && npm test && \
     (if [ -d examples/synthetic-consultant ]; then validation/validate-all.sh examples/synthetic-consultant; else echo "fixture missing" >> docs/pre-ship/cq4-pr-triage-$(date +%Y-%m-%d).md; fi)
   ```
   Exit **0** satisfies first two acceptance criteria.

2. Spec self-evaluation:
   ```bash
   npm run aios -- spec eval docs/pre-ship/cq1-test-matrix.md
   ```
   Exit **0** satisfies third acceptance criterion.
```