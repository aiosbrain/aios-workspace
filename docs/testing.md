# Test strategy

`npm test` is the complete local verification entrypoint. It runs static preparation, every
Node test discovered by `scripts/test-suite.mjs`, the GUI client Vitest suite, and Rust tests
when the local Rust/Tauri prerequisites are installed. A missing local Rust toolchain produces
an explicit skip notice; CI sets `AIOS_REQUIRE_RUST_TESTS=1`, installs the Linux dependencies,
and never permits that lane to skip. The Node runner keeps one child process per file and bounds
concurrency; do not restore explicit test-file lists to `package.json`.

Discovery is git-tracked-only: `scripts/test-suite.mjs` intersects its filesystem walk with
`git ls-files --cached`, so untracked scratch tests and gitignored artifact dirs never run and
never break the discovery-parity test (`git add` a new test file for it to be picked up; outside
a git checkout the runner falls back to the plain walk). Extension sets are per runner — Node
roots (`test/`, `gui/server/`, `scripts/`) execute `.test.{mjs,js}`; `gui/client/src/` belongs to
Vitest, which also runs `.test.{ts,tsx}`. A tracked `.test.ts` (or similar) under a Node root
fails discovery loudly rather than being silently skipped.

Test paths front the suite with `node scripts/ensure-loop-built.mjs --strict`
(`AIOS_LOOP_BUILD_STRICT=1` is equivalent): if the operator-loop TypeScript rebuild is needed and
fails, the run exits nonzero with the real `tsc` diagnostics instead of green-lighting tests
against stale `dist/`. Postinstall keeps the soft never-fail mode, and the mtime freshness check
still no-ops when `dist/` is current (`build:loop` uses `--noEmitOnError` so a failed compile
never refreshes `dist/` and masks itself).

## CI lanes

- Three Node shards run the same canonical inventory with `--shard=N/3`.
- GUI client tests/build, Rust, corrected coverage, and the clean production install run in
  parallel.
- The clean-install test is network-dependent and runs only through
  `npm run test:install-smoke`.
- The required test gate excludes mutation while the nightly campaign is not yet healthy. The
  2026-07-25 calibration run timed out during `bugbot-security`; make the lane mandatory only
  after ten consecutive complete nightlies within the workflow budget, spanning at least seven
  days. Reassess or file a follow-up if that evidence is still unavailable after fourteen days.

## Coverage policy

`npm run test:coverage` reports production files only. c8 and Vitest both include unimported
source as zero coverage; `.c8rc.json` sets `exclude-after-remap` so `dist/**` V8 entries are
source-map-remapped back to `src/**/*.ts` before include/exclude filtering (otherwise every TS
file would report zero). `coverage-baseline.json` is a global non-regression ratchet, while
changed executable lines must remain at least 80% covered and changed production files absent
from LCOV fail closed. PR artifacts contain only the merged JSON summary and LCOV data; raw V8
data and HTML are not uploaded.

`scripts/run-coverage.mjs` supports CI sharding so the coverage lane reuses the same shard
split as the test lanes instead of re-running the whole suite:

- `node scripts/run-coverage.mjs --shard <k>/<n>` runs only shard `k` of the Node suite under
  c8 (sharding is forwarded to `scripts/test-suite.mjs`), leaving that shard's raw V8 coverage
  data under `coverage/shard-<k>/`. It produces no final report and no gate check, and exits
  nonzero on test failure.
- `node scripts/run-coverage.mjs --merge <n>` runs the client Vitest coverage, then merges
  `coverage/shard-1..n/` into the standard outputs `scripts/check-coverage.mjs` consumes —
  `coverage/coverage-summary.json` + `coverage/lcov.info` — plus the baseline candidate
  `coverage/coverage-baseline-candidate.json`. It fails closed if any shard's data is missing.
- With no flags it performs the single full run (client coverage first, then the whole Node
  suite under c8, then the merge).

Coverage floors are generated on the Ubuntu CI runner so platform-specific skips cannot make a
locally generated floor fail in CI. Every coverage run uploads
`coverage-baseline-candidate.json`. After an intentional improvement lands:

1. Download the `coverage` artifact from the successful CI run.
2. Review its `coverage-baseline-candidate.json`.
3. Replace `coverage-baseline.json` with that CI-generated candidate in a follow-up PR.

The writer is restricted to GitHub Actions and requires an explicit output path; do not
regenerate the tracked baseline from a local run. Never lower a baseline merely to make CI pass.

## Mutation policy

`npm run test:mutation` mutates changed files in critical safety groups and pairs native
`node:test` modules with narrow impacted test commands. `npm run test:mutation:nightly` expands
those groups and reuses incremental results. The exact compiled inbox capability target enforces
a 90% break threshold when it is the campaign's sole target, with headroom below its demonstrated
single-file 96.43% score from AIO-513. Mixed-file and whole-group denominators remain advisory at
`thresholds.break = 0` until measured directly. A failed campaign is reported after the remaining
groups run, so one score regression cannot starve later groups of reports or incremental-cache
updates. The PR mutation job remains non-blocking until ten consecutive complete nightlies fit the
workflow budget over at least seven days. Equivalent mutants require a reviewed justification.

TypeScript groups mutate the compiled `dist/` output, not `src/`: Stryker's command runner
scores purely on exit code, so mutating source TypeScript would let compile-breaking mutants be
recorded as "killed" by `tsc` rather than by tests, inflating the score. The orchestrator builds
`dist/` once, unmutated, before the campaign, and the per-mutant command runs only tests (plus a
`chmod +x` repair for execute bits Stryker's sandbox copy drops, which some hook tests assert;
`chmod` always exits 0 on tracked files, so it can never kill a mutant).
Group definitions in `scripts/run-mutation.mjs` stay in tracked-source terms and
`test/mutation-config.test.mjs` asserts every `nightly` and `tests` entry resolves to at least
one tracked file — a move or rename (such as the retired `scripts/sync-plan.mjs`, whose
`buildPlan` gate lives in `scripts/aios.mjs`) fails CI loudly instead of silently exempting a
subsystem from mutation.
