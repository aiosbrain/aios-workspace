# Spec — author the unified-inbox domain doc

## Why

The unified-inbox domain needs a written contract so every builder shares one model before any code
is written. The deliverable is the document itself — authoring it is the task.

## What

Create a new file `docs/v1-operator-loop/domains/unified-inbox.md`, following the domain-spec
section convention its sibling docs use. The author chooses the internal ordering and naming of the
state model and the ranking rules — that is bounded design latitude whose output is read and
approved in a PR before it merges, so any wrong call is caught and reversed in review.

## Acceptance criteria

- The new file `docs/v1-operator-loop/domains/unified-inbox.md` contains all five required sections
  (`## Why`, `## Reuse`, `## Build`, `## Signal contract`, `## Acceptance`) — checked by grep.
- Every item under `## Build` names a file path that resolves in the repo — checked by grep + test.
- The doc is opened as a PR and approved by a reviewer before merge.

## Integration points

- `docs/v1-operator-loop/domains/` — the sibling domain docs whose section shape this mirrors.
- `scripts/spec-eval.mjs` — the readiness gate the doc's own acceptance is later graded against.

## Deps

Deps: none — authoring builds on the already-established domain-doc convention.

## Scope

In scope: authoring the doc. Out of scope (deferred): implementing the unified-inbox domain code.

## Build-with

Build-with: opus / medium effort — a bounded authoring task, reviewed before merge.

## Testability

Demonstrated by a structural check that all five sections exist and every `## Build` path resolves.
