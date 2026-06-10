# Sample output — weekly-synthesis

Real output of `weekly-synthesis.workflow.js` against the synthetic Northwind
engagement (`examples/sample-engagement/`), window **2026-03-25 → 2026-03-31**,
rubric `.claude/rubrics/weekly-synthesis.md`. Committed verbatim — including
the verifier's fix hint — because the grade report is part of the output.

**Run result:** `passed: true` · `loops_used: 0` · `budget: 3` · 4 agents

## Grade report (independent verifier)

| ID | Pass | Evidence (abridged) |
|----|------|---------------------|
| WS1 | ✓ | Read all 7 source files; every cited path exists. Spot-checked grounding: entries #16–#20 match the log verbatim; deliverable statuses match frontmatter. *Fix hint flagged:* risk #3 says "three of six tracked tasks" — tasks.md has 8 tasks with Riley owning 4. |
| WS2 | ✓ | No rates/margins/P&L/psych/negotiation content. The pricing decision (#10) is outside the window and correctly absent. |
| WS3 | ✓ | In-window decisions are exactly #16–#20; all five appear in the digest. 5/5 covered. |
| WS4 | ✓ | "Newly done" (T-01) and "blocked" (T-08) are the only done/blocked rows — IDs, names, assignees match exactly. |
| WS5 | ✓ | 435 words (limit 600), counted mechanically. |
| WS6 | ✓ | Risks section disclaims inference explicitly and tags each item "(Inference)" with cited facts. |

> Note what the gate did and didn't catch: WS1 checks *citation grounding*, so
> the "three of six" miscount passed the criterion while still being flagged as
> a fix hint. If this class of error recurs, that's a memory incident → a
> sharper rubric criterion (the convention-#13 loop working as intended).

## Digest (as produced)

# Weekly Team Digest — 2026-03-25 → 2026-03-31

## Decisions

### High significance (client-facing / scope)
- **2026-03-25 — Interim AI-readiness results shared with the Northwind CEO** (Alex). Elevates visibility of the readiness work at the client's top level (03-status/decision-log.md, #16).
- **2026-03-26 — Predictive-maintenance prototype request recorded as out-of-scope**; requires a change order, tracked as scope ledger #4 (Alex) (03-status/decision-log.md, #17).
- **2026-03-27 — Phase-2 proposal to be delivered to client leadership at Sprint 1 close** (Alex + Dana, Northwind) (03-status/decision-log.md, #18).

### Routine / team-level
- **2026-03-30 — Ops learning journey Day 1 session delivered; feedback positive** (Riley) (03-status/decision-log.md, #19).
- **2026-03-31 — Ops learning journey Day 1 delivered to the operations team with strong engagement** (Riley) (03-status/decision-log.md, #20). Note: #19 and #20 appear to record the same Day 1 delivery on consecutive days.

## Scope
- **One move out of scope:** the predictive-maintenance prototype request was ruled out-of-scope for Sprint 1 Foundations and needs a change order (scope ledger #4) (03-status/decision-log.md, #17). However, a draft deliverable for it already exists — created 2026-03-26, owner Sam (02-deliverables/sprint-1/predictive-maintenance-prototype.md).

## Tasks

### Newly done
- **T-01 — Run readiness survey + score** (Riley) (03-status/tasks.md).

### Currently blocked
- **T-08 — Phase-2 proposal** (Alex) (03-status/tasks.md).

### In progress (context)
- T-02 Readiness findings report (Riley); T-03 Ops LJ curriculum + deliver (Riley); T-05 AI usage policy + risk register (Jordan); T-07 12-month transformation roadmap (Alex) (03-status/tasks.md).

## Risks

All items below are **inferences** from the week's data, not stated risks.

1. **Phase-2 commitment vs. blocked task.** The team committed to delivering the Phase-2 proposal to client leadership at Sprint 1 close (03-status/decision-log.md, #18), yet T-08 (Phase-2 proposal, Alex) is blocked (03-status/tasks.md). If the blocker isn't cleared promptly, a client-facing deadline is at risk. *(Inference)*
2. **Scope-creep signal on predictive maintenance.** The request was formally declared out-of-scope pending a change order (03-status/decision-log.md, #17), but a draft deliverable exists anyway (02-deliverables/sprint-1/predictive-maintenance-prototype.md, status: draft, owner Sam). Work may be proceeding ahead of commercial approval. *(Inference)*
3. **Load concentration on Riley.** Riley owns three of six tracked tasks (T-01 done, T-02 and T-03 in progress) plus delivered the ops learning journey Day 1 this week (03-status/tasks.md; 03-status/decision-log.md, #19–20). A single point of dependency for readiness and enablement workstreams. *(Inference)*
4. **Sprint-close deliverable readiness.** With Sprint 1 close approaching, only one deliverable is final (ops-team-learning-journey.md); two are in review (ai-readiness-assessment-report.md, governance-framework.md) and two remain drafts (predictive-maintenance-prototype.md, support-chatbot-design.md) (02-deliverables/sprint-1/). Review cycles could compress against the Phase-2 proposal milestone. *(Inference)*
5. **Decision-log hygiene.** Entries #19 and #20 duplicate the same Day 1 delivery (03-status/decision-log.md), suggesting double-logging that could muddy the audit trail. *(Inference)*
