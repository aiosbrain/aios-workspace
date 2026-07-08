# CQ3 — V1 Linear drift + AIO-122 close-out

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-122 must be closable with C1–C8 Done and no stale blockers.

## Prerequisites

Before executing, verify these tool dependencies exist. If any check fails, the builder records the missing item and stops — the operator must provide the dependency:

```bash
# Required: check:v1-linear npm script
npm run check:v1-linear --help >/dev/null 2>&1 || echo "check:v1-linear script not found"

# Required: aios-linear CLI (Node.js script for Linear API access)
test -f ~/.claude/skills/aios-linear/linear.mjs || echo "aios-linear not installed"

# Required: dotenvx CLI for secure env loading
command -v dotenvx >/dev/null 2>&1 || echo "dotenvx not found"

# Required: .env file with LINEAR_API_KEY
test -f .env && grep -q 'LINEAR_API_KEY=' .env || echo "LINEAR_API_KEY not set in .env"
```

If `npm run check:v1-linear` is not a defined script: the operator must add it to `package.json` before CQ3 can be executed.

If `~/.claude/skills/aios-linear/linear.mjs` is missing: the operator must install the `aios-linear` skill. The builder cannot install it.

If `dotenvx` is missing: install via `npm install -g @dotenvx/dotenvx`.

If `.env` is missing or lacks `LINEAR_API_KEY`: the operator provides the token; the builder writes:
```bash
echo 'LINEAR_API_KEY=<operator-provided token>' >> .env
```
`.env` is gitignored — never commit it.

## What

1. Run drift check: `npm run check:v1-linear` (wraps `scripts/check-v1-linear-drift.mjs`).
2. Update Linear via aios-linear CLI so C1–C8 in `docs/v1-operator-loop/README.md` are marked **Done**.
3. Remove stale `blocked by AIO-130` relation on AIO-122.

```bash
LIN="dotenvx run --quiet -f .env -- node ~/.claude/skills/aios-linear/linear.mjs"
npm run check:v1-linear   # must exit 0 before Linear edits
# Mark C1–C8 done per README checklist (example — adjust issue IDs from check output):
# $LIN set-state <C-issue-id> done
# $LIN unblock AIO-122
```

Record `check:v1-linear exit: <N>` in PR comment or triage log.

## Acceptance criteria

- `npm run check:v1-linear` exits **0**.
- AIO-122 closable in Linear (no stale AIO-130 blocker; C1–C8 Done per `docs/v1-operator-loop/README.md`).

## Builder vs operator closure

- **Builder delivers:** `check:v1-linear` exit **0** logged; Linear C1–C8 states updated via CLI.
- **Operator verifies:** AIO-122 state and blocker relations in Linear UI.

## Integration points

- `scripts/check-v1-linear-drift.mjs`
- `docs/v1-operator-loop/README.md`
- `~/.claude/skills/aios-linear/linear.mjs` (Linear CLI)

## Deps

Deps: none.

## Scope

Drift + Linear hygiene. Out of scope: new loop features.

## Build-with

Build-with: sonnet / low.

## Testability

Named acceptance test:

```bash
npm run check:v1-linear
```

Exit **0** proves README ↔ Linear alignment. Linear UI state is operator-verified.
