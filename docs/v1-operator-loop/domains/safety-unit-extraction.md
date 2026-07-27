# Domain spec — Safety-unit extraction, wave 1: `scripts/sync-plan.mjs`

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md) §4 (well-bounded
modules). Issue **AIO-540**. Test-infrastructure / code-structure domain. Build-with: **sonnet / medium** — a
behavior-preserving move of five functions between two files in one package, with an existing
end-to-end test as the oracle. Increment: **one reviewable PR** — one new `scripts/` module, the
matching edits in `scripts/aios.mjs`, and the mutation-config update. No behavior change.

## Why

`scripts/run-mutation.mjs` line 27 states the problem in its own words:

> _"The sync-plan safety gate (`buildPlan`: admin never syncs, default-deny on missing `access:`)
> lives in `scripts/aios.mjs` — **there is no sync-plan.mjs**."_

That comment records a structural gap and then works around it by aiming the mutator at the whole
2,519-line file. The workaround became permanent configuration: 96.4% of the file's 2,984 mutants
land in CLI subcommands the group's tests never invoke, which is why the campaign cannot finish
and why its score (3.5% for the file) describes file size rather than test quality — the full
evidence is in [`mutation-denominator.md`](./mutation-denominator.md).

AIO-539 applies one principle across the lane: **every group mutates the safety unit it protects,
and that unit is a module.** Four of the five groups already satisfy it — their units
(`src/operator-loop/inbox/capability.ts`, `scripts/toolkit-merge.mjs`,
`hooks/local-bugbot-gate.mjs`) are real files, so they need only an honest scope. `buildPlan` is
the sole exception, and this spec is what makes it satisfiable.

The alternative — pointing Stryker at a line range like `scripts/aios.mjs:334-412` — was
considered and rejected in AIO-539. A line range is a **coordinate, not a boundary**: it silently
stops describing `buildPlan` the moment anyone inserts a function above it, and it would need a
drift-guard test to stay honest. Building that mechanism only to delete it here is throwaway work
that leaves a speculative parser behind. Extraction gets the same denominator with no new
mechanism at all.

The repo already has the seam. `scripts/aios.mjs` imports from `scripts/workspace-parse.mjs`,
`scripts/tasks-table.mjs`, `scripts/brain-client.mjs`, `scripts/cli-common.mjs`, and `scripts/cli/dispatch.mjs` — the decomposition
pattern is established and the safety gate is simply one of the units that never got moved out.

This is wave 1 of several: `scripts/update.mjs` (1,470), `scripts/review-bugbot.mjs` (1,443),
`scripts/toolkit-pull.mjs` (1,216), and `scripts/inbox.mjs` (852) carry the same shape. Wave 1
takes the smallest, highest-stakes unit first to prove the pattern; the rest are Deferred.

## Dependencies

- **Independent of** [`mutation-denominator.md`](./mutation-denominator.md) (AIO-539) — they touch
  different groups and can land in either order or in parallel. AIO-539 leaves `access-governance`
  deliberately unscoped so its leg fails visibly rather than going green by dropping the safety
  gate; this spec is what turns that leg green, by making the group's coverage claim true.
- No new runtime or dev dependencies. `scripts/` stays zero-dep at runtime.

## Reuse (shipped, KEEP — moved verbatim, not rewritten)

- `scripts/aios.mjs` — `walkFiles` (254–290), `loadState` (291–301), `saveState` (302–318),
  `contentShaForPush` (319–333), `buildPlan` (334–412). These five are the unit; their bodies move
  unchanged.
- `scripts/workspace-parse.mjs` — `parseFrontmatter`, `normalizeTier`, `classifyKind`,
  `findSecret`, `redactAdminDecisionRows` and the other helpers `buildPlan` already imports. The
  new module imports them from the same place `scripts/aios.mjs` does today.
- `scripts/tasks-table.mjs` — `parseTaskRows`, likewise.
- `test/sync-plan.test.mjs` — the behavior oracle. It drives the real CLI (`aios status --json`,
  offline) against a throwaway workspace and asserts the blocked list and reasons, so it passes
  unchanged if and only if the extraction is behavior-preserving.
