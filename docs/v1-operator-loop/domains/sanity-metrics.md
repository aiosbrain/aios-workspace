# Domain spec — Sanity Metrics + Attention card + morning brief

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
[Agentic Ergonomics](../README.md) human-operating layer (epic AIO-166, issue **AIO-169 / EE3**).

## Why
The agentic-maturity axes (`scripts/analyze`) score *engineering* maturity. They say nothing about
the operator's **rhythm** — whether a day was deep work or frantic context-switching across a swarm
of concurrent sessions. AIO-169 adds four operationally-defined *sanity* signals, a compact
**Attention card** that reads them, and surfaces the operator's own **asks queue** (AIO-167) at the
top of the daily brief. All of it is **local-only** — none of it crosses the tier boundary to the
brain (the asks are admin-tier; the sanity signals are deliberately kept out of the push payload).

## Reuse (shipped, KEEP)
- **`scripts/analyze` pipeline** — `computeSignals` (metrics), `placement` (aem), `renderText` /
  `toJson` (report), `cmdAnalyze` (index). The four signals extend `computeSignals`; the card is a
  new export, NOT a 6th axis (axes stay frozen so the pinned baseline placement is stable — the
  6th-lens research is EE8 / AIO-174).
- **Asks store** (`src/operator-loop/asks/store.ts`) — `readAsks` + the folded `Ask` type.
- **C4 daily** (`src/operator-loop/daily.ts`) — `buildDailyOrientation` (pure) + `runDaily` (I/O),
  the `finish()`/`SECTION_CAP` capping pattern, and the audience gate (`visibleTiers`).

## Build (net-new)
- Four sanity signals in `scripts/analyze/metrics.mjs` (`computeAttentionSignals`, merged into
  `computeSignals` so they flow into `--json` totals AND per-day buckets).
- `attentionCard(signals)` in `scripts/analyze/aem.mjs`; rendered by `report.mjs` (text + `toJson`).
- `attention` + `queuedAsks` sections on `DailyOrientation`, rendered at the TOP of `aios loop daily`.

## Contract

### The four sanity signals (`computeSignals` output; over the GLOBAL interleaved timeline)
Computed over all events with a usable `ts`, sorted ascending. `IDLE_GAP_MIN = 25` is duplicated as
a local literal in `metrics.mjs` (plain ESM must not import from `dist/`); its **source of truth** is
`DEFAULT_IDLE_GAP_MIN` in `src/operator-loop/time/config.ts`.

- **`active_hours`** (internal denominator) — the sorted timeline is split into blocks at gaps
  `> IDLE_GAP_MIN`; each block's duration = `last.ts − first.ts` with a **floor of 1 min** per block
  (a single-event block counts 1 min); `active_hours = Σ block-min / 60`.
- **`focus_block_avg_min`** — mean block duration in minutes (2dp). `0` when no timestamped events.
- **`context_switch_rate`** — count of transitions where `project` changes between **consecutive
  user prompts** (`actor="user"`, `block_type="text"`, both projects non-null, global timestamp
  order), divided by `active_hours`. Prompts are the human acting; raw-event transitions would
  count sub-second interleaving of concurrent sessions — the machine, not the operator's
  attention.

- **`interrupts_per_hour`** — count of user prompts that HOP sessions (events with
  `actor === "user" && block_type === "text"` whose `session_id` differs from the previous such
  event), divided by `active_hours` (2dp). Measures attention-splitting across concurrent sessions.
- **`concurrent_sessions_peak`** — max distinct `session_id`s with ≥1 event in any single 5-minute
  UTC bucket (integer).

**Local-only:** these keys are NOT added to `buildPushPayload` (`report.mjs`) — they never reach the
brain. This is the EE10 boundary; do not add them to the push payload.

### Attention card (`attentionCard(signals)` → `report.toJson().attention`)
`{ label: "Attention", metrics: { context_switch_rate, focus_block_avg_min, interrupts_per_hour,
concurrent_sessions_peak }, reading }`. `reading` is a one-line human interpretation from simple
bands (deep-work leaning · orchestration-heavy · mixed · no activity). NOT an AEM axis.

### Daily brief sections (`DailyOrientation`)
- `attention: DailyItem[]` — open **blocker** asks, oldest-first.
- `queuedAsks: DailyItem[]` — open **decision**/**fyi** asks, decisions before fyi, newest-first
  within each severity.
- Both capped via `finish()`/`SECTION_CAP`; `counts.attention` / `counts.queuedAsks` hold true totals.
- **Owner-only (constitution hard rule):** asks are admin-tier — they are surfaced ONLY when
  `audience === "owner"`. For any other audience both sections are empty and the asks never enter the
  output (they are not "excluded" entries either). Rendered at the TOP of `aios loop daily`.

## Acceptance
- `aios analyze --json` shows the four signals with sane values on the pinned baseline window
  (rates non-negative + finite; `focus_block_avg_min` plausible minutes; `concurrent_sessions_peak`
  a small integer), plus an `attention` card.
- The daily brief renders both **Attention** and **Queued asks** sections when open asks exist, and
  hides them entirely for a `--as team`/`--as external` view.

## Implementation
`scripts/analyze/metrics.mjs` (`computeAttentionSignals`), `scripts/analyze/aem.mjs`
(`attentionCard`), `scripts/analyze/report.mjs` (render + `toJson`), `src/operator-loop/daily.ts`
(sections + `runDaily` fail-soft `readAsks`), and the `renderDaily` view in `scripts/aios.mjs`.
Tests: `test/analyze.test.mjs` (signals + card), `test/operator-loop/daily.test.mjs` (pure sections
+ audience gate), `test/operator-loop/daily-cli.test.mjs` (live seeded-asks CLI round-trip).
