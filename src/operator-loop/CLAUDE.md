# Operator Loop — workflow engine

This is the V1 **Operator Loop**: the daily/weekly workflow engine that collects local
work signals, drafts tier-safe artifacts, verifies every shareable claim, and writes
back only what's approved. Governed by `docs/ENGINEERING-CONSTITUTION.md` — all-TypeScript,
well-bounded modules, typed tier-tagged signals into the loop, spec→plan→tasks→implement.
Don't port prior-build code verbatim; rebuild clean and typed.

## Stage pipeline (docs/v1-operator-loop/c1..c8 ↔ src files)

| Stage | Doc | Owning module |
|-------|-----|----------------|
| C1 Collector | `docs/v1-operator-loop/c1-collector.md` | `collector.ts` |
| C2 Evidence ledger | `c2-evidence-ledger.md` | `ledger.ts` |
| C3 Verifier | `c3-verifier.md` | `verifier.ts` |
| C4 Daily | `c4-daily.md` | `daily.ts` |
| C5 Weekly / closeout | `c5-weekly.md` | `closeout.ts` (drafts brief + digest, calls `drafter.ts`) |
| C6 Writeback | `c6-writeback.md` | `writeback.ts` |
| C7 Habit/continuity | `c7-habit.md` | `continuity.ts` (`.aios/loop/continuity/actions.json`) |
| C8 Telemetry | `c8-telemetry.md` | `telemetry.ts` |

Other top-level modules worth knowing before you dig in: `signal.ts` (shared signal
type), `spine.ts` (0–5 folder reads), `manifest.ts`, `mode.ts`, `config.ts`, `llm.ts`,
`connectors.ts`, `explain.ts`, `changes.ts`, `leak-sweep.ts`, `project.ts`, `parsers.ts`,
`index.ts` (composition root — wires the durable inbox journal etc.).

## Sub-packages (verify against the file before assuming behavior)

- **`inbox/`** — largest, its own subsystem (Unified Inbox, I-01/I-03). Three-authority
  model: the **Coordinator** (`capability.ts`) brokers the human decision but never sees
  request payload; the **owning runtime** mints the opaque capability handle, holds the
  authoritative pending record, and consumes it; the **policy gateway** decides
  disclosure/pre-send (`outbox.ts` `checkPreSend`, `reply-policy.ts`). Also: `state-machines.ts`,
  `host-health.ts`/`host-supervisor.ts` (host lifecycle), `credential-broker.ts`,
  `device-identity.ts`, `journal.ts`, `ranker.ts`/`ranker-adapter.ts`, `retention.ts`, `audit.ts`.
- **`asks/`** — the asks-queue: harvesting candidate asks (`harvest.ts`), persistence (`store.ts`),
  transport to surfaces (`transport.ts`).
- **`comms/`** — comms detectors/config/sending (`detectors.ts`, `sender.ts`, `config.ts`).
- **`decisions/`** — decision capture: distilling raw signal into decisions (`distill.ts`) + `store.ts`.
- **`sources/`** — per-source collector adapters feeding C1 (`tasks.ts`, `decisions.ts`, `comms.ts`,
  `deliverables.ts`, `github.ts`, `hours.ts`, `inbox.ts`, `maturity.ts`, `carryover.ts`, `time.ts`,
  shared `types.ts`).
- **`time/`** — time tracking capture/reconcile/runtime (`capture.ts`, `reconcile.ts`, `runtime.ts`,
  `session-log.ts`, `store.ts`, `config.ts`).

## Rubrics

`.claude/rubrics/` has one per stage group: `operator-loop-c1c2.md`, `operator-loop-c3.md`,
`operator-loop-c5.md`, `operator-loop-c6.md`, `operator-loop-c8.md` (no dedicated c4/c7
rubric file — c4/c7 are covered by c1c2/c5). When you change a stage, keep its rubric honest.

## Build

`npm run build:loop` runs `tsc -p tsconfig.json`. `dist/` is gitignored and rebuilt
automatically (`scripts/ensure-loop-built.mjs`, best-effort/never-throws) on postinstall,
worktree hydration, and lazy self-heal inside `scripts/aios.mjs`.

## Pointers

- `docs/v1-operator-loop/README.md` — the V1 hub (milestone, Linear epic AIO-122, evidence).
- `docs/v1-operator-loop/domains/unified-inbox.md` — the inbox domain spec.
