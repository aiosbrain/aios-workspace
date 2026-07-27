# Domain spec — Mutation lane: per-group matrix + declared safety-unit scoping

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Issue **AIO-539**.
Test-infrastructure domain. Build-with: **sonnet / medium** — CI configuration against three
well-understood files, with the correctness argument carried by the measurements below rather than
by new design. Increment: **one reviewable PR** — `scripts/run-mutation.mjs` +
`.github/workflows/mutation.yml` + `.github/workflows/ci.yml` + `test/mutation-config.test.mjs`.
No production code changes.

## Why

The nightly mutation campaign has never completed a run, and the score it reports measures file
size rather than test quality. Measured from the only nightly artifact that exists
(`.github/workflows/mutation.yml` run `30189835494`, 2026-07-26):

| target                            | lines | mutants | killed | score    |
| --------------------------------- | ----- | ------- | ------ | -------- |
| `scripts/aios.mjs`                | 2,519 | 2,984   | 105    | **3.5%** |
| `hooks/file-governance-guard.mjs` | 292   | 343     | 228    | 66.5%    |
| `scripts/brain-client.mjs`        | 198   | 176     | 21     | 11.9%    |

Scoring those 2,984 mutants by the function they land in shows the defect. `buildPlan` — the
sync-plan safety gate this group exists to protect, and the only part of the file the group's four
test files drive — is **106 mutants, 3.6% of the file**. The remaining 96.4% are CLI subcommands
(`cmdPull` 207, `cmdReview` 141, `cmdGraph` 129, `cmdLearn` 117, `cmdExportOkf` 109, `cmdPush` 108,
and eight more) which score a flat **0.0%** because those tests never invoke them and were never
intended to.

### The cost model, and why this is systemic

`configFor` sets `coverageAnalysis: "off"` for command-runner groups (Stryker cannot map
`node:test` cases to mutants), so every mutant re-runs the group's whole command. Cost is therefore
`mutants × suite × concurrency⁻¹`, and mutants scale with **lines of code in scope**, not with what
the tests actually exercise. Calibrating against the artifact above — 3,503 mutants over 3,009
lines (**1.16 mutants/line**), ~3s per mutant on a cold CI runner, `concurrency: 2` — projects
every group:

| group                | lines in scope | ~mutants | ~minutes                        |
| -------------------- | -------------- | -------- | ------------------------------- |
| access-governance    | 3,009          | 3,490    | **87** (actual: 3,503 / 89m41s) |
| bugbot-security      | 2,055          | 2,383    | **59**                          |
| update-safety        | 3,049          | 3,536    | **88**                          |
| inbox-authorization  | 9,903          | 11,487   | **287**                         |
| runtime-capabilities | 884            | 1,025    | 25                              |

The model predicts the one observed group to within **0.4%**. **Four of the five command-runner
groups cannot finish in any reasonable CI budget**; `inbox-authorization` needs 4.8 hours and has
therefore never been measured once. This is not one bad group — it is every group whose scope was
declared as "the files this concerns" rather than "the unit this protects".

### Three live consequences

1. **Nightly starvation.** The single 90-minute job died at 89m41s having produced one of six group
   reports. Groups 2–6 have never produced a score.
2. **The PR-level lane silently no-ops on the riskiest file.** The `Changed-code mutation
(calibration)` job in `.github/workflows/ci.yml` (line 331) pairs `timeout-minutes: 20` with
   `continue-on-error: true`. A PR touching `scripts/aios.mjs` needs ~75 minutes, so it times
   out — and reports **green**. The gate looks strongest exactly where it is absent.
3. **The metric drove a real incident.** A whole-group score of 10.11% is uninterpretable, so a
   usable number can only be obtained by narrowing scope — precisely the "silent scope extension"
   retro (a 96.43% single-file `src/operator-loop/inbox/capability.ts` measurement documented as
   covering a ~9,900-line group). Fixing the denominator removes the incentive, not just the
   symptom.

## The principle

**Every group declares the safety unit it protects, and mutates that unit — not the files that
happen to surround it.** A group's scope is a claim about what is verified; it must be narrow
enough to be true.

Applied, four of five groups need no code change at all, because their safety unit is already a
module:

