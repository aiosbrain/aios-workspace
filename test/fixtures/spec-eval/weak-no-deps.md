# Spec — add a `--summary` line to `aios spec fix`

## Why

Operators want a one-line summary after a fix run so they can grep logs for the outcome without
parsing the whole scorecard.

## What

Print a single trailing summary line from `scripts/spec-eval.mjs` after the fix loop finishes.

## Acceptance criteria

- `aios spec fix <file>` prints a final line like `spec fix: converged in 1 iteration`.
- On budget exhaustion it prints `spec fix: exhausted after 2 iterations` and exits `1`.
- A new test asserts the summary line is present in stdout.

## Integration points

- `scripts/spec-eval.mjs` — the `runFixLoop` and `formatScorecard` helpers.

## Scope

In scope: the summary line. Out of scope: machine-readable summary (already covered by `--json`).

## Build-with

Build-with: opus / medium effort.
