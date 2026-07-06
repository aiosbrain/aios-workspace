```markdown
# CQ2 — Ship review-loop (AIO-254) triage

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-254 needs explicit deferral before ship — no scope ambiguity.

## Pre-flight checks (builder)

The following must be present before the builder executes the script. If either check fails,
the builder stops and asks the operator to provide the missing item.

```bash
# Check that the aios-linear CLI is installed
test -f ~/.claude/skills/aios-linear/linear.mjs

# Check that the .env file exists and contains LINEAR_API_KEY
grep -q 'LINEAR_API_KEY=' .env
```

If `~/.claude/skills/aios-linear/linear.mjs` is missing: the operator must install the
`aios-linear` skill in the agent’s standard location. The builder cannot invent installation
instructions; this is an operator-provided dependency.

If `.env` is missing: the builder creates it using a token provided by the operator:

```bash
echo 'LINEAR_API_KEY=<operator-provided token>' > .env
```

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
```