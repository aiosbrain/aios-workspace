# V1 workflow domains

The five workflow domains that emit signals into the [Operator Loop](../README.md).
Each is a well-bounded TypeScript module per the [Engineering Constitution](../../ENGINEERING-CONSTITUTION.md).

| Domain | Spec | V1 posture |
|--------|------|-----------|
| Tasks & PM (Linear) | [tasks-pm.md](./tasks-pm.md) | Reuse projection rails; build loop writeback + standalone surface |
| Time Tracking | [time-tracking.md](./time-tracking.md) | **Net-new** native session capture (biggest greenfield piece) |
| Agentic Maturity | [agentic-maturity.md](./agentic-maturity.md) | Production-ready; wire into C8 + standalone view |
| Communication | [communication.md](./communication.md) | Reuse connectors; build **unified notification layer** |
| Meetings | [meetings.md](./meetings.md) | Reuse Granola + decisions; build stakeholder map + governance nudge |
