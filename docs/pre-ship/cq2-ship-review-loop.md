# CQ2 — Ship review-loop (AIO-254) triage

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-254 needs explicit deferral before ship — no scope ambiguity.

## What

1. Create deferral record at `docs/pre-ship/cq2-aio254-deferral.md` (see New files).
2. Post the same text to Linear issue **AIO-286** using the aios-linear CLI.

```bash
LIN="dotenvx run --quiet -f .env -- node ~/.claude/skills/aios-linear/linear.mjs"
$LIN comment AIO-286 docs/pre-ship/cq2-aio254-deferral.md
```

Deferral text must state: **AIO-254 deferred to post-ship** with reason (scope: ship review-loop not
required for v1 public ship).

## New files to create

- `docs/pre-ship/cq2-aio254-deferral.md` — contains the literal token `AIO-254 deferred` and the reason.

## Acceptance criteria

- `docs/pre-ship/cq2-aio254-deferral.md` committed with deferral text.
- `grep -q 'AIO-254 deferred' docs/pre-ship/cq2-aio254-deferral.md` exits **0**.
- Linear comment on AIO-286 posted (operator verifies in Linear UI).
- No AIO-254 code changes in pre-release CQ scope.
- `npm run aios -- spec eval docs/pre-ship/cq2-ship-review-loop.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** deferral markdown file + Linear comment via CLI above.
- **Operator verifies:** AIO-254 remains backlog/deferred in Linear UI, not in-progress for ship.

## Integration points

- `scripts/ship.mjs`

## Deps

Deps: none.

## Scope

Deferral only. Out of scope: AIO-254 implementation.

## Build-with

Build-with: sonnet / low.

## Testability

Named acceptance test:

```bash
grep -q 'AIO-254 deferred' docs/pre-ship/cq2-aio254-deferral.md
```

Exit **0** proves deferral record exists. Linear comment is operator-verified separately.
