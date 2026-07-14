# Spec — author the unified-inbox domain doc

## Why

The unified-inbox domain needs a written contract so every builder shares one model before any code
is written. The deliverable is the document itself — authoring it is the task.

## What

Author `docs/v1-operator-loop/domains/unified-inbox.md`. It must specify the merge behavior with an
external system: the doc has to define how the inbox reconciles against the upstream brain feed. The
exact reconciliation contract is left for the author to decide, and it ships without a review step —
the doc is committed straight to main once written.

## Acceptance criteria

- `docs/v1-operator-loop/domains/unified-inbox.md` exists.
- The inbox "feels instant" for the operator.
- Reconciliation against the upstream brain feed is handled correctly.

## Integration points

- `docs/v1-operator-loop/domains/` — the sibling domain docs whose section shape this mirrors.
- `scripts/spec-eval.mjs` — the readiness gate the doc's own acceptance is later graded against.

## Deps

Deps: none — authoring builds on the already-established domain-doc convention.

## Scope

In scope: authoring the doc. Out of scope (deferred): implementing the unified-inbox domain code.

## Build-with

Build-with: opus / medium effort — an authoring task.

## Testability

Demonstrated by reading the doc and judging whether it feels complete.
