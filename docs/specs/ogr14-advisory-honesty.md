---
eval_tier: full
spec_gate: block
safety: false
type: issue-spec
---

# OGR14: make the advisory contract legible — remove the unreachable failure path

## What / why

`validation/check-file-governance.mjs` (OGR14, the anti-sprawl ratchet) is **advisory by
design**. Its own header says so — *"advisory — doesn't fail the run; this is a ratchet, not
a wall"* — and `test/check-file-governance.test.mjs:58` asserts it:
`"OGR14: warns (still exits 0 — advisory ratchet) on a rogue top-level dir"`.

The code does not read that way. It declares `let errors = 0` (line 48) and ends in a
three-branch summary (lines 178–187) whose final branch prints `OGR14 FAILED — N error(s)`
and calls `process.exit(1)` (line 186). **`errors` is never incremented.** Only `warnings++`
occurs, at lines 77, 164, and 167. `git log -S'errors++'` on this file returns nothing — the
counter has been dead since the validator was introduced in AIO-352.

So the file presents a failure path that cannot execute, and the runner reinforces the
confusion: `validation/validate-all.sh` labels the other two always-exit-0 validators
`"OGR10 — Agent Readiness (advisory)"` and `"OGR13 — Modularity (advisory)"`, but line 66
reads `"OGR14 — File Governance (anti-sprawl ratchet)"` with no advisory marker. OGR10 and
OGR13 contain zero `process.exit(1)` calls; OGR14 contains one that is unreachable.

This is not cosmetic. Reading this file, **two separate agents in one session concluded
OGR14 was a broken enforcement gate** and drafted work to "fix" it — work that would have
contradicted the documented design. Dead code that implies a contract the system does not
honour costs review time and invites wrong changes.

This slice makes the code state the contract the header, the tests, and the runtime
behaviour already agree on. **It does not change what OGR14 detects or whether it fails.**

## Outcomes

- Reading `validation/check-file-governance.mjs` top to bottom, an agent with no conversation history
  concludes OGR14 cannot fail a run — because there is no code suggesting otherwise.
- `validation/validate-all.sh` labels OGR14 consistently with the other advisory validators.
- A regression test pins the advisory contract, so a future edit that reintroduces a failure
  path fails CI rather than silently changing the gate's meaning.
- Exit-code behaviour is byte-identical to today for every input.

## Interface / integration points

- `validation/check-file-governance.mjs` — OGR14 itself. Dead `errors` counter (line 48) and
  the unreachable `else` branch in the summary block (lines 184–187).
- `validation/validate-all.sh` — line 66 invokes OGR14; lines 64–65 show the `(advisory)`
  labelling convention to match. `run_check()` (lines 32–43) increments `FAILED` on a
  non-zero exit, which is why the label and the exit contract must agree.
- `test/check-file-governance.test.mjs` — existing suite; already asserts `code === 0` in six
  cases. Extended here, not replaced.
- `hooks/file-governance-guard.mjs` — supplies `classifyPath` / `checkFrontmatter` /
  `isContentFile` / `isFrontmatterExempt`. **Not modified**: classification rules are shared
  with layer 1 and changing them would alter what OGR14 detects.
- `scripts/git-files.mjs` — supplies `gitFiles`. Not modified.

## Dependencies

Depends on: none — this slice is self-contained and can land in any order.

Traceability: originates from **AIO-352** (*"Workspace file-creation governance: enforced
frontmatter + spine routing (anti-sprawl ratchet)"*, Done), which introduced OGR14 and both
governance layers. This slice does not reopen that work; it removes an artefact left behind
by it. The `errors` counter has been dead since that original commit, `3b8fbe3`.

## Scope

**In:** one PR against `validation/check-file-governance.mjs`, `validation/validate-all.sh`,
and `test/check-file-governance.test.mjs`.

1. Remove the `errors` counter and collapse the summary to the two reachable states: clean,
   and passed-with-warnings. Both exit 0.
2. Keep the `OGR14 PASSED` / `OGR14 PASSED with N warning(s)` strings byte-identical — the
   existing tests match on stdout.
3. Retain the two `process.exit(1)` calls at lines 42 and 59. Those are **invocation
   errors** — missing `<path-to-workspace-repo>`, and unreadable target directory — not
   findings, and must keep failing.
4. Relabel line 66 of `validation/validate-all.sh` to `"OGR14 — File Governance (advisory ratchet)"`.
5. Add a regression test asserting exit 0 when both check types fire simultaneously.
6. Add a short comment at the summary block stating that findings are warnings by design,
   citing AIO-352, so the next reader does not re-derive this.

**Deferred:** whether OGR14 *should* enforce is a **product decision this slice does not
take**. The header states the ratchet-not-a-wall intent deliberately. If the team wants
enforcement, that is a separate issue that must also decide which findings are promotable,
what the migration path is for existing workspaces, and whether `--critical` should include
it. Nothing here forecloses that.

## Implementation approach

Vertical is not meaningful for a single-file cleanup with no layers; the ordering below is
simply safest-first, each step independently verifiable.

Capture the deterministic signal before changing anything: run
`node --test test/check-file-governance.test.mjs` and
`./validation/check-file-governance.mjs <fixture>; echo $?` on a sprawl fixture, and record
both the exit code and stdout. That recording is the oracle the refactor is checked against —
the change is correct only if it reproduces those bytes exactly.

1. Add the regression test first (both check types firing, assert exit 0). It should
   pass immediately against current behaviour — that is the point: it pins behaviour *before*
   the refactor, so the refactor is provably neutral.
2. Remove the dead branch and counter.
3. Relabel in `validation/validate-all.sh`.
4. Re-run the full suite and confirm no stdout assertion moved.

The safety property throughout: **no change to `classifyPath` usage, to which paths are
scanned, or to any exit code for any input.** If a diff touches classification, it is out of
scope.

## Acceptance criteria

### Automated

- `node --test test/check-file-governance.test.mjs` passes, including a new case that
  triggers a rogue top-level directory **and** a missing-frontmatter content file in the same
  run and asserts `code === 0`.
- `grep -c 'errors' validation/check-file-governance.mjs` returns `0`.
- `grep -c 'OGR14 FAILED' validation/check-file-governance.mjs` returns `0`.
- `grep -q 'OGR14 — File Governance (advisory ratchet)' validation/validate-all.sh` exits 0.
- `./validation/check-file-governance.mjs` with **no argument** still exits `1` and prints the
  usage line, and with a **nonexistent directory** still exits `1` — both invocation guards
  are untouched.
- `./validation/validate-all.sh <fixture-workspace-with-sprawl>` reports OGR14 among the
  passing validators and does not increment `FAILED`.
- `npm test` passes.
- `npm run check:docs` passes — OGR14 appears in no drift-marker block, so this must stay
  green rather than needing a snapshot refresh.

### Manual

- Scaffold a throwaway workspace, add a rogue top-level directory, run
  `./validation/validate-all.sh <path>`, and confirm the run ends `All validators passed.`
  with OGR14 having printed a yellow warning for the rogue entry.

## Build-with

Build-with: Sonnet 5, medium effort. Single-file cleanup with an explicit no-behaviour-change
constraint and existing test coverage to hold the line.

## Tier safety

No brain/sync surfaces touched. OGR14 reads the workspace tree and writes only to stdout; it
pushes nothing and reads no tier-scoped content.
