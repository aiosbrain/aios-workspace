# CQ2 — Ship review-loop (AIO-254) triage

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-254 needs explicit deferral before ship — no scope ambiguity.

## Prerequisites

Before executing, verify these tool dependencies exist. If any check fails, the builder records the missing item and stops — the operator must provide the dependency:

```bash
# Required: the aios CLI with the built-in Linear adapter
command -v aios >/dev/null 2>&1 || echo "aios not installed"

# Required: a resolvable Linear credential (env, workspace vault, or `aios connect linear`)
aios linear status || echo "Linear not connected — run `aios connect linear`"
```

If `aios` is missing: install via `npm install -g @aiosbrain/aios`.

If no Linear credential resolves: the operator provides the token and connects it:
```bash
aios connect linear
```
`.env` is gitignored — never commit it.

## What

1. Create deferral record at `docs/pre-ship/cq2-aio254-deferral.md` (see New files).
2. Post the same text to Linear issue **AIO-286** using the aios-linear CLI.

```bash
LIN="aios linear"
$LIN comment AIO-286 docs/pre-ship/cq2-aio254-deferral.md
```

Deferral text must state: **AIO-254 deferred to post-ship** with reason (scope: ship review-loop not
required for v1 public ship).

## New files to create

- `docs/pre-ship/cq2-aio254-deferral.md` — contains the literal token `AIO-254 deferred` and the reason. (Create parent directory `docs/pre-ship/` if it does not exist.)

## Acceptance criteria

- `docs/pre-ship/cq2-aio254-deferral.md` committed with deferral text.
- `grep -q 'AIO-254 deferred' docs/pre-ship/cq2-aio254-deferral.md` exits **0**.
- The CLI invocation `aios linear comment AIO-286 docs/pre-ship/cq2-aio254-deferral.md` exits **0**.
- Linear comment on AIO-286 is posted (operator verifies in Linear UI).
- No AIO-254 code changes in pre-release CQ scope.

## Builder vs operator closure

- **Builder delivers:** deferral markdown file + Linear comment via CLI above.
- **Operator verifies:** AIO-254 remains backlog/deferred in Linear UI, not in-progress for ship.

## Integration points

- `scripts/ship.mjs` — **devtools-owned** since AIO-662: the file lives in
  [`aiosbrain/aios-devtools`](https://github.com/aiosbrain/aios-devtools), not in this repo. If it is
  absent locally, that is expected — read it there, or drive it via `npm run aios -- ship`.

## Deps

- The `aios` CLI with the built-in Linear adapter (`aios linear …`) — requires Node.js runtime.
- A resolvable Linear credential: `LINEAR_API_KEY` in the environment, the workspace vault, or the reference stored by `aios connect linear`.

## Scope

Deferral only. Out of scope: AIO-254 implementation.

## Build-with

Build-with: sonnet / low.

## Tier-safety posture

Low risk. This operation posts a comment to a Linear issue and does not modify project source code or critical state. The only side effect is a comment on AIO-286.

## Testability

Named acceptance test:

```bash
grep -q 'AIO-254 deferred' docs/pre-ship/cq2-aio254-deferral.md
```

Exit **0** proves deferral record exists. Linear comment posting is verified by the CLI exit **0** and operator confirmation.