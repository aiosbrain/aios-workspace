# Domain spec — Property-based testing (fast-check), first wave

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Test-infrastructure
domain (issue **AIO-532**). Build-with: **sonnet / medium**. Increment: **one reviewable PR** —
5 new `*.property.test.mjs` files + 1 new helper + 2 one-line `scripts/run-mutation.mjs` edits +
1 devDependency. No production code changes.

## Why
The repo's highest-value invariants are universally quantified — "no input ever resolves `access:`
to a syncable tier when it means admin", "a local edit is never silently overwritten by a toolkit
update", "the broker returns the digest verbatim for every projection" — but existing tests assert
them only at hand-picked points; exactly the gap nightly mutation keeps finding. fast-check
generates AND **shrinks** failing inputs to minimal counterexamples — the shrinker is the feature
that justifies a dependency over hand-rolling (Constitution: no new dependency without a stated
reason). devDependency only; `scripts/` stays zero-dep at runtime; the repo already carries
stryker/c8/ajv/zod under the same rule. fast-check v4; single transitive dep `pure-rand` (MIT).

## Dependencies
- `fast-check` v4 as a devDependency (transitive: `pure-rand` only). No other dependencies.
- No runner adapter: properties run as `fc.assert` inside `node:test` `test()` blocks in plain
  `.test.mjs` files — discovered by `scripts/test-suite.mjs` like any other test; the same shape
  works unchanged under Vitest later.

## Reuse (shipped, KEEP — fuzz targets, not modified)
- `scripts/workspace-parse.mjs` — `normalizeTier`, `parseFrontmatter`, `validateItemPayload`.
- `src/operator-loop/signal.ts` (`resolveTier`) and `src/operator-loop/writeback.ts`
  (`resolveTierOrDefault`, `stampFrontmatter`).
- `scripts/toolkit-merge.mjs` — `decideMerge`, the pure decision table. `threeWayMerge` (shells
  `git merge-file`) is explicitly EXCLUDED from fuzzing.
- `src/operator-loop/inbox/capability.ts` — `brokerDecision`, `createInMemoryJournal`.
- `docs/contract/item-payload-1.12.schema.json` + ajv (existing devDep) as the T3 oracle.
- Mutation rails: `scripts/run-mutation.mjs` groups; `.github/workflows/mutation.yml` nightly cron.

## Build (net-new — every path in this section is a new file)
- **Helper** `test/helpers/arbitraries.mjs` (new) — exports `assertProperty` (merges
  `FC_NUM_RUNS` / `FC_SEED` / `FC_PATH` env into `fc.assert` params for replay; default
  `numRuns` 100; nightly may set `FC_NUM_RUNS=1000` in the `mutation.yml` cron lane ONLY),
  `arbTierString`, `arbFrontmatterDoc`, `arbItemPayload` / `arbCorruptedItemPayload`,
  `arbMergeTriple`. Replay contract documented in the helper header: copy seed/path from the
  failure output; `FC_SEED=.. FC_PATH=.. node --test <file>` reproduces identically.
- **T1 — tier resolution / default-deny**: `test/workspace-parse.property.test.mjs` (new) +
  `test/operator-loop/tier-resolution.property.test.mjs` (new). Properties: `normalizeTier` is
  idempotent and case/trim-invariant; mangles of `Private`/`ADMIN` are never syncable;
  `resolveTier` returns only `null|admin|team|external` and admin-ish input never resolves
  syncable; `resolveTierOrDefault` never yields admin by default and never widens a resolvable
  tier; `stampFrontmatter`/`parseFrontmatter` round-trip on adversarial markdown;
  cross-implementation parity — `resolveTier` agrees with `normalizeTier` on every generated input.
- **T2** `test/toolkit-merge.property.test.mjs` (new) — `decideMerge` totality (exactly one of its
  6 verdicts for any triple over `string|undefined`); never-silently-overwrite
  (`mine≠base ∧ mine≠theirs ∧ base defined` ⇒ never take-theirs); `noop` iff `mine===theirs`;
  keep-mine iff `base===theirs` with a local edit.
- **T3** `test/item-payload-contract.property.test.mjs` (new) — generative parity fuzz:
  hand-rolled arbitraries (schema-valid payloads + single-field corruptions) asserting
  `validateItemPayload(x).success === Ajv(item-payload-1.12.schema.json)(x)`. NOT zod-fast-check —
  the validator is hand-rolled, not Zod.
- **T4** `test/operator-loop/capability.property.test.mjs` (new) — broker properties on
  `brokerDecision`: digest passes through verbatim; exactly two journal events, `user-intent` then
  `pdp-decision`, content-free; handle echoed; deterministic under injected `now`. Lands inside
  the inbox-authorization group's existing `test/operator-loop/*.test.mjs` glob — zero
  `MUTATION_GROUPS` edits — and defends PR #412's `capability.js` 90% calibration.

## Mutation linkage (measurable)
- Append `test/toolkit-merge.property.test.mjs` to the update-safety group's `tests` array in
  `scripts/run-mutation.mjs` (one line).
- Add `scripts/workspace-parse.mjs` to the access-governance group's `match` regex (one-line
  change; makes T1 mutation-measurable). **John-vetoable default** — dropping it does not affect
  the rest of the increment.
- Expectation: update-safety + inbox-authorization nightly scores do not regress; `capability.js`
  holds ≥ 90.

## Tier safety
No sync-surface change: this increment ships tests only. T1 strengthens the EXISTING default-deny
invariant (admin never syncs, missing/unresolvable `access:` never pushed; the brain independently
rejects admin-tier at the boundary with a 422 — vocabulary: `scaffold/.claude/rules/frontmatter.md`);
nothing makes admin content syncable and no push-payload, brain, or hook surface is modified.

## Scope / deferred
Deferred: `parseChangedLines` diff fuzz; `ranker.ts` ordering invariants; CLI-level `buildPlan`
fuzz; `gui/client` Vitest properties; `expect-type` rider (mutation lanes deliberately score
compiled `dist/`, so type-level assertions kill no measured mutant; `tsc` already gates); global
seed pinning. Rejected: `pact` — both contract sides are governed in-repo with a versioned schema
+ fixtures + parity checks; T3 adds the generative teeth consumer-driven contracts would
(Constitution: prefer not adding).

## Acceptance (observable)
- `node scripts/test-suite.mjs` discovers the 5 new `*.property.test.mjs` files and exits 0.
- Replay reproducibility demonstrated: with `FC_SEED`/`FC_PATH` copied from a forced failure,
  `node --test <file>` reproduces the identical counterexample.
- `node scripts/run-mutation.mjs --group update-safety` and `--group inbox-authorization` exit 0
  with scores ≥ the current nightly baseline; `capability.js` ≥ 90.
- `package.json` gains exactly one devDependency; `npm ls fast-check` shows only the `pure-rand`
  transitive.
- `aios spec eval docs/v1-operator-loop/domains/property-testing.md` reports `SPEC_READY`.
