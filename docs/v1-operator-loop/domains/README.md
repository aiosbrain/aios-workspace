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
| Unified Inbox (AIO-381 / I-01) | [unified-inbox.md](./unified-inbox.md) | **Net-new** meta-inbox over agent asks + external comms: `inbox-events.ndjson` journal, SQLite read model (D5), orthogonal state machines, runtime-issued capability handle, reply PDP, enriched observations, audit anchor (D6), pre-registered metrics |
| Attention Mode (AIO-168) | [attention-mode.md](./attention-mode.md) | **Net-new** deep-work / orchestration toggle for the local notification ping (`aios mode`); push untouched |
| Sanity Metrics (AIO-169) | [sanity-metrics.md](./sanity-metrics.md) | **Net-new** four operational attention signals + Attention card in `aios analyze`, and Queued-asks/Attention sections in the daily brief; **local-only** (never pushed) |
| Decision Capture (AIO-170) | [decision-capture.md](./decision-capture.md) | **Net-new** human-in-the-loop decision corpus (`aios decisions`): a PostToolUse hook captures `AskUserQuestion` + plan-approval prompts into an append-only store; **local-only** admin-tier (never pushed) |
| Workflow Inventory (Generative Education / GE1) | [workflow-inventory.md](./workflow-inventory.md) | **Net-new** automation-candidate scoring (`automation_readiness`/`automation_candidate`/`time_cost_hours`) on the existing Company-Graph `workflow` entities (AIO-141); gates Generation Engine |
| Competency Taxonomy (Generative Education / GE2) | [competency-taxonomy.md](./competency-taxonomy.md) | **Net-new** role-specific AI-working skill map per job family, on the existing Company-Graph `actor` entities; parallelizable with Workflow Inventory |
| Generation Engine (Generative Education / GE3) | [generation-engine.md](./generation-engine.md) | **Net-new** widens the Maturity Loop's shipped `SessionStart` feed-forward (AM2) from a maturity tip to `{tip, lesson, automation-proposal}`; hard-gated on GE1 + GE2 |
