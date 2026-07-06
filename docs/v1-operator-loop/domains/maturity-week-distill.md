# Slice spec — AM6b: `aios maturity-week` chains AM4b distill (default on)

Umbrella: [`maturity-loop.md`](./maturity-loop.md) · Linear: **AIO-267** (Backlog) · Parent epic: **AIO-226**.

## Prerequisites (shipped — no blockers)

This slice **only wires existing CLIs**; both upstream slices are already on `main`:

| Slice | Linear | Status | Shipped surface |
|-------|--------|--------|-----------------|
| AM4b instinct distill | [AIO-230](https://linear.app/je4light/issue/AIO-230) | **Done** | `aios instincts distill` → homunculus records + watermark |
| AM6 weekly report | [AIO-231](https://linear.app/je4light/issue/AIO-231) | **Done** | `aios maturity-week` → `3-log/maturity/week-<date>.md` |

**AM6b is unblocked** — implement by chaining those two paths in one command. Sibling **AM5** (`aios instincts score`, not filed) is deferred; score is *not* in this slice.

## Why

Operators will not remember a second weekly command. The domain pipeline already orders:

```
observe (Stop) → distill (batch) → score (batch) → weekly report
```

AM4a capture is automatic; AM6 report is the natural Monday cadence. **Distill belongs immediately before the report**, in the same CLI invocation, so one habit (`maturity-week`) closes the learning loop without touching homunculus paths, watermarks, or `claude -p` manually.

This is **not** Team Brain weekly closeout (`aios loop weekly`) — observations and homunculus instincts remain **admin-tier, local-only** (EE10). No `brain-api.md` change.

## What

Extend `aios maturity-week` so it **runs AM4b first by default**, then the existing AM6 report.

### CLI surface

```
aios maturity-week [--json] [--out <path>] [--project <slug>]
                   [--no-distill] [--distill-dry-run] [--distill-limit N]
```

| Flag | Default | Behavior |
|------|---------|----------|
| *(none)* | distill **on** | If unprocessed observations exist, run distill, then report |
| `--no-distill` | — | Skip distill entirely (AM6-only, today’s behavior) |
| `--distill-dry-run` | off | Distill groups only; no LLM, no homunculus writes, no watermark advance |
| `--distill-limit N` | unlimited | Pass through to distill (max observation **groups** per run) |

Existing flags unchanged. `--help` documents the distill chain.

### Orchestration (pure core + thin CLI)

1. **Refactor** `scripts/instincts.mjs`:
   - Export `runDistill({ repo, homunculusDir, projectId, dryRun, limit, distillFn })` — the repo-scoped path today inside `cmdInstincts` (read store → watermark filter → group → `distillObservations` → save watermark).
   - `cmdInstincts distill` becomes a thin wrapper around `runDistill` + stdout formatting (no behavior change).

2. **Extend** `cmdMaturityWeek` in `scripts/aios.mjs` (or move orchestration to `scripts/maturity-week.mjs` as `runMaturityWeekCloseout()`):
   - Parse `--no-distill`, `--distill-dry-run`, `--distill-limit`.
   - Unless `--no-distill`:
     - Call `runDistill({ repo, … })`.
     - **Skip LLM entirely** when `newObservations === 0` (watermark caught up) — do not shell `claude`.
     - If `claude` CLI missing and not `--distill-dry-run` and no `AIOS_INSTINCTS_DISTILL_STUB`: print one **warning** to stderr, continue to report (**fail-open on distill, fail-closed on tier** — never block the weekly read).
   - Then run existing AM6 path unchanged (`buildWeekReport` → file or `--json`).

3. **Report enrichment** (markdown + `--json`):
   - Add optional block **`## Instincts`** to `renderWeekReport` when a distill step ran (including dry-run):
     - `new observations`, `groups processed`, `written`, `updated`, `dropped`, `rejected`, `warnings` (counts only; no snippet text).
   - `--json`: top-level `distill: { …summary } | null` when `--no-distill`, `distill: null`.

### Cadence story (operator-facing)

One command, once a week (cron, Claude routine, or human):

```bash
npm run aios -- maturity-week --repo ~/Projects/john-workspace
```

That is the entire maturity closeout: **distill corrections → write week report**. No separate `instincts distill` to remember.

Document in [`docs/agentic-ergonomics/maturity-loop.md`](../../agentic-ergonomics/maturity-loop.md) § Cadence (replace “no scheduler” note for distill).

## Build

| File | Change |
|------|--------|
| `scripts/instincts.mjs` | Extract `runDistill()`; export for AM6b |
| `scripts/maturity-week.mjs` | Optional `distillSummary` section in `renderWeekReport` / report object |
| `scripts/aios.mjs` | Wire flags in `cmdMaturityWeek`; update `MATURITY_WEEK_HELP` + USAGE line |
| `test/maturity-week-distill.test.mjs` | New — mock `distillFn`, no live LLM |
| `test/maturity-week.test.mjs` | Assert report without distill block when `--no-distill` |
| `package.json` | Append new test to `npm test` chain |
| `docs/agentic-ergonomics/maturity-loop.md` | Cadence paragraph |

**Do not** wire into `aios loop weekly` or brain push in this slice.

## Acceptance criteria

1. **`npm run aios -- maturity-week --repo <ws>`** with pending observations: runs distill then writes `3-log/maturity/week-<monday>.md`; exit 0.
2. **Default distill on**: same command without flags runs distill when watermark is behind; with `--no-distill`, zero `claude` invocations and no distill section unless explicitly dry-run tested.
3. **Idle path**: watermark caught up → no `claude` call, report still written, `distill.newObservations === 0` in `--json`.
4. **Fail-open distill**: with `claude` absent, no stub, pending observations → stderr warning, report still written, watermark **not** advanced (distill did not run).
5. **`--distill-dry-run`**: prints distill summary, no homunculus files, no watermark advance; report includes dry-run counts.
6. **`aios instincts distill`**: unchanged behavior (standalone still works for debugging).
7. **Tests**: `node --test test/maturity-week-distill.test.mjs` green with mocked `distillFn` + tmp `AIOS_HOMUNCULUS_DIR`; no token spend in `npm test`.
8. **Verify**: `npm run build:loop && npm test && npm run lint && npm run format:check`.

## Non-goals

- AM5 effectiveness scoring (separate slice; do not block report on it).
- AM9 brain sync of instincts or maturity UI.
- AM8 scaffold / `aios maturity wire` (parallel; this slice only chains existing CLIs).
- Per-turn or SessionEnd auto-distill (weekly cadence only).
- Changing watermark semantics or confidence floor (AM4b owns those).

## Invariants

- All maturity stores + homunculus output remain **admin-tier, local-only**.
- **`report.mjs buildPushPayload()` unchanged** — nothing new crosses sync boundary.
- Distill LLM remains injectable; tests use mocked `distillFn` only.
- Live LLM tests stay double-gated (`INSTINCTS_LIVE=1`); AM6b tests never call default `claude -p`.

## Suggested Linear title

**AM6b — `maturity-week` chains instinct distill (default on)**

## Test sketch

```javascript
// Pending obs in tmp workspace → runMaturityWeekCloseout with mock distillFn
// → report.distill.written === 1, week md contains "## Instincts"
// --no-distill → distill null, no "## Instincts"
// caught-up watermark → distill skipped, claude never spawned (spy)
```
