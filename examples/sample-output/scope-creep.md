# Scope-Creep Register — Northwind Robotics (Sprint 1 "Foundations")

**Audit date:** 2026-06-05
**Deliverables reviewed:** 5 in `02-deliverables/sprint-1/`
**Baselines:** `00-engagement/scope-baseline.md`, `00-engagement/scope-ledger.md`
**Flagged:** 2 (1 out-of-scope, 1 watch) · **Clear:** 3

---

## OUT-OF-SCOPE (1)

### 1. `predictive-maintenance-prototype.md`
- **Deliverable:** Technical plan for a predictive-maintenance prototype (data pipeline, model, dashboard) over Northwind's warehouse-robot telemetry, spanning two sprints — a net-new software build.
- **Baseline:** scope-ledger.md entry #4 (2026-03-26, Predictive-maintenance prototype, **Status: OUT-OF-SCOPE**) — "Net-new build; would require a change order. Logged for the record." Reinforced by scope-baseline.md "Out of scope (unless a signed change adds it)" (net-new software builds, data-pipeline engineering).
- **Why:** A net-new software build with no contracted track (1 readiness, 2 learning journeys, 3 governance, 4 roadmap) covering it, and no ACCEPTED ledger entry conferring scope — only an explicit OUT-OF-SCOPE log entry. The document itself states it "would require a change order." Not ambiguous.
- **Action:** Do not proceed. Requires a signed change order before any delivery work.

---

## WATCH (1)

### 2. `support-chatbot-design.md`
- **Deliverable:** Draft design-only chatbot exploration for the Head of Support — a proposed conversation flow plus a future-sprint build plan that the document itself notes exceeds the agreed design-only boundary and is uncontracted.
- **Baseline:** scope-ledger.md entry #3 (2026-03-18, Support chatbot — design only exploration, **Status: PENDING** — "design sketch acceptable, no build"); scope-baseline.md "Out of scope (unless a signed change adds it)" (net-new software builds).
- **Why:** Genuinely borderline. The design-only portion maps to ledger entry #3, but that entry is PENDING (not ACCEPTED) — coverage is not ratified, so it cannot be cleared to in-scope. The embedded future-sprint build plan exceeds the design-only boundary and is uncontracted, which the baseline "Out of scope" section would bar as a net-new software build.
- **Action:** Flag for human review. Keep the design sketch design-only; the build plan must not proceed without an accepted ledger entry / change order.

---

## CLEAR (3) — traceable to contracted tracks
| File | Track |
|------|-------|
| `ai-readiness-assessment-report.md` | Track 1 (1.1 survey + 1.2 findings) |
| `governance-framework.md` | Track 3 (3.1 policy + register, 3.2 advisory gates) |
| `ops-team-learning-journey.md` | Track 2.1 (operations team learning journey) |