- `test/mutation-config.test.mjs` — the config-integrity suite, including line 123 (_"the sync-plan
  safety gate lives in scripts/aios.mjs and is mutation-covered"_) and the `nightlyExcludes`
  completeness assertion added by AIO-539.

## Contract

New module `scripts/sync-plan.mjs`, one narrow public surface — **what may leave the machine, and
the push state that records it**:

```
export function walkFiles(repo, cfg)
export function loadState(repo)
export function saveState(repo, state)
export function contentShaForPush(item)
export function buildPlan(repo, cfg, patterns, onlyPaths = null)
```

Signatures, argument order, defaults, and return shapes are **byte-identical** to the current
definitions; `buildPlan` keeps returning `{ plan, state }` with `plan` as
`{ push, blocked, clean }`. `scripts/aios.mjs` imports all five and keeps its three existing
`buildPlan` call sites (lines 457, 770, 900) and its `loadState`/`saveState`/`contentShaForPush`
call sites (761, 942, 974, 991, 1104, 1225, 1250) textually unchanged. No CLI surface, flag,
output format, or exit code changes.

## Build (net-new)

- **New file** `scripts/sync-plan.mjs` — the five functions above, moved verbatim, with the
  imports they need pulled from the same modules `scripts/aios.mjs` uses today. Module header states the
  invariant it owns (CLAUDE.md §3: admin never syncs; missing/unresolvable `access:` is
  default-denied; a tier outside `sync_tiers` is blocked) and that it is the mutation target for
  the access-governance group.
- **`scripts/aios.mjs`** — delete lines 254–412; add one import from `./sync-plan.mjs`. Any helper
  that becomes unused in `scripts/aios.mjs` as a result is removed from its import list (`lint` enforces).
- **`scripts/run-mutation.mjs`** — in the `access-governance` group, the **`scripts/aios.mjs`
  entry is replaced by `scripts/sync-plan.mjs`**; the group's other two entries are untouched. The
  array in full, so there is no ambiguity about scope:

  ```js
  nightly: [
    "hooks/file-governance-guard.mjs",
    "scripts/sync-plan.mjs",   // was "scripts/aios.mjs"
    "scripts/brain-client.mjs",
  ],
  match: /^(hooks\/file-governance-guard|scripts\/sync-plan|scripts\/brain-client)\.mjs$/,
  ```

  This is a one-for-one swap, **not** a narrowing to a single file: the group keeps mutating all
  three of its units and its denominator drops only by the 2,878 mutants that were never in scope
  to begin with. Both the nightly and changed-code lanes then scope correctly by construction, with
  no range mechanism.

- **`test/mutation-config.test.mjs`** — line 123 is updated to assert the safety gate now lives in
  `scripts/sync-plan.mjs` and that the group mutates it. AIO-539's `nightlyExcludes` completeness
  assertion keeps passing with **`nightlyExcludes: []` unchanged**, and this is checkable rather
  than asserted: `scripts/aios.mjs` is removed from `match` in the same edit, so it is no longer a
  file the group claims; `file-governance-guard.mjs` and `brain-client.mjs` stay in **both** `match`
  and `nightly`, so the `nightly ∪ nightlyExcludes ⊇ match` union stays complete with no new
  exclusion entries. Were the group instead narrowed to `sync-plan.mjs` alone, those two files
  would have to move into `nightlyExcludes` — that is precisely the coverage loss this spec does
  not make.

## Scope

**In:** the five-function extraction, the import rewiring, the mutation-group repoint, and the
config-test update.

**Deferred:** waves 2+ (`scripts/update.mjs`, `scripts/review-bugbot.mjs`, `scripts/toolkit-pull.mjs`, `scripts/inbox.mjs`, and
the 9,051-line `src/operator-loop/inbox/` tree); moving any _other_ function out of `scripts/aios.mjs`;
splitting `cmd*` handlers behind `scripts/cli/dispatch.mjs`; adding new tests for `buildPlan` beyond the
existing oracle (raising the score is a separate, honest piece of work once the denominator is
right).

## Tier safety

This module **is** the tier boundary — `buildPlan` decides what leaves the machine, and the brain
independently rejects admin-tier at its boundary with a 422 (`docs/brain-api.md`; vocabulary in
`scaffold/.claude/rules/frontmatter.md`). The load-bearing constraint is therefore that this is a
**move, not a rewrite**: no predicate, tier comparison, default-deny branch, or `sync_tiers` check
is edited in the same PR. Nothing becomes syncable that was not syncable before; no push-payload,
brain, or hook surface is touched. `test/sync-plan.test.mjs` passing unchanged is the evidence,
and any diff hunk inside the moved bodies is a review-blocking signal.

## Acceptance (observable)

- `git diff -M --stat` shows the five function bodies as **moved, not modified** — `git diff -M20%`
  detects the rename-like move, and the diff contains no edits inside those bodies.
- `node --test test/sync-plan.test.mjs` passes **unchanged** (no edits to that file in this PR) —
  the behavior-preservation oracle.
- `node scripts/test-suite.mjs` exits 0; `npm run lint` reports no unused imports in
  `scripts/aios.mjs`.
- `node scripts/run-mutation.mjs --nightly --group access-governance --list` shows exactly three
  entries — `hooks/file-governance-guard.mjs`, `scripts/sync-plan.mjs`, `scripts/brain-client.mjs` —
  and the campaign's mutant count is within ±10% of **~625**: `buildPlan`'s 106 plus
  `file-governance-guard.mjs`'s 343 and `brain-client.mjs`'s 176, all three measured in the
  2026-07-26 artifact. (The ±10% band absorbs the four small helpers — `walkFiles`, `loadState`,
  `saveState`, `contentShaForPush` — that move alongside `buildPlan` and were not separately
  counted.)
- The campaign completes in **under 25 minutes** — the `access-governance` leg goes from a
  timeout to a reported score for the first time.
- `grep -c "^function \(walkFiles\|loadState\|saveState\|contentShaForPush\|buildPlan\)"
scripts/aios.mjs` returns 0, and `wc -l scripts/aios.mjs` drops by ~160 lines.
- `node --test test/mutation-config.test.mjs` exits 0, with line 123 now naming `scripts/sync-plan.mjs`.

## Implementation

1. Create `scripts/sync-plan.mjs` with the five functions moved verbatim plus their imports.
2. Delete 254–412 from `scripts/aios.mjs`; add the import; prune now-unused imports.
3. Run `node --test test/sync-plan.test.mjs` and the full suite — green before any config change.
4. Repoint `access-governance` (`nightly` + `match`) at `scripts/sync-plan.mjs`; update line 123
   of `test/mutation-config.test.mjs`.
5. Run `node scripts/run-mutation.mjs --nightly --group access-governance` and record the mutant
   count and score in the PR body as the group's first real baseline.
