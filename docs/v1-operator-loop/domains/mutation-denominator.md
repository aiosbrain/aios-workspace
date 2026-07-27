# Domain spec — Mutation-lane denominator: safety-unit scoping + per-group matrix

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Issue **AIO-539**. Test-infrastructure
domain. Build-with: **sonnet / medium** — mechanical config change against two well-understood
files, with the correctness argument carried by the evidence below rather than by new design.
Increment: **one reviewable PR** — `scripts/run-mutation.mjs` + `.github/workflows/mutation.yml` +
`.github/workflows/ci.yml` + the mutation-config test. No production code changes.

## Why

The nightly mutation campaign has never completed, and the score it reports measures file size
rather than test quality. Measured from the 2026-07-26 nightly artifact (run `30189835494`, the
only nightly artifact that exists):

| target | lines | mutants | killed | score |
|---|---|---|---|---|
| `scripts/aios.mjs` | 2,519 | 2,984 | 105 | **3.5%** |
| `hooks/file-governance-guard.mjs` | 292 | 343 | 228 | 66.5% |
| `scripts/brain-client.mjs` | 198 | 176 | 21 | 11.9% |

Scoring those 2,984 mutants by the function they land in shows the defect. `buildPlan` — the
sync-plan safety gate this group exists to protect, and the only part of the file the group's four
test files drive — is **106 mutants, 3.6% of the file**. The remaining 96.4% are CLI subcommands
(`cmdPull` 207, `cmdReview` 141, `cmdGraph` 129, `cmdLearn` 117, `cmdExportOkf` 109, `cmdPush` 108,
and eight more) which score a flat **0.0%** because those tests never invoke them and were never
intended to.

Three consequences, all currently live:

1. **The nightly cannot finish.** `configFor` sets `coverageAnalysis: "off"` for command-runner
   groups (Stryker cannot map `node:test` cases to mutants), so every mutant re-runs the group's
   whole command. That command is 42 tests in 0.48s locally. Cost is therefore
   `mutants × suite × concurrency⁻¹`: 3,503 × ~3s (CI-cold) ÷ 2 ≈ **88 minutes** against
   `timeout-minutes: 90` in `.github/workflows/mutation.yml`. The 2026-07-26 run died at 89m41s inside step
   `npm run test:mutation:nightly`, having produced exactly one of six group reports. Groups 2–6,
   including `inbox-authorization`, have **never been measured once**.
2. **The PR-level lane silently no-ops on the riskiest file.** The `Changed-code mutation
   (calibration)` job in `.github/workflows/ci.yml` (line 331) pairs `timeout-minutes: 20` with
   `continue-on-error: true`. A PR touching `scripts/aios.mjs` needs ~75 minutes for that file's
   2,984 mutants, so it times out — and reports **green**. The gate is strongest-looking exactly
   where it is absent.
3. **The metric drove a real incident.** A whole-group score of 10.11% is uninterpretable, so a
   usable number can only be obtained by narrowing scope — which is precisely the "silent scope
   extension" retro (a 96.43% single-file `src/operator-loop/inbox/capability.ts` measurement documented as covering a
   ~9,900-line group). Fixing the denominator removes the incentive, not just the symptom.

This spec fixes the denominator and the starvation. Extracting the safety units into real modules
is the durable fix and is specified separately in
[`safety-unit-extraction.md`](./safety-unit-extraction.md); this increment deliberately lands
first, config-only, so the nightly produces trustworthy numbers before any code moves.

## Dependencies

- None blocking. Stryker **9.6.1** is already installed and supports mutation ranges — the
  `mutate` schema documents the `file:startLine-endLine` postfix and
  `@stryker-mutator/api` exports `MutationRange` (`core/mutation-range.d.ts`,
  `MutateDescription = MutationRange[] | boolean`). Verified against the installed copy.
- Sequenced **before** `safety-unit-extraction.md` (that spec deletes the line range this one
  adds) and before the AIO-531 / AIO-532 build waves, both of which assert against nightly
  mutation scores that do not yet exist.

## Reuse (shipped, KEEP)

- `scripts/run-mutation.mjs` — `MUTATION_GROUPS`, `configFor`, `toMutateTarget`, `runAllCampaigns`,
  `main`. The orchestration is correct; only group scope and per-group isolation change.
- `.github/workflows/mutation.yml` — the nightly job, its split cache restore/save, and the
  `if: always()` artifact upload. The matrix reuses this job body verbatim.
- `.github/workflows/ci.yml` line 331 — the `Changed-code mutation (calibration)` job.
- `test/mutation-config.test.mjs` — the config-integrity suite. Note line 123, the test named
  *"the sync-plan safety gate lives in scripts/aios.mjs and is mutation-covered"*, which asserts
  `group.nightly.includes("scripts/aios.mjs")` and must be updated in lockstep.

## Contract

A `nightly` / `match` entry MAY carry a `:<start>-<end>` line-range postfix. The range is a
**scoping declaration, not a hint**: it names the safety unit inside a file that has no module
boundary of its own.

