# CQ3 — V1 Linear drift + AIO-122 close-out

Linear task: AIO-287. Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

AIO-122 must be closable with C1–C8 Done and no stale blockers.

## Prerequisites

Before executing, verify these tool dependencies exist. If any check fails, the builder records the missing item and stops — the operator must provide the dependency:

```bash
# Required: check:v1-linear npm script
npm run check:v1-linear --help >/dev/null 2>&1 || echo "check:v1-linear script not found"

# Required: the aios CLI with the built-in Linear adapter
command -v aios >/dev/null 2>&1 || echo "aios not installed"

# Required: a resolvable Linear credential (env, workspace vault, or `aios connect linear`)
aios linear status || echo "Linear not connected — run `aios connect linear`"
```

If `npm run check:v1-linear` is not a defined script: the operator must add it to `package.json` before CQ3 can be executed.

If `aios` is missing: install via `npm install -g @aiosbrain/aios`. If no Linear
credential resolves, run `aios connect linear`.

If `.env` is missing or lacks `LINEAR_API_KEY`: the operator provides the token; the builder writes:
```bash
echo 'LINEAR_API_KEY=<operator-provided token>' >> .env
```
`.env` is gitignored — never commit it.

## What

1. Run drift check: `npm run check:v1-linear` (wraps `scripts/check-v1-linear-drift.mjs`).
2. Update Linear via aios-linear CLI so C1–C8 in `docs/v1-operator-loop/README.md` are marked **Done**.
3. Remove stale `blocked by AIO-130` relation on AIO-122. The drift command queries Linear's
   inverse `blocks` relations and fails if that relation remains.

```bash
LIN="aios linear"
npm run check:v1-linear   # must exit 0 before Linear edits
# Mark C1–C8 done per README checklist (example — adjust issue IDs from check output):
# $LIN set-state <C-issue-id> done
# $LIN unblock AIO-122
```

Record `check:v1-linear exit: <N>` in PR comment or triage log.

## Acceptance criteria

- `npm run check:v1-linear` exits **0**.
- Output contains eight `ok C<N>: AIO-<id> done` lines matching the component tokens in
  `docs/v1-operator-loop/README.md`.
- Output contains `ok closeout: AIO-122 has no stale AIO-130 blocker`.

## Builder vs operator closure

- **Builder delivers:** `check:v1-linear` exit **0** logged; C1–C8 Done and stale-blocker absence
  proven by the same credentialed command.
- **Operator verifies:** evidence is linked from AIO-287 before changing its state to Done.

## Integration points

- `scripts/check-v1-linear-drift.mjs`
- `docs/v1-operator-loop/README.md`
- the built-in `aios linear` adapter (Linear CLI)

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

Exit **0** plus the `ok closeout` output proves README ↔ Linear alignment and absence of the stale
AIO-130 blocker. The command exits **1** when a component drifts, AIO-122 is missing, or that blocker
is present.
