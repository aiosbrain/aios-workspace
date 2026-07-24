---
eval_tier: full
spec_gate: block
safety: false
type: issue-spec
---

# TITLE — outcome-oriented slice name

## What / why

<!-- SR1: State the behavior and why it matters. An agent with no conversation history must understand the need. -->

(TODO: what changes and why it matters)

## Outcomes

<!-- Target state after this slice ships — what the user/operator sees, not implementation steps. -->

- (TODO: observable outcome 1)
- (TODO: observable outcome 2)

## Interface / integration points

<!-- SR3, SR9: Name real file paths and contracts this slice builds on or extends. -->

- `path/to/existing/module.ts` — (role)
- (TODO: or "new file: path/to/new-module.ts")

## Dependencies

<!-- SR4: Which slices/issues must land first, or state "none" explicitly. -->

Depends on: none

## Scope

**In:** (TODO: what this single PR delivers)

**Deferred:** (TODO: follow-up issues or slices cut at authoring time)

## Implementation approach

<!-- Optional human guidance. Leave implementation latitude to the builder when unknown. -->

(TODO: optional — delete section if not needed)

## Acceptance criteria

<!-- SR2, SR11: Observable, self-verifiable checks. Prefer commands with exit codes. -->

### Automated

- `npm run …` exits 0
- `node --test test/….test.mjs` passes

### Manual

- (TODO: operator smoke step, or delete subsection)

### Visual

- (TODO: UI/screenshot check, or delete subsection)

## Build-with

Build-with: (model tier, e.g. Fable 5, high effort)

## Tier safety

<!-- SR7: Required when brain/sync/shareable surfaces are touched. Otherwise: "No brain/sync surfaces touched." -->

No brain/sync surfaces touched.