| group                | declared safety unit                              | module exists?                         | scoped cost        |
| -------------------- | ------------------------------------------------- | -------------------------------------- | ------------------ |
| inbox-authorization  | `src/operator-loop/inbox/capability.ts` (175)     | **yes**                                | ~5 min             |
| update-safety        | `scripts/toolkit-merge.mjs` — `decideMerge` (117) | **yes**                                | ~3 min             |
| bugbot-security      | `hooks/local-bugbot-gate.mjs` (612)               | **yes**                                | ~18 min            |
| runtime-capabilities | already scoped (884)                              | **yes**                                | ~25 min, unchanged |
| access-governance    | `buildPlan`                                       | **no — trapped in `scripts/aios.mjs`** | needs extraction   |

`scripts/aios.mjs` is the **only** place a refactor sits on the critical path, and that is
[`safety-unit-extraction.md`](./safety-unit-extraction.md) (AIO-540). This spec deliberately does
**not** introduce a Stryker line-range mechanism to paper over it: a line range is a coordinate,
not a boundary, and building one here only to delete it in AIO-540 is throwaway work that leaves a
speculative parser behind.

## Dependencies

- None blocking. This spec ships alone and improves the lane on its own.
- **Not** a prerequisite of AIO-540 and not blocked by it: AIO-540 fixes the one remaining group
  (access-governance) and the two can land in either order or in parallel.
- Both should precede the AIO-531 / AIO-532 build waves, which assert against nightly scores that
  do not yet exist.

## Reuse (shipped, KEEP)

- `scripts/run-mutation.mjs` — `MUTATION_GROUPS`, `configFor`, `toMutateTarget`, `runAllCampaigns`,
  `main`. The orchestration is correct; only per-group scope and job isolation change.
- `.github/workflows/mutation.yml` — the nightly job, its split cache restore/save, and the
  `if: always()` artifact upload. The matrix reuses this job body.
- `.github/workflows/ci.yml` line 331 — the `Changed-code mutation (calibration)` job.
- `test/mutation-config.test.mjs` — the config-integrity suite, including line 123's test
  _"the sync-plan safety gate lives in scripts/aios.mjs and is mutation-covered"_, which must stay
  true (access-governance keeps `scripts/aios.mjs` in scope here — see Scope).
- `configFor` line 167 — `breakThreshold` applies only when `mutate.length === 1`. Scoping
  `inbox-authorization` to its single declared unit therefore **activates** the already-calibrated
  `dist/operator-loop/inbox/capability.js: 90` floor, turning that group from advisory to enforcing
  as a side effect of telling the truth about its scope.

## Contract

Each entry in `MUTATION_GROUPS` gains one optional field:

```
nightlyExcludes: string[]   // files matched by `match` that are deliberately NOT mutated
```

This is the anti-silent-scope-extension mechanism, and it is the load-bearing part of this spec.
Narrowing scope without recording what was dropped is exactly the inference that caused the
incident. So:

- `test/mutation-config.test.mjs` asserts that **every tracked file matching a group's `match`
  regex appears in either `nightly` or `nightlyExcludes`**. A file cannot silently fall out of
  mutation coverage, and a newly added file in a critical directory fails the build until someone
  states which side of the line it is on.
- Each `nightlyExcludes` entry carries an inline comment naming why it is out of scope and, where
  applicable, the issue that would bring it back.
- `nightlyExcludes` is documentation with teeth, not configuration: it changes no campaign
  behavior, only what the config is allowed to leave unsaid.

## Build (net-new)

- **`scripts/run-mutation.mjs`** — add `nightlyExcludes` to the four narrowed groups and reduce
  their `nightly` arrays to the declared unit:
  - `inbox-authorization` → `["src/operator-loop/inbox/capability.ts"]`; excludes the other 13
    `src/operator-loop/inbox/*.ts` files and `scripts/inbox.mjs`.
  - `update-safety` → `["scripts/toolkit-merge.mjs"]`; excludes `scripts/update.mjs`,
    `scripts/toolkit-pull.mjs`, `scripts/toolkit-manifest.mjs`, `scripts/toolkit-meta.mjs`.
  - `bugbot-security` → `["hooks/local-bugbot-gate.mjs"]`; excludes `scripts/review-bugbot.mjs`.
  - `runtime-capabilities` — unchanged (already fits); `nightlyExcludes: []`.
  - `access-governance` — **unchanged in this PR**; see Scope.
- **`test/mutation-config.test.mjs`** — add the `nightly ∪ nightlyExcludes ⊇ match` completeness
  assertion above. Existing tests keep passing unmodified.
