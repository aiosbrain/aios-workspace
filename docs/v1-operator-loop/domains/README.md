# V1 workflow domains

The five workflow domains that emit signals into the [Operator Loop](../README.md).
Each is a well-bounded TypeScript module per the [Engineering Constitution](../../ENGINEERING-CONSTITUTION.md).

| Domain | Spec | V1 posture |
|--------|------|-----------|
| Tasks & PM (Linear) | [tasks-pm.md](./tasks-pm.md) | Reuse projection rails; build loop writeback + standalone surface |
| ↳ Bidirectional sync | [bidirectional-pm-sync.md](./bidirectional-pm-sync.md) | Finish deferred Phase 5 (AIO-78): Linear ⇄ brain — inbound apply + create, conflict-safe |
| Time Tracking | [time-tracking.md](./time-tracking.md) | **Net-new** native session capture (biggest greenfield piece) |
| Agentic Maturity | [agentic-maturity.md](./agentic-maturity.md) | Production-ready; wire into C8 + standalone view |
| Communication | [communication.md](./communication.md) | Reuse connectors; build **unified notification layer** |
| Meetings | [meetings.md](./meetings.md) | Reuse Granola + decisions; build stakeholder map + governance nudge |
| Asks Queue (AIO-167) | [asks-queue.md](./asks-queue.md) | **Net-new** non-blocking escalation queue (append-only store + capture hook + inbox transport + CLI); dogfood-only slice |
