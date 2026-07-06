# ARCH2 — Operator loop + ship pipeline coupling review

Owner: john@john-ellison.com
Parent: Pre-release architecture epic.

## Why

Operator loop and ship pipeline boundaries must be clear before ship. Coupling that leaks across these boundaries risks shipping instabilities and makes future changes brittle.

## What

Review `src/operator-loop/*` versus `scripts/ship.mjs`, `scripts/relay-core.mjs`, and `scripts/build.mjs`.  
Produce a review document that identifies and labels at least **two coupling smells** — concrete coupling patterns that risk shipping stability.

A **coupling smell** is a specific, observable code pattern that cross-cuts the operator loop and ship pipeline. Examples (non‑exhaustive; the engineer’s judgment applies):

- A direct import of ship‑script internals from the operator loop with no stable, documented interface
- Shared mutable configuration or state that ties the two subsystems together
- Hardcoded file paths that assume a common deployment layout between the two
- A missing abstraction layer that forces one subsystem to know implementation details of the other
- Transactional boundaries that bleed across the two domains (e.g., a ship step that implicitly depends on operator‑loop side‑effects)

Smells must refer to specific lines, modules, or interaction patterns; general design opinions are not sufficient.

## Document contract

The deliverable is a single Markdown file that must satisfy the following contract:

- File path: `docs/pre-ship/arch2-operator-loop-ship-coupling-review.md`
- File title: `# ARCH2 — Operator loop + ship pipeline coupling review`
- Contains a section headed exactly `## Operator loop ↔ ship coupling`
- Inside that section, each identified coupling point is tagged on its own line or in a list item with one of the exact labels `fix-before-ship` or `post-ship-debt`

## Acceptance criteria

1. A review document exists at `docs/pre-ship/arch2-operator-loop-ship-coupling-review.md`.
2. The document contains the section heading `## Operator loop ↔ ship coupling`.
3. The document contains at least two lines that each include `fix-before-ship` or `post-ship-debt`.
4. The following verification command, executed from the repository root, exits **0**:
   ```sh
   test -f docs/pre-ship/arch2-operator-loop-ship-coupling-review.md && \
   grep -q '^## Operator loop ↔ ship coupling' docs/pre-ship/arch2-operator-loop-ship-coupling-review.md && \
   [ $(grep -c -e 'fix-before-ship' -e 'post-ship-debt' \
        docs/pre-ship/arch2-operator-loop-ship-coupling-review.md) -ge 2 ]
   ```

## Builder vs operator closure

- **Builder delivers:** review document that satisfies the document contract and passes the verification command.
- **Operator verifies:** `fix-before-ship` smells have linear children or PR links; `post-ship-debt` items are tracked.

## Integration points (existing code)

- `src/operator-loop/` (directory reviewed)
- `scripts/ship.mjs`
- `scripts/relay-core.mjs`
- `scripts/build.mjs`

## New files to create

- `docs/pre-ship/arch2-operator-loop-ship-coupling-review.md`

## Deps

Deps: none.

## Scope

Read‑only review. Out of scope: refactors, implementation changes, or new tests.

## Build-with

Build-with: opus / high.

## Tier-safety

Tier-safety: not applicable (read‑only review; no code surfaces are changed).

## Testability

The verification command in the acceptance criteria is the named acceptance test. Running it and observing exit code **0** proves that the review document exists, contains the required heading, and contains at least two labelled smells.