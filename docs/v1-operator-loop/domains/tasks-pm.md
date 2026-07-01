# Domain spec — Tasks & PM (Linear)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
Tasks are the operator's "what I owe next." The loop's daily (C4) and weekly (C5) cadences both depend on a trustworthy task picture, and the weekly closeout writes approved next-week actions back (C6). Linear is the chosen PM tool; the brain `tasks` table is the canonical source and Linear is a one-way downstream projection.

## Reuse (shipped, KEEP)
- Brain→Linear projection rails — epic **AIO-72**, brain-api **v1.2** (brain PR #44/#55).
- Hierarchical task CRUD + parent integrity (brain PR #69), reactive auto-projection (brain PR #64), divergence detection (brain PR #70).
- `/aios-linear` skill (`linear.mjs`) for board reads/writes.

## Build (net-new clean TS)
- **Loop writeback adapter (C6)**: take approved weekly next-week actions → brain tasks → projected to Linear via existing rails. Approval-gated, default no-write.
- **Standalone task surface** in the cockpit (read + light edit), sourced through `useConnection().api`.
- Retire residual **Plane** code paths (Plane is retired; do not delete history, just stop projecting).

## Signal contract (emitted to C1)
`{ kind: "task", source: "brain|linear", tier, occurredAt, ref: <task id / Linear identifier>, payload: { title, status, assignee, parent, priority, blocked, owedToday } }`

## Acceptance
- Daily loop shows open + carried-over next-actions sourced from this signal.
- Weekly closeout can propose next-week actions; on approval they write to brain and project to Linear with a visible "reason"/success state (brain PR #61).
- No task write occurs without explicit per-target approval.
