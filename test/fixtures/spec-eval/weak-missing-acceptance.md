# Spec — add a `--quiet` flag to `aios spec eval`

## Why

Agents that only care about the exit code want to suppress the human-readable findings block. A
`--quiet` flag would print nothing on success and only the verdict line on failure.

## What

Add `--quiet` to `aios spec eval`, routing through the existing formatter in `scripts/spec-eval.mjs`.

## Integration points

- `scripts/spec-eval.mjs` — `cmdSpec` and `formatFindings`, unchanged in shape.

## Deps

Deps: none.

## Scope

In scope: the `--quiet` flag. Out of scope: a global verbosity config.

## Build-with

Build-with: opus / medium effort.
