# Spec — publish readiness scores to the brain

## Why

Leads want visibility into which specs pass readiness across the org, so we should push each
score up where everyone can see the trend.

## What

After every `aios spec eval`, push the digest of the score to the brain so it shows on the shared
dashboard.

## Acceptance criteria

- `aios spec eval <file> --publish` sends a record and prints `pushed: ok` on success.
- On a network failure it prints `pushed: failed` and still exits with the eval's own code.
- A new test asserts the push payload carries the verdict and the score.

## Integration points

- `scripts/spec-eval.mjs` — `cmdSpec` gains a `--publish` branch after the eval completes.

## Deps

Deps: none.

## Scope

In scope: the publish path. Out of scope: a historical trend chart on the dashboard.

## Build-with

Build-with: opus / high effort.
