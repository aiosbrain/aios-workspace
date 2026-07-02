# Domain spec — Agentic Maturity

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).
The behavioral standard AEM scores against is the
[Build Paradigm](../../agentic-ergonomics/build-paradigm.md) (AIO-172): the Attention card
measures its "leverage per unit of attention" premise, and placement guidance links its sections
rather than restating them.

## Why
Analysis of each coding session — fed back to the user and into the team brain — is a headline AIOS capability and a differentiator. For V1 it is the most mature of the five domains; the work is mostly *wiring it into the loop*, not building it.

## Reuse (shipped, KEEP — production-ready)
- `aios analyze` (session analysis, cost/quality metrics) — workspace PR #83/#81/#82.
- Agentic Engineering Maturity engine: L0–L5 placement, 5 axes, verification cap, `individual.rubric.json`, `agentic-maturity` skill, durable `.claude/memory/MATURITY.md`.
- Brain-side AEM ingest + team rollup (brain PR #20/#21/#23/#28).

## Build (net-new clean TS — minimal)
- **C8 telemetry wiring**: feed `aios analyze` output into the loop's telemetry (dogfood exit-criteria measurement) as tier-tagged signals.
- **Standalone maturity view** in the cockpit reading from `MATURITY.md` + analyze output.

## Signal contract (emitted to C1)
`{ kind: "maturity", source: "analyze", tier, occurredAt, ref: <analyze run id>, payload: { placement (L0-L5), axisScores, costTotals, sessionCount } }`

## Acceptance
- A weekly run includes a maturity/telemetry slice sourced from this signal.
- Placement + next prescribed pattern are visible in the standalone view.
- No regression to the existing `aios analyze` / maturity skill behavior.
