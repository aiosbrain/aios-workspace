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
| Attention Mode (AIO-168) | [attention-mode.md](./attention-mode.md) | **Net-new** deep-work / orchestration toggle for the local notification ping (`aios mode`); push untouched |
| Sanity Metrics (AIO-169) | [sanity-metrics.md](./sanity-metrics.md) | **Net-new** four operational attention signals + Attention card in `aios analyze`, and Queued-asks/Attention sections in the daily brief; **local-only** (never pushed) |
| Decision Capture (AIO-170) | [decision-capture.md](./decision-capture.md) | **Net-new** human-in-the-loop decision corpus (`aios decisions`): a PostToolUse hook captures `AskUserQuestion` + plan-approval prompts into an append-only store; **local-only** admin-tier (never pushed) |
