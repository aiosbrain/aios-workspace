# Devtools ↔ Toolkit Contract (AIO-594)

The devtools-bound command set — `scripts/ship.mjs`, `scripts/ship/`, `scripts/build.mjs`,
`scripts/roadmap-run.mjs`, `scripts/spec-eval.mjs`, `scripts/spec-publish.mjs`,
`scripts/consolidate-findings.mjs` — moves to the `aiosbrain/aios-devtools` repo. This document
is the **declared seam** those files use to reach core-staying modules, implementing the
program's governing rule: *no extraction until contents work through declared public interfaces
in-repo*. It is the devtools sibling of `docs/gui-toolkit-contract.md` (same markers, same
explicit-source-never-falls-back rule).

Evidence base: the AIO-594 throwaway-mirror rehearsal (`evidence-rehearsal.json`, 2026-07-30),
whose findings F1/F3/F4/F5/F6 this seam resolves. F2 (spec-publish → `promote.mjs`
`defaultScanFile`) is a **known open item** for a pre-cut core leaf extraction and is *not*
covered by this seam.

## Toolkit location — `scripts/toolkit-locate.mjs`

One implementation. Every core-staying module a devtools file loads resolves through
`loadToolkitModule(rel)` — never a static `import`, never a hand-rolled relative path.

Resolution order (`locateToolkit()`):

1. explicit `--toolkit-dir <path>` argv flag (or a `toolkitDir` param) — the devtools arg
   parsers must learn to tolerate the flag at cut time; today the env var is the supported
   standalone mechanism;
2. `AIOS_TOOLKIT_DIR` env var;
3. the containing repo root (`scripts/..`), when it looks like a toolkit — pre-cut this is
   always true, so everything works unchanged in-monorepo;
4. otherwise **fail with an actionable error** naming the candidate, its source, the missing
   markers, and `AIOS_TOOLKIT_DIR` as the fix.

A resolved toolkit must contain `scripts/aios.mjs`, `scaffold/`, and a root `package.json`
(`TOOLKIT_MARKERS`, same triad as the GUI locator). An **explicit** source (1 or 2) that fails
validation is a hard error — it never silently falls back. The resolved dir is `realpath`'d, so
in-monorepo the seam's dynamic `import(pathToFileURL(...))` resolves to the very same module
URLs as the pre-seam static imports: one ESM cache entry, identical module instances, no
behavior change.

## Modules the devtools set may load through the seam

| Toolkit module | Exports used | Consumers |
|---|---|---|
| `scripts/review-bugbot.mjs` | `runLocalPrePrReview`, `runLocalBugbotReview`, `resolveRequiredBugbotBase`, `REQUIRED_BUGBOT_MODEL`, `REQUIRED_BUGBOT_FAIL_ON` | `ship.mjs` (F1), `build.mjs` (F1) |
| `scripts/simplify.mjs` | `runSimplify` | `ship.mjs` (F6) |
| `scripts/relay.mjs` | `callOpus` | `ship/runtime.mjs` (F3, SDK plan-runner only) |
| `scripts/spec-author.mjs` | `cmdSpecAuthor` | `spec-eval.mjs` (F4, `spec author` subcommand only) |

Loads happen at **point of use** (inside the running command, on the path that needs the
engine), so a standalone devtools command only requires the toolkit when it actually invokes a
core engine, and dependency injection (`deps.runLocalPrePrReview`, `opts.runLocalBugbotReview`,
etc.) still bypasses the load in tests.

The severity **verdict matchers** (`hasFindingsAtOrAbove`, `hasCriticalOrHighFindings`,
`canonicalSeverity`) are deliberately NOT behind the seam: per the rehearsal's F1 fix they moved
into the core leaf `scripts/severity.mjs` (already in the declared copy set), and
`review-bugbot/findings.mjs` re-exports them for back-compat. `consolidate-findings.mjs` and
`build.mjs` import them statically from the leaf and have no runtime toolkit dependency for
matching.

## Optional capability: compiled operator loop (F5)

`spec-eval.mjs`'s EE4 decision enrichment (`loadRecentDecisions`) reads
`<toolkit>/dist/operator-loop/index.js`, resolved via the toolkit seam. The capability is
**advisory and never blocks — but never degrades silently**: when the dist is missing,
unloadable, or exports no `readDecisions()`, spec-eval emits one stderr line naming the path and
the fix (`npm run build:loop` in the toolkit) and evaluates with an empty decision corpus.

## Standalone requirements (post-cut)

- A core `aios-workspace` checkout, pointed at via `AIOS_TOOLKIT_DIR` (or `--toolkit-dir` once
  the arg parsers accept it). Without one, only the seam-loading paths fail — with the
  actionable locator error, not `ERR_MODULE_NOT_FOUND`.
- `@anthropic-ai/sdk` declared in the devtools `package.json` (bare import in
  `ship/runtime.mjs`; rehearsal F8) and `@aiosbrain/foundation` for the hub imports.
- Open pre-cut items tracked from the rehearsal: F2 (`promote.mjs` → leaf extraction), F7
  (copy-set duplicates + convergence deadlines), F9 (target-repo push mechanics).

## Boundary gate

`scripts/check-boundaries.mjs` R6 already encodes the cut direction (core must not import
devtools; devtools → core is allowed). The seam's non-literal
`import(pathToFileURL(join(toolkitRoot, …)))` is deliberately outside the gate's literal-import
parser; the guarantee that devtools files carry **no static or literal-dynamic imports** of the
stays-core engine set is enforced by `test/devtools-seam.test.mjs` instead.
