# Rule: Decision Log

Every workspace keeps one decision log at `3-log/decision-log.md`. It is the
durable record of choices that needed coordination — the first thing a new
collaborator reads to understand *why* things are the way they are.

## Format

A single Markdown table, **newest first**:

```
| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
```

- **#** — monotonic integer, never reused.
- **Date** — ISO `YYYY-MM-DD`.
- **Decision** — what was decided, in one sentence. End with the bracket tag (below).
- **Rationale** — *why*. Not a restatement of the decision — the actual reason.
- **Decided By** — who held the authority for this call.
- **Impact** — what changes as a result; downstream consequences.
- **Type** — reversibility tier (1/2/3, below).
- **Audience** — who may see it: `private` | `team` | `client`/`company`
  (canonical `admin` | `team` | `external`).

### Type (reversibility)
- **Type 1** — routine, easily reversed (a task assignment, a meeting time).
- **Type 2** — significant, hard to reverse cheaply (an architecture choice, an
  access grant, a scope change).
- **Type 3** — high-stakes, shapes the engagement (pricing, a framework-wide
  rollout, winding down).

### Audience (who may see it)
- **private** (canonical `admin`) — your machine only; never syncs.
- **team** — visible to the delivery team / department via the brain.
- **client**/**company** (canonical `external`) — appropriate to surface
  outward, and recorded in the shared-surface log (`4-shared/`) when it is.

## Conventions
- One decision per row. If a meeting produced five decisions, log five rows.
- Log the decision when it is made, not in a weekly batch.
- A decision with no rationale or no owner is incomplete — fill it in.
- The `decision-audit` skill lints this log against these conventions.
