---
# eval_tier: deterministic (default) runs the fast offline checks, which still BLOCK.
# Set `full` to ALSO get the adversarial LLM review — worth it for safety, cross-repo
# contracts, or anything you want a second opinion on. `aios spec eval --adversarial` does
# the same thing per-run without editing the spec.
eval_tier: deterministic
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

<!-- SR3, SR9: Name real file paths and contracts this slice builds on or extends.
     Paths here are checked against the repo tree, so cite EXISTING files exactly.
     For a file this slice creates, say so on the line — "new file: x" or "create x" —
     or list it under a "## New files to create" heading. Either is recognised.
     For a path in a SIBLING repo, put it under a heading naming it upstream/external. -->

- `path/to/existing/module.ts` — (role)
- (TODO: or "new file: path/to/new-module.ts")

## Dependencies

<!-- SR4: Which slices/issues must land first, or state "none" explicitly. -->

Depends on: none

## Scope

**In:** (TODO: what this single PR delivers)

**Deferred:** (TODO: follow-up issues or slices cut at authoring time)

**Fenced out:** (only if this spec raises a blanket constraint — "no change to any file
`/` renders", "must stay byte-identical", "do not touch X". List what that fence pushes
out and where each item lands: a sibling spec, a follow-up issue. A `Deferred:` list does
not cover it; the fence is what excluded the work, so the fence has to account for it.
Delete this line if no fence is raised.)

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
