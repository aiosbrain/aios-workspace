# Test strategy

`npm test` is the complete local verification entrypoint. It runs static preparation, every
Node test discovered by `scripts/test-suite.mjs`, the GUI client Vitest suite, and Rust tests.
The Node runner keeps one child process per file and bounds concurrency; do not restore explicit
test-file lists to `package.json`.

## CI lanes

- Three Node shards run the same canonical inventory with `--shard=N/3`.
- GUI client tests/build, Rust, corrected coverage, and the clean production install run in
  parallel.
- The clean-install test is network-dependent and runs only through
  `npm run test:install-smoke`.
- The required test gate excludes mutation only during its initial calibration period.

## Coverage policy

`npm run test:coverage` reports production files only. c8 and Vitest both include unimported
source as zero coverage. `coverage-baseline.json` is a global non-regression ratchet, while
changed executable lines must remain at least 80% covered. PR artifacts contain only the merged
JSON summary and LCOV data; raw V8 data and HTML are not uploaded.

When an intentional coverage improvement lands, regenerate the floor from a clean run:

```bash
npm run test:coverage
node scripts/check-coverage.mjs --write-baseline
```

Never lower a baseline merely to make CI pass.

## Mutation policy

`npm run test:mutation` mutates changed files in critical safety groups and pairs native
`node:test` modules with narrow impacted test commands. `npm run test:mutation:nightly` expands
those groups and reuses incremental results. During the first ten successful runs mutation is
advisory (`thresholds.break = 0`). After calibration, set the break threshold to 80 and make the
PR mutation lane mandatory; equivalent mutants require a reviewed justification.