- `toMutateTarget` passes the postfix through to Stryker unchanged for non-`mutateDist` groups.
- Every helper that resolves an entry against the git tree (`toMutateTarget`'s dist rewrite, and
  the tracked-file existence checks in `test/mutation-config.test.mjs`) MUST strip the postfix
  before path resolution. A range entry whose base path is untracked stays a hard test failure.
- Ranges apply to the **nightly** scope only. The changed-code lane keeps whole-file `match`
  regexes; its scoping is handled by the timeout change below.

## Build (net-new)

- **`scripts/run-mutation.mjs`** — `access-governance.nightly` becomes
  `["hooks/file-governance-guard.mjs", "scripts/aios.mjs:334-412", "scripts/brain-client.mjs"]`.
  `334-412` is `buildPlan`'s exact body (`function buildPlan` at 334; closing brace at 412;
  `requireOnline` begins at 416). A new exported `stripMutationRange(entry)` is the single place
  the postfix is parsed; `toMutateTarget` calls it before its `src/`→`dist/` rewrite.
- **`test/mutation-config.test.mjs`** — route existing tracked-file assertions through
  `stripMutationRange`. Replace the line-123 test with one that asserts the access-governance
  nightly scope contains an entry whose base path is `scripts/aios.mjs`, and — the anti-drift
  guard — that the declared range still brackets the `function buildPlan` declaration line found
  by reading `scripts/aios.mjs`. A range that drifts off its function fails the build rather than
  silently mutating the wrong code.
- **`.github/workflows/mutation.yml`** — convert the single job to
  `strategy: { matrix: { group: [access-governance, bugbot-security, update-safety,
  inbox-authorization, runtime-capabilities, client-auth-permissions] }, fail-fast: false }`,
  running `node scripts/run-mutation.mjs --nightly --group ${{ matrix.group }}`. Per-group
  `timeout-minutes: 45`; cache key and artifact name gain a `-${{ matrix.group }}` suffix so six
  concurrent jobs cannot collide on one key or clobber one artifact.
- **`.github/workflows/ci.yml`** — raise the changed-code lane to `timeout-minutes: 45`. Keep
  `continue-on-error: true` (the lane is explicitly advisory/calibration), but the raise means a
  PR touching `scripts/aios.mjs` produces a real result instead of a timeout reported as success.

## Scope

**In:** the range contract + `stripMutationRange`, the access-governance range scoping, the
nightly matrix, the two timeout changes, and the config-test updates above.

**Deferred:** ranges for any other group (`update-safety`, `bugbot-security` and the rest keep
whole-file scope until their own scores are observed — this spec fixes one group and proves the
mechanism); module extraction (`safety-unit-extraction.md`); re-calibrating `breakThreshold` away
from 0 for whole-group campaigns; nightly-schedule reliability (GitHub silently skipped the
2026-07-27 02:23 UTC run entirely and fired the 2026-07-26 run 3h20m late — a real gap, but a
detection problem, not a denominator one).

## Tier safety

No sync-surface change: this increment touches CI configuration and mutation scoping only. No
push payload, brain, hook, or frontmatter surface is modified, and no content becomes syncable.
The access-governance group exists to defend the tier boundary (`buildPlan`: admin never syncs,
default-deny on missing `access:`), so the load-bearing invariant is that this change **narrows
the campaign onto that gate rather than away from it** — enforced by the anti-drift guard test,
which fails the build if the declared range stops bracketing `buildPlan`.

## Acceptance (observable)

- `node scripts/run-mutation.mjs --nightly --group access-governance --list` shows
  `scripts/aios.mjs:334-412`, and the generated `.stryker-tmp/access-governance.conf.json`
  carries that entry verbatim in `mutate`.
- A full `node scripts/run-mutation.mjs --nightly --group access-governance` reports a total
  mutant count of **~625 (≤ 700)**, down from 3,503, and completes in **under 25 minutes** on CI.
- Its score lands at **~46%** (290 killed of 625, from the per-function data above) rather than
  10.11% — asserted as a recorded observation in the PR body, not as a threshold.
- `node --test test/mutation-config.test.mjs` exits 0; editing the declared range in
  `scripts/run-mutation.mjs` so it no longer brackets `function buildPlan` makes it exit non-zero
  (demonstrated in the PR body).
- One nightly run produces **six** `mutation-report-<group>` artifacts, one per matrix leg,
  including a first-ever `inbox-authorization.json` — the measurement the silent-scope-extension
  retro assumed existed.
- `.github/workflows/ci.yml` shows `timeout-minutes: 45` on the changed-code lane, and a PR
  touching `scripts/aios.mjs` produces a non-empty campaign result instead of a timeout.

## Implementation

1. `stripMutationRange` + `toMutateTarget` wiring in `scripts/run-mutation.mjs`; update
   `test/mutation-config.test.mjs` (including the anti-drift guard). Tests green before scope
   changes.
2. Apply the `scripts/aios.mjs:334-412` scoping to `access-governance.nightly`.
3. Matrix `.github/workflows/mutation.yml` (per-group cache key, artifact name, 45m timeout).
4. Raise the `.github/workflows/ci.yml` changed-code lane timeout to 45m.
5. Dispatch the nightly manually (`gh workflow run mutation.yml`) and record the six per-group
   scores in the PR body — the first complete campaign, and the baseline every later calibration
   is measured against.