- **`.github/workflows/mutation.yml`** — convert the single job to
  `strategy: { matrix: { group: [access-governance, bugbot-security, update-safety,
inbox-authorization, runtime-capabilities, client-auth-permissions] }, fail-fast: false }`,
  running `node scripts/run-mutation.mjs --nightly --group ${{ matrix.group }}`. Per-group
  `timeout-minutes: 45`; cache key and artifact name gain a `-${{ matrix.group }}` suffix so six
  concurrent legs cannot collide on one cache key or clobber one artifact.
- **`.github/workflows/ci.yml`** — raise the changed-code lane to `timeout-minutes: 45`, so a PR
  touching a large file produces a real result instead of a timeout reported as success. Keep
  `continue-on-error: true` (the lane is explicitly advisory/calibration).

## Scope

**In:** the `nightlyExcludes` contract and its completeness test, the four group re-scopings, the
nightly matrix, and the two timeout raises.

**Deliberately unchanged: `access-governance`.** Its declared unit has no module, so the honest
options are to leave it whole-file (the leg fails visibly at 45 minutes) or to drop
`scripts/aios.mjs` from the group. **This spec chooses the visible failure.** Dropping the file
would make the leg green while silently removing the sync-plan safety gate from mutation coverage —
the exact inference this spec exists to prevent, and it would falsify line 123 of
`test/mutation-config.test.mjs`. A red leg that means "this group is genuinely not measured" is
strictly better than the current state, where the same fact is hidden inside one truncated job.
AIO-540 turns it green by making the claim true.

**Deferred:** widening any narrowed group back out once its unit scores well (each is a separate,
measured decision recorded in `nightlyExcludes`); re-calibrating `breakThreshold` away from 0 for
multi-file campaigns; `client-auth-permissions` scoping (Vitest + `coverageAnalysis: "perTest"` is
a different cost model and is not known to be starved); nightly-schedule reliability — GitHub
silently skipped the 2026-07-27 02:23 UTC run entirely and fired the 2026-07-26 run 3h20m late, a
real gap but a detection problem, not a denominator one.

## Tier safety

No sync-surface change: this increment touches CI configuration and mutation scoping only. No push
payload, brain, hook, or frontmatter surface is modified, and no content becomes syncable. Two
groups defend tier boundaries directly — `access-governance` (`buildPlan`: admin never syncs,
default-deny on missing `access:`) and `inbox-authorization` (the capability broker) — so the
load-bearing invariant is that **no group's declared safety unit is narrowed away**.
`access-governance` keeps `scripts/aios.mjs` in scope precisely for this reason, and
`inbox-authorization` narrows _onto_ its safety unit rather than away from it, gaining an enforcing
90% floor in the process. The `nightlyExcludes` completeness test is what keeps this checkable
rather than asserted.

## Acceptance (observable)

- `node --test test/mutation-config.test.mjs` exits 0; deleting any single entry from a
  `nightlyExcludes` array makes it exit non-zero (demonstrated in the PR body) — proving the
  completeness assertion is live and a file cannot silently leave coverage.
- `node scripts/run-mutation.mjs --nightly --group inbox-authorization --list` shows exactly
  `dist/operator-loop/inbox/capability.js`, and the generated
  `.stryker-tmp/inbox-authorization.conf.json` shows `thresholds.break: 90` — the calibrated floor
  now enforcing, not advisory.
- One nightly run produces **six** `mutation-report-<group>` artifacts, one per matrix leg.
- `inbox-authorization`, `update-safety`, and `bugbot-security` each complete and report a score
  for the **first time**, in **under 45 minutes** each (projected ~5, ~3, ~18).
- The `access-governance` leg fails on timeout **in isolation**, without preventing the other five
  legs from reporting — the behavior the single-job layout made impossible.
- `.github/workflows/ci.yml` shows `timeout-minutes: 45` on the changed-code lane.
- The six per-group scores are recorded in the PR body as the first complete campaign baseline.

## Implementation

1. Add `nightlyExcludes` to `MUTATION_GROUPS` and the completeness assertion to
   `test/mutation-config.test.mjs`, with every group's excludes filled in at current scope so the
   test passes before any scope changes. Tests green.
2. Narrow `inbox-authorization`, `update-safety`, and `bugbot-security` to their declared units,
   moving the dropped files into `nightlyExcludes` with inline reasons.
3. Matrix `.github/workflows/mutation.yml` (per-group cache key, artifact name, 45m timeout).
4. Raise the `.github/workflows/ci.yml` changed-code lane timeout to 45m.
5. Dispatch the nightly manually (`gh workflow run mutation.yml`) and record all six per-group
   outcomes — five scores plus the expected access-governance timeout — in the PR body.
