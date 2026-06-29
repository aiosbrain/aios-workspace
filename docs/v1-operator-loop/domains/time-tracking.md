# Domain spec — Time Tracking (native, Claude terminal sessions)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
The weekly closeout (C5) needs an honest picture of where time actually went, and the daily loop benefits from "what I worked on yesterday." Time should be captured natively from Claude terminal sessions — not hand-logged, not dependent on a third-party tracker.

## Reuse (shipped, KEEP)
- Only a markdown hours-log stub exists today (`scaffold/.claude/rules/hours.md`) — minimal.
- `aios analyze` already reads local session logs (a capture surface to lean on).

## Build (net-new clean TS — this is the biggest greenfield piece)
- **Session capture**: derive work blocks from Claude terminal session logs (start/stop, repo, duration) → tier-tagged time signals. No Toggl dependency.
- **Lightweight reconciliation**: a low-friction weekly confirm step (not the heavy prior-build pipeline). Reference the prior build's tag ontology (engineering / strategy / communication / admin / research / meetings) and scope-creep signal bands as *design reference only* — rebuild clean.
- Keep it optional and local-first; default-deny on tiering.

## Signal contract (emitted to C1)
`{ kind: "time", source: "session", tier, occurredAt, ref: <session id>, payload: { repo, durationMin, tag, taskRef? } }`

## Acceptance
- A week of sessions produces time signals with sensible tags and total hours.
- Weekly closeout surfaces time-by-tag; user can confirm/correct in the reconciliation step.
- Capture runs with zero external service and respects tier (no admin-tier session content in a shareable digest).
