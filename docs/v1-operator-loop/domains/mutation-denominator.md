# Domain spec — Mutation lane: per-group matrix + declared safety-unit scoping

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Issue **AIO-539**.
Test-infrastructure domain. Build-with: **sonnet / medium** — CI configuration against three
well-understood files, with the correctness argument carried by the measurements below rather than
by new design. Increment: **one reviewable PR** — `scripts/run-mutation.mjs` +
`.github/workflows/mutation.yml` + `.github/workflows/ci.yml` + `test/mutation-config.test.mjs` +
this spec. No production code changes.

> **Revision 2 (2026-07-27).** An adversarial review with local measurements corrected revision 1's
> cost model: per-mutant cost is the group's **whole kill-command runtime**, not a flat ~3s, so
> narrowing the mutate scope alone does not deliver feasible legs. This revision adds the
> `nightlyTests` contract field (nightly kill command = the unit's own tests), re-derives every
> projection from measured suite runtimes, moves `bugbot-security` into the deliberate-red column
> (test speed is its blocker → **AIO-554**), and corrects the acceptance criteria. The
> `nightlyExcludes` contract, matrix design, and access-governance stance are unchanged.
>
> **Revision 2.1 (2026-07-27, post-calibration).** Two facts changed while the calibration
> dispatch ran. (1) **AIO-540 merged** (PR #428): `scripts/sync-plan.mjs` exists, the
> access-governance group is scoped to it, and that leg is now expected **green** (measured 714
> mutants / 5m47s in #428) — `bugbot-security` is the only remaining deliberate-red leg. (2) The
> calibration **measured the inbox floor dip this spec anticipated**: 84.62% (22/26) against the
> unit-only oracle, and widening `nightlyTests` to the capability-adjacent subset changed nothing,
> because `test/operator-loop/inbox-capability.test.mjs` is the **only** test in the repo that
> invokes the broker — no oracle widening can kill what no test asserts. The remediation was the
> third, most honest option: **strengthen the unit oracle** (assert the journalled event payloads
> and the optional-journal guard Stryker proved unasserted) — after which the unit-only oracle
> scores **100.00% (26/26)** and the 90 floor enforces. That is this mechanism working end-to-end:
> the narrowed denominator found real assertion gaps in the safety unit's only oracle on its first
> measured run. The affected sections below are updated in place.
>
> **Revision 2.2 (2026-07-27).** The second calibration dispatch exposed a latent unsoundness:
> **Stryker incremental mode + the command runner reuses stale verdicts when tests change**,
> because the command runner reports no per-test information. Measured directly — the
> strengthened oracle scored 100.00% locally (fresh state) but the CI leg restored the previous
> run's incremental JSON and re-reported the same four mutants as Survived without ever executing
> the new test. Command-runner groups now run with `incremental: false` (narrowed scopes made full
> re-runs cheap — the incremental cache was a crutch for the 90-minute monolith); only the Vitest
> (`perTest`) client group keeps incremental state, and the workflow's cache steps are scoped to
> that leg. Enforced by the config test *"command-runner groups never use incremental mode"*. Two
> discoveries from the same dispatch are filed separately: **AIO-563** (the `runtime-capabilities`
> group's first-ever score is 0.00% because no test in its kill command imports the mutated
> modules — a dead oracle now visible nightly) and the runner-speed variance note (the July-26
> "89m41s" access-governance measurement ran ~4× slower than the same campaign on a 2026-07-27
> runner, 19m16s — projections in this spec are runner-relative).

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
`node:test` cases to mutants), so every mutant re-runs the group's whole command:

```
campaign cost ≈ mutants × killCommandRuntime ÷ concurrency
```

**Both factors vary per group.** Mutants scale with lines of code in scope (~1.16 mutants/line from
the artifact above), and the kill-command runtime is the group's whole test command — measured
(2026-07-27, local M-series; the one CI calibration point is access-governance at 3.07s/mutant of
compute for a 0.48s-local suite, i.e. 3,503 mutants in 89m41s at `concurrency: 2`):

| group's kill command                                 | local runtime | dominated by                        |
| ---------------------------------------------------- | ------------- | ----------------------------------- |
| access-governance (4 files, 42 tests)                | 0.48s         | —                                   |
| bugbot-security (2 files)                            | 14.7s         | `local-bugbot-gate.test.mjs` alone is 14.9s (spawns the real hook per case) |
| update-safety (7 files)                              | 17.7s         | toolkit-update end-to-end git cases |
| inbox-authorization (`test/operator-loop/*.test.mjs`) | 42.1s         | 73 files, 735 tests                 |
| runtime-capabilities (4 files)                       | 0.33s         | —                                   |

Projecting whole-group nightly campaigns with per-group runtimes (CI scaling bounded between
"overhead-dominated" and "×5.4 suite slowdown", the two readings consistent with the one measured
CI point):

| group                | lines in scope | ~mutants | projected                             |
| -------------------- | -------------- | -------- | ------------------------------------- |
| access-governance    | 3,009          | 3,490    | **~90 min** (actual: 3,503 / 89m41s)  |
| bugbot-security      | 2,055          | 2,383    | **~7–22 h**                           |
| update-safety        | 3,049          | 3,536    | **~10–47 h**                          |
| inbox-authorization  | 9,903          | 11,487   | **~80–360 h**                         |
| runtime-capabilities | 884            | 1,025    | ~20–30 min                            |

Revision 1 applied access-governance's ~3s/mutant to every group and concluded inbox needed 4.8
hours; the truth is far worse, because a flat per-mutant cost only holds for sub-second suites.
Either way the conclusion stands, stronger: **four of the five command-runner groups cannot finish
in any reasonable CI budget**, and `inbox-authorization` has never been measured once. This is not
one bad group — it is every group whose scope was declared as "the files this concerns" rather
than "the unit this protects", killed by "every test that might be related" rather than the unit's
own tests.

### Three live consequences

1. **Nightly starvation.** The single 90-minute job died at 89m41s having produced one of six group
   reports. Groups 2–6 have never produced a score.
2. **The PR-level lane silently no-ops on the riskiest files.** The `Changed-code mutation
(calibration)` job in `.github/workflows/ci.yml` (line 331) pairs `timeout-minutes: 20` with
   `continue-on-error: true`. A PR touching `scripts/aios.mjs` needs ~90 minutes, and one touching
   `scripts/update.mjs` or an inbox module needs hours (umbrella-suite kill command), so the lane
   times out — and reports **green**. The gate looks strongest exactly where it is absent.
3. **The metric drove a real incident.** A whole-group score of 10.11% is uninterpretable, so a
   usable number can only be obtained by narrowing scope — precisely the "silent scope extension"
   retro (a 96.43% single-file `src/operator-loop/inbox/capability.ts` measurement documented as
   covering a ~9,900-line group). Fixing the denominator removes the incentive, not just the
   symptom.

## The principle

**Every group declares the safety unit it protects, mutates that unit — not the files that happen
to surround it — and kills nightly mutants with the unit's own tests.** A group's scope is a claim
about what is verified; it must be narrow enough to be true. The score then measures the quality
of the unit's oracle, not the incidental kill rate of an umbrella suite.

Applied, four of five groups need only configuration (their safety unit is already a module), and
one of those four is still blocked on oracle speed:

| group                | declared safety unit                              | nightly kill command                            | scoped cost                                 |
| -------------------- | ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| inbox-authorization  | `src/operator-loop/inbox/capability.ts` (175)     | `inbox-capability.test.mjs` (0.19s)             | **~5–10 min** (+ one dist build)            |
| update-safety        | `scripts/toolkit-merge.mjs` — `decideMerge` (117) | `toolkit-merge.test.mjs` (0.79s)                | **~3–7 min**                                |
| runtime-capabilities | already scoped (884)                              | unchanged (0.33s)                               | ~20–30 min, unchanged                       |
| bugbot-security      | `hooks/local-bugbot-gate.mjs` (612)               | its own test **is** the 14.9s → **AIO-554**     | **red at 45 min** until the oracle is fast  |
| access-governance    | `scripts/sync-plan.mjs` (extracted by AIO-540)    | its 4-file suite (0.48s)                        | green, ~6 min (714 mutants, measured in #428) |

`scripts/aios.mjs` was the **only** place a refactor sat on the critical path, and that was
[`safety-unit-extraction.md`](./safety-unit-extraction.md) (AIO-540, **merged** as PR #428 — the
group now mutates `scripts/sync-plan.mjs`). This spec deliberately did **not** introduce a Stryker
line-range mechanism to bridge the gap: a line range is a coordinate, not a boundary, and building
one only to delete it when AIO-540 landed would have been throwaway work leaving a speculative
parser behind. `bugbot-security` is the dual case: its unit is a module but its oracle spawns the
real hook per test case, so no test *selection* can make the leg fit — that is a test *speed*
problem, extracted to **AIO-554** the same way the access-governance module problem was extracted
to AIO-540.

## Dependencies

- None blocking. This spec ships alone and improves the lane on its own.
- **Not** a prerequisite of AIO-540 and not blocked by it: AIO-540 fixes the access-governance
  group and the two can land in either order or in parallel. Likewise **AIO-554** (bugbot oracle
  speed) lands independently and turns the bugbot leg green afterwards.
- Both should precede the AIO-531 / AIO-532 build waves, which assert against nightly scores that
  do not yet exist.

## Reuse (shipped, KEEP)

- `scripts/run-mutation.mjs` — `MUTATION_GROUPS`, `configFor`, `toMutateTarget`, `runAllCampaigns`,
  `main`. The orchestration is correct; only per-group scope, nightly kill commands, and job
  isolation change.
- `.github/workflows/mutation.yml` — the nightly job, its split cache restore/save, and the
  `if: always()` artifact upload. The matrix reuses this job body.
- `.github/workflows/ci.yml` line 331 — the `Changed-code mutation (calibration)` job.
- `test/mutation-config.test.mjs` — the config-integrity suite, including the sync-plan gate test
  (post-AIO-540: _"the sync-plan safety gate lives in scripts/sync-plan.mjs and is
  mutation-covered"_), and its `globToRegExp`/`matchesTrackedFile` helpers, which the new
  assertions reuse.
- `configFor` line 167 — `breakThreshold` applies only when `mutate.length === 1`. Scoping
  `inbox-authorization` to its single declared unit therefore **activates** the calibrated
  `dist/operator-loop/inbox/capability.js: 90` floor. One caveat revision 1 missed: that floor was
  calibrated with the full operator-loop suite as the killer. With the narrowed `nightlyTests`
  killer the score can only drop, so the calibration dispatch **re-measures before the floor is
  trusted**. *Measured outcome (rev 2.1):* the unit test alone scored 84.62% (22/26); widening to
  the capability-adjacent subset changed nothing because no other test invokes the broker; the
  remediation was to **strengthen the unit oracle** — assert the journalled event payloads and the
  optional-journal guard — after which the unit-only oracle scores **100.00%** and the floor
  enforces. The floor was never lowered.

## Contract

Each entry in `MUTATION_GROUPS` gains two optional fields:

```
nightlyExcludes: string[]  // files matched by `match` that are deliberately NOT mutated nightly
nightlyTests?: string[]    // nightly kill command: the unit's own tests (subset of `tests`)
```

`nightlyExcludes` is the anti-silent-scope-extension mechanism, and it is the load-bearing part of
this spec. Narrowing scope without recording what was dropped is exactly the inference that caused
the incident. So:

- `test/mutation-config.test.mjs` asserts that **every tracked file matching a group's `match`
  regex appears in either `nightly` or `nightlyExcludes`** (glob entries expand via the existing
  `globToRegExp`). A file cannot silently fall out of mutation coverage, and a newly added file in
  a critical directory fails the build until someone states which side of the line it is on.
- Every `nightlyExcludes` entry must itself be tracked, matched by the group's regex, and disjoint
  from `nightly` — a dead or redundant entry is a test failure, not noise.
- Each `nightlyExcludes` entry carries an inline comment naming why it is out of scope and, where
  applicable, the issue that would bring it back.
- `nightlyExcludes` is documentation with teeth, not configuration: it changes no campaign
  behavior, only what the config is allowed to leave unsaid.

`nightlyTests` is the other half of the denominator fix — the kill-command side:

- When present, the **nightly** campaign's command runs only these tests; the changed-code lane
  always keeps the group's umbrella `tests` (a PR touching any matched file still gets the widest
  available oracle).
- Every `nightlyTests` entry must be tracked and a subset of `tests` — the nightly oracle cannot
  drift away from the reviewed test set.
- Without it, per-mutant cost is the umbrella suite and the matrix legs above are infeasible; with
  it, the score finally means "how good are this unit's own tests".

## Build (net-new)

- **`scripts/run-mutation.mjs`** — every group gains `nightlyExcludes` (empty where nothing is
  dropped); the narrowed groups gain `nightlyTests`; `nightly` arrays reduce to the declared unit:
  - `inbox-authorization` → `nightly: ["src/operator-loop/inbox/capability.ts"]`,
    `nightlyTests: ["test/operator-loop/inbox-capability.test.mjs"]`; excludes `scripts/inbox.mjs`
    and the other **20** `src/operator-loop/inbox/*.ts` files.
  - `update-safety` → `nightly: ["scripts/toolkit-merge.mjs"]`,
    `nightlyTests: ["test/toolkit-merge.test.mjs"]`; excludes `scripts/update.mjs`,
    `scripts/toolkit-pull.mjs`, `scripts/toolkit-manifest.mjs`, `scripts/toolkit-meta.mjs`.
  - `bugbot-security` → `nightly: ["hooks/local-bugbot-gate.mjs"]`; excludes
    `scripts/review-bugbot.mjs`. No `nightlyTests` — the unit's own test is the cost (AIO-554);
    the leg is a deliberate red until that lands.
  - `runtime-capabilities` — unchanged (already fits); `nightlyExcludes: []`.
  - `access-governance` — **unchanged in this PR**; see Scope.
  - `nodeCommand` gains the nightly flag (already threaded through `configFor`) and uses
    `nightlyTests` when set.
- **`test/mutation-config.test.mjs`** — the completeness assertion (`nightly ∪ nightlyExcludes ⊇
  match` over tracked files), the `nightlyExcludes` hygiene assertions, the `nightlyTests ⊆ tests`
  assertion, a check that nightly configs use `nightlyTests` while changed-code configs use
  `tests`, and a parity check that `mutation.yml`'s matrix lists exactly the `MUTATION_GROUPS`
  names. Existing tests keep passing unmodified.
- **`.github/workflows/mutation.yml`** — convert the single job to
  `strategy: { matrix: { group: [access-governance, bugbot-security, update-safety,
inbox-authorization, runtime-capabilities, client-auth-permissions] }, fail-fast: false }`,
  running `node scripts/run-mutation.mjs --nightly --group ${{ matrix.group }}`. The 45-minute
  timeout goes on the campaign **step**, not the job (a job-level timeout marks the run *cancelled*
  and skips `if: always()` cache-save/upload — both observed nightlies read "cancelled" for this
  reason); the job gets ~55 as a backstop. The cache key inserts the group **before** the sha —
  `stryker-incremental-${{ runner.os }}-${{ github.ref_name }}-${{ matrix.group }}-${{ github.sha }}`
  with a matching restore-keys prefix — because a plain suffix after the sha would let restore-keys
  cross-restore another group's incremental state. Artifact name gains `-${{ matrix.group }}`. A
  comment names the expected-red leg and its unblocking issue (bugbot-security → AIO-554).
- **`.github/workflows/ci.yml`** — raise the changed-code lane to `timeout-minutes: 45`. Keep
  `continue-on-error: true` (the lane is explicitly advisory/calibration). Honesty note: this
  raise helps mid-size files; it does **not** make an `scripts/aios.mjs`-touching PR complete
  (~90 min) — that too is AIO-540's payoff — and umbrella-suite groups stay slow in this lane
  until their PR-lane cost model is revisited (Deferred).

## Scope

**In:** the `nightlyExcludes` + `nightlyTests` contract and their assertions, the four group
re-scopings, the nightly matrix, and the two timeout raises.

**Deliberately red: `bugbot-security`.** Its oracle is intrinsically too slow (14.9s per mutant
run), and no green obtainable tonight would mean anything: a red leg that means "this group is
genuinely not measured" is strictly better than the pre-matrix state, where the same fact was
hidden inside one truncated job. **AIO-554** turns the leg green by making the oracle fast — the
leg's timeout must not be widened and the gate file must not be dropped to silence it.
(Access-governance carried the same deliberate-red stance while `buildPlan` had no module; AIO-540
merged mid-calibration and resolved it — dropping `scripts/aios.mjs` *without* the extraction
would have silently removed the sync-plan safety gate from coverage, the exact inference this spec
exists to prevent.)

**Deferred:** widening any narrowed group back out once its unit scores well (each is a separate,
measured decision recorded in `nightlyExcludes`); the `runtime-capabilities` dead oracle — its
first measured leg scored **0.00% (631 mutants, 0 killed)** because no test in its kill command
imports the mutated modules (`guard.mjs` and `runtime-adapters/index.mjs` have no test importer at
all; `capability-store.mjs`'s only oracle lives in the inbox group) → **AIO-563**, which also
considers a config assertion that every mutate target is reachable from its group's tests;
re-calibrating `breakThreshold` away from 0 for multi-file campaigns; `client-auth-permissions` scoping (Vitest + `coverageAnalysis: "perTest"` is
a different cost model and is not known to be starved — its first measured leg duration falls out
of the calibration dispatch for free); a PR-lane cost model for umbrella-suite groups (incremental
mode or unit-scoped changed-code runs); nightly-schedule reliability — GitHub fired the 2026-07-26
run 3h20m late and the 2026-07-27 run 3h39m late (both then cancelled at the 90-minute timeout), a
real gap but a detection problem, not a denominator one.

## Tier safety

No sync-surface change: this increment touches CI configuration and mutation scoping only. No push
payload, brain, hook, or frontmatter surface is modified, and no content becomes syncable. Two
groups defend tier boundaries directly — `access-governance` (`buildPlan`: admin never syncs,
default-deny on missing `access:`) and `inbox-authorization` (the capability broker) — so the
load-bearing invariant is that **no group's declared safety unit is narrowed away**.
`access-governance` keeps its safety unit fully in scope — post-AIO-540 that unit is
`scripts/sync-plan.mjs` (where `buildPlan` now lives), plus `hooks/file-governance-guard.mjs` and
`scripts/brain-client.mjs`; `scripts/aios.mjs` left the group entirely with the extraction, so it
is no longer matched, not silently dropped. `inbox-authorization` narrows _onto_ its safety unit
rather than away from it, gaining an enforcing 90% floor in the process (subject to the
re-measurement caveat in Reuse — the floor may only be relaxed with recorded evidence, never
silently). The `nightlyExcludes` completeness test is what keeps this checkable rather than
asserted.

## Acceptance (observable)

- `node --test test/mutation-config.test.mjs` exits 0; deleting any single entry from a
  `nightlyExcludes` array makes it exit non-zero (demonstrated in the PR body) — proving the
  completeness assertion is live and a file cannot silently leave coverage.
- `node scripts/run-mutation.mjs --nightly --group inbox-authorization --list` shows exactly
  `dist/operator-loop/inbox/capability.js`, and the generated
  `.stryker-tmp/inbox-authorization.conf.json` shows `thresholds.break: 90` and a kill command
  containing only `test/operator-loop/inbox-capability.test.mjs` — the calibrated floor now
  enforcing against the unit's own oracle (after the re-measurement check above).
- One nightly run produces a `mutation-report-<group>` artifact for **every leg that completes** —
  post-AIO-540 (rev 2.1): five (`access-governance`, `inbox-authorization`, `update-safety`,
  `runtime-capabilities`, `client-auth-permissions`). A timed-out leg writes no JSON report (the
  reporter runs at completion), so the bugbot-security red leg uploads nothing; **six** artifacts
  is the post-AIO-554 end state.
- `inbox-authorization` and `update-safety` each complete and report a score for the **first
  time**, in **under 45 minutes** each (projected ~5–10 and ~3–7).
- The `bugbot-security` leg fails on its step timeout **in isolation**, as a step failure (not a
  run-level cancellation), without preventing the other legs from reporting — the behavior the
  single-job layout made impossible.
- `.github/workflows/ci.yml` shows `timeout-minutes: 45` on the changed-code lane.
- All six per-leg outcomes — five scores plus the expected bugbot timeout — are recorded in the PR
  body as the first complete campaign baseline.

## Implementation

1. Add `nightlyExcludes` (+ assertions) to `MUTATION_GROUPS` and `test/mutation-config.test.mjs`,
   with every group's excludes filled in at current scope so the test passes before any scope
   changes. Tests green.
2. Narrow `inbox-authorization`, `update-safety`, and `bugbot-security` to their declared units,
   moving the dropped files into `nightlyExcludes` with inline reasons; add `nightlyTests` to the
   first two and thread the nightly flag through `nodeCommand`.
3. Matrix `.github/workflows/mutation.yml` (per-group cache key with the group before the sha,
   per-group artifact name, step-level 45m timeout, expected-red comment).
4. Raise the `.github/workflows/ci.yml` changed-code lane timeout to 45m.
5. Dispatch the nightly manually from the PR branch (`gh workflow run mutation.yml --ref <branch>`)
   as the calibration run: verify the five completing legs and their durations, check the inbox
   score against the 90 floor (widen `nightlyTests` per Reuse if it dips), confirm the expected-red
   `bugbot-security` leg fails in isolation, and record all six outcomes in the PR body.
