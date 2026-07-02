# Spec — add a `--rubric` override to `aios spec eval`

## Why

Teams that fork the workspace want to grade specs against their own readiness bar without editing
the pinned rubric. A `--rubric <path>` flag lets a caller point the evaluator at an alternate
rubric file, so the harness is reusable across contexts without a code change.

## What

Add a `--rubric <path>` option to `aios spec eval` and `aios spec fix`. When set, the harness loads
that rubric instead of the default `.claude/rubrics/spec-readiness.md`.

## Acceptance criteria

- `aios spec eval <file> --rubric /tmp/other.md` loads `/tmp/other.md`; a malformed rubric exits `4`.
- `aios spec eval <file>` with no flag still loads `.claude/rubrics/spec-readiness.md`.
- `aios spec eval <file> --rubric missing.md` exits `4` with a "rubric not found" message.
- A new test asserts the flag routes to the given path (returns the parsed rows from that file).

## Integration points

- `scripts/spec-eval.mjs` — `cmdSpec` already resolves `flag("--rubric") ?? default`; verify it.
- `scripts/relay.mjs` — the `--spec` gate hard-codes the default rubric path; leave it unchanged.
- `.claude/rubrics/spec-readiness.md` — the default rubric, unchanged.

## Deps

Deps: none — this builds only on the already-shipped `loadRubric` path.

## Scope

In scope: the `--rubric` flag on `eval` and `fix`. Out of scope (deferred): a per-repo default
rubric config key; per-criterion enable/disable.

## Build-with

Build-with: opus / medium effort — a small, well-bounded CLI flag change with an existing path.

## Testability

Demonstrated by the new case in `test/spec-eval-cli.test.mjs` asserting the flag routes correctly.
