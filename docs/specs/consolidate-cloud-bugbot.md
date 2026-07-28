---
eval_tier: full
spec_gate: block
safety: false
type: issue-spec
---

# Consolidate cloud Cursor Bugbot findings so they can block a merge

## What / why

`scripts/consolidate-findings.mjs` is the merge gate. It prints `VERDICT=CLEAR` /
`VERDICT=BLOCKED` and exits `0` / `3`, and `aios ship` treats a `3` as
`REVIEW_NONCONVERGENCE` / `MERGE_BLOCKED` rather than merging.

**Cloud Cursor Bugbot is invisible to it.** Two independent blind spots, both real, both
in this one file:

1. **The check board treats `neutral` as benign.** `checkIsRed` (line 88) keys off
   `gh pr checks --json` buckets, and the comment at line 86 states the intent plainly:
   *"`skipping` (skipped) and `neutral` are benign (neither red nor pending)."* That is
   correct for genuinely-skipped checks. But cloud Bugbot **always** completes with
   `conclusion: neutral` — verified on two separate PRs where it posted real findings:

   | Commit | Bugbot findings | check-run conclusion |
   |---|---|---|
   | `5f4b458` (johnellison/aios#13) | 1 × Medium | `neutral` |
   | `7c67560` (aios-alpha.github.io#81) | 2 × Low | `neutral` |

   So Bugbot can never turn the board red, and `gh pr checks` renders `neutral` in the
   same display bucket as `skipping`, which makes it read as "did not run".

2. **The review-text path only selects CodeRabbit.** `CODERABBIT_SELECT` (line 486) is
   `select(.user.login | test("coderabbit"; "i"))`, and it is the only selector applied
   at all three fetch sites (lines 549, 560, 571). `grep -rn 'cursor\[bot\]' scripts/
   hooks/` returns **nothing** — cloud Bugbot reviews are read nowhere in the repo.

The file header is not wrong: it claims "CI + Local Bugbot + CodeRabbit + optional GPT",
and *Local* Bugbot (`aios review-bugbot`, driven by the Cursor CLI, a mandatory artifact)
is genuinely consumed. Cloud Bugbot — the reviewer that comments on GitHub PRs — is a
different source that was never wired in.

**The observed cost.** On johnellison/aios#13, cloud Bugbot found a Medium-severity bug:
drift-check commands written as consecutive bare `cd X && npm run check:docs` lines, so
executed as one block the second `cd` fails from inside the first repo and that check
silently never runs. It was caught by a human reading the review body. Nothing in the
gate would have stopped that merging — which is doubly pointed, because the PR's own
purpose was removing a silent-skip from the release gate.

## Outcomes

- A cloud Bugbot finding at or above the configured blocking severity produces
  `VERDICT=BLOCKED` and exit `3`, so `aios ship` stops and a human sees it.
- `aios consolidate-findings --repo <owner/repo> --pr <n>` gives any repo a pre-merge
  gate, including repos with no local toolkit checkout (e.g. `aios-website`).
- Stale Bugbot findings from superseded commits cannot block: cloud Bugbot inherits the
  same PR-head freshness boundary CodeRabbit already gets.
- Genuinely-skipped CI checks stay benign — this slice does not make `neutral` red.

## Interface / integration points

- `scripts/consolidate-findings.mjs` — the gate. Extension points, all existing:
  - `CODERABBIT_SELECT` (line 486) — the selector constant to generalise.
  - `filterCurrentHeadCodeRabbit` (line 488) — the PR-head freshness boundary.
  - `extractCodeRabbitSeverities` (line ~245) — the prose→severity mapper, already
    documented as mapping conservatively **upward**.
  - The three fetch sites (lines 549, 560, 571) — issue comments, inline review
    comments, submitted reviews.
  - `checkIsRed` / `checkIsPending` (lines 88, 91) — **read, not modified**.
- `test/consolidate-findings.test.mjs` — unit tests; already exercises
  `extractCodeRabbitSeverities` (line 193) and `filterCurrentHeadCodeRabbit` (line 553).
  Extended, not replaced.
- `test/consolidate-findings.cli.test.mjs` — CLI-level exit-code tests.
- `test/fixtures/consolidate/coderabbit-comments.json` — the fixture shape to mirror.

## New files to create

- `test/fixtures/consolidate/cursor-bugbot-comments.json` — the cloud-Bugbot fixture,
  built from the two real reviews cited above.
- `scripts/ship/gates.mjs` — consumes the exit code (`REVIEW_NONCONVERGENCE: 50`,
  `MERGE_BLOCKED: 60`). **Not modified**: this slice changes what the gate sees, not
  what ship does with a `3`.

## Dependencies

Depends on: none.

Traceability: sibling to **AIO-576** (OGR14 advisory-contract honesty). Same underlying
shape — a gate that reports but cannot fail — found in the same session. Independent
change, no ordering constraint.

## Scope

**In:** one PR against `scripts/consolidate-findings.mjs` plus its two test files and one
new fixture.

1. Generalise the selector: keep `CODERABBIT_SELECT`, add
   `CURSOR_SELECT = 'select(.user.login | test("cursor"; "i"))'`. Fetch both at all three
   sites. `test("cursor"; "i")` matches `cursor[bot]`, the observed login.
2. Generalise `filterCurrentHeadCodeRabbit` to take the source as a parameter (keeping a
   thin named wrapper so existing callers and tests are unaffected), so cloud Bugbot
   inherits the identical head-freshness boundary.
3. Add `extractCursorBugbotSeverities`, mirroring the CodeRabbit mapper. Bugbot emits an
   explicit `**<Level> Severity**` line, so the mapping is direct rather than inferred:
   `Critical → Critical`, `High → High`, `Medium → Medium`, `Low → Low`. Return the max.
   Unrecognised or absent severity with a finding present maps to `Medium` (fail toward
   blocking, consistent with the existing conservative-upward convention).
4. Feed the result into the same deterministic pre-extraction that already reports the
   per-source maximum, so cloud Bugbot participates in the existing fail-closed
   post-validation rather than getting a parallel code path.
5. Update the file header comment to list cloud Bugbot, and record why `neutral` is
   deliberately still benign at the check layer.

**Deferred:**

- **Making `neutral` red.** Explicitly rejected, not postponed: `neutral` is the correct
  benign state for genuinely-skipped checks, and reclassifying it would produce false
  blocks across every repo. The review body is the right signal.
- Bugbot autofix, and any change to `aios ship`'s exit-code handling.
- Wiring a consolidation gate into `aios-website` CI. That repo can call
  `aios consolidate-findings --repo … --pr …` today once this lands; making it a required
  check there is separate work.

## Implementation approach

Capture the deterministic signal first: run
`node --test test/consolidate-findings.test.mjs test/consolidate-findings.cli.test.mjs`
and record the pass count and exit codes. Those are the oracle — CodeRabbit-only
behaviour must be byte-identical afterwards.

Then, thin vertical slice, each step independently verifiable:

1. Create `test/fixtures/consolidate/cursor-bugbot-comments.json` (new file), built from the two **real**
   reviews cited above (1 × Medium on #13, 2 × Low on #81) rather than invented prose, so
   the fixture matches Bugbot's actual output format.
2. Add `extractCursorBugbotSeverities` + unit tests against that fixture. No wiring yet.
3. Generalise the selector and the freshness filter; assert CodeRabbit results unchanged.
4. Wire cloud Bugbot into the pre-extraction; add a CLI-level test asserting exit `3`.
5. Update the header comment.

Safety property throughout: **no change to `checkIsRed`, `checkIsPending`, the exit-code
contract (`0` CLEAR · `3` BLOCKED · `1` error), or any CodeRabbit-derived verdict.**

## Acceptance criteria

### Automated

- `node --test test/consolidate-findings.test.mjs` passes, including new cases where
  `extractCursorBugbotSeverities` returns `Medium` for the #13 fixture and `Low` for the
  #81 fixture.
- A regression test asserts every pre-existing CodeRabbit case returns the **same**
  severity as before this change.
- `node --test test/consolidate-findings.cli.test.mjs` passes, including a case where a
  Medium cloud-Bugbot finding on the PR head yields `VERDICT=BLOCKED` and exit `3`.
- A test asserts a cloud-Bugbot comment dated **before** the PR-head commit is filtered
  out and does **not** block — the freshness boundary applies equally to both sources.
- A test asserts a check-run with `conclusion: neutral` and no findings still yields
  `VERDICT=CLEAR` — proving `neutral` was not reclassified as red.
- `grep -c 'cursor' scripts/consolidate-findings.mjs` returns non-zero.
- `npm test` passes.
- `npm run check:docs` passes.

### Manual

- Replay both known-bad PRs against real GitHub data and require `BLOCKED` on each:
  ```bash
  aios consolidate-findings --repo johnellison/aios --pr 13 --round 1; echo $?          # expect 3
  aios consolidate-findings --repo aiosbrain/aios-alpha.github.io --pr 81 --round 1; echo $?  # expect 3
  ```
  Both have known cloud-Bugbot findings and known-correct verdicts, so this is a true
  end-to-end check rather than a fixture round-trip. Note both PRs are now merged; if that
  makes a live replay impossible, use the recorded fixtures and say so explicitly rather
  than reporting a verification that did not run.

## Build-with

Build-with: Fable 5, high effort. Load-bearing merge gate with a hard no-regression
constraint on the existing CodeRabbit path and a 32 KB file to navigate.

## Tier safety

No brain/sync surfaces touched. The gate reads GitHub PR metadata via `gh` and writes
only stdout plus its local audit artifacts; it pushes nothing to the Team Brain and reads
no tier-scoped workspace content.
