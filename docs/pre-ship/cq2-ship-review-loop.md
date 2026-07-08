# CQ2 — Ship review-loop (AIO-254) triage

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-254 needs explicit deferral before ship — no scope ambiguity.

## Prerequisites

Before executing, verify these tool dependencies exist. If any check fails, the builder records the missing item and stops — the operator must provide the dependency:

```bash
# Required: aios-linear CLI (Node.js script for Linear API access)
test -f ~/.claude/skills/aios-linear/linear.mjs || echo "aios-linear not installed"

# Required: dotenvx CLI for secure env loading
command -v dotenvx >/dev/null 2>&1 || echo "dotenvx not found"

# Required: .env file with LINEAR_API_KEY
test -f .env && grep -q 'LINEAR_API_KEY=' .env || echo "LINEAR_API_KEY not set in .env"
```

If `~/.claude/skills/aios-linear/linear.mjs` is missing: the operator must install the `aios-linear` skill. The builder cannot install it.

If `dotenvx` is missing: install via `npm install -g @dotenvx/dotenvx`.

If `.env` is missing or lacks `LINEAR_API_KEY`: the operator provides the token; the builder writes:
```bash
echo 'LINEAR_API_KEY=<operator-provided token>' >> .env
```
`.env` is gitignored — never commit it.

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

- `docs/pre-ship/cq2-aio254-deferral.md` — contains the literal token `AIO-254 deferred` and the reason. (Create parent directory `docs/pre-ship/` if it does not exist.)

## Acceptance criteria

- `docs/pre-ship/cq2-aio254-deferral.md` committed with deferral text.
- `grep -q 'AIO-254 deferred' docs/pre-ship/cq2-aio254-deferral.md` exits **0**.
- The CLI invocation `dotenvx run --quiet -f .env -- node ~/.claude/skills/aios-linear/linear.mjs comment AIO-286 docs/pre-ship/cq2-aio254-deferral.md` exits **0**.
- Linear comment on AIO-286 is posted (operator verifies in Linear UI).
- No AIO-254 code changes in pre-release CQ scope.

## Builder vs operator closure

- **Builder delivers:** deferral markdown file + Linear comment via CLI above.
- **Operator verifies:** AIO-254 remains backlog/deferred in Linear UI, not in-progress for ship.

## Integration points

- `scripts/ship.mjs`

## Deps

- `aios-linear` CLI (Node.js script at `~/.claude/skills/aios-linear/linear.mjs`) — requires Node.js runtime.
- `dotenvx` CLI (available in PATH).
- A `.env` file in the project root containing the environment variable required by the aios-linear CLI: `LINEAR_API_KEY=<your Linear personal API token>`.

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