# Spec — add a spec-readiness cache

## Why

Re-evaluating the same unchanged spec wastes an LLM call. A cache keyed on the spec hash would
skip the adversarial layer when nothing changed, so repeated `aios relay --spec` runs are cheap.

## What

Add a content-hash cache to the readiness harness.

## Acceptance criteria

- `aios spec eval <file>` a second time on an unchanged file prints `cache: hit` and exits `0`.
- Editing the file invalidates the cache; the next run prints `cache: miss` and re-evaluates.
- A new test asserts the hash key changes when the spec bytes change.

## Reuse & integration

- This reuses `src/operator-loop/cache-store.ts` for the append-only hash store and folds it on read.
- It extends `src/operator-loop/spec-cache.ts` to key on the SHA-256 of the spec bytes.

## Deps

Deps: none.

## Scope

In scope: the read-through cache. Out of scope: cross-machine cache sharing.

## Build-with

Build-with: opus / high effort.
