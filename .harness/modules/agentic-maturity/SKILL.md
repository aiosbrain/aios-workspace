---
name: agentic-maturity
description: Place an engineer on the Agentic Maturity model (5-level spine × 5 axes) via a short interview, apply the verification cap, and prescribe the 2-3 highest-leverage patterns to practice next. Use when someone asks "assess my agentic maturity", "what should I learn next", "rate my AI workflow", or when planning a team rollout rung-by-rung.
source: AIOS Agentic Maturity framework + the aios-workspace agentic-maturity skill (this is the standalone adaptation; the upstream version adds signal-based scoring from real session logs)
am_pattern: E5
---

You are placing an engineer on the **Agentic Maturity (AM) model** and prescribing
their next step. This standalone version places from a short interview; if the
`modules/aios-cli` module is installed, seed it with objective signals first
(`aios analyze --since 30d --json`) and use the interview to confirm.

**The core rule (never violate):** the spine level is **capped at L3 while the
Verification axis scores ≤ 1**. There is no real agentic maturity without
verification — say so plainly when the cap bites.

## The model in brief

**Spine (L1–L5):** Prompting → Prompt Engineering → Context Engineering → Agentic
Engineering → Agentic Orchestration.
**Axes (0–4 each):** Verification · Context hygiene · Autonomy/leash · Learning/
compounding · Cost & governance.

## Step 1 — interview (one batch, plain questions)

Ask as one numbered batch, free-form answers:

1. **Spine** — which is most true *under pressure, not on your best day*: (a) I prompt
   and accept what comes back · (b) I craft prompts carefully per task · (c) I manage
   what the model sees — files, examples, fresh sessions · (d) I delegate whole tasks
   against checks the agent runs itself · (e) I run multiple agents/loops in parallel
   and review at the plan/verdict level.
2. **Verification** — when an agent finishes, how do you know it's correct?
3. **Context** — how do you manage what the model sees across a session?
4. **Autonomy** — how do you decide how much an agent does on its own?
5. **Learning** — an agent makes a mistake; what's different next time?
6. **Cost/governance** — how aware are you of token cost and permission discipline?
7. **Delegation share** — roughly what % of your work is delegated-and-verified?

## Step 2 — score

Band each axis 0 / 2 / 4 (0 = absent, 2 = ad-hoc/sometimes, 4 = systematic/habitual);
interpolate 1 and 3 when an answer sits between. Spine = the reliable default mode from
Q1, sanity-checked against Q7 (claiming L4 with <20% delegated-and-verified work is
optimism, not placement). **Apply the verification cap.** Identify the weakest axis —
it drives the prescription.

## Step 3 — prescribe from this pack

Target the weakest axis with 2–3 components, each with a first action for this week:

| Weakest axis | Prescribe |
|---|---|
| Verification | `verify-change` + a real `.harness/check`; then `agents/code-reviewer` on every agent diff; then the stop-verify-gate hook |
| Context hygiene | the `AGENTS.md` contract (fill the five questions in `docs/adopt-any-stack.md`); fresh sessions per task; `modules/context-monitor` |
| Autonomy/leash | `docs/autonomy-ladder.md` — place the work, not just the person; guard hooks on; `skills/plan-first` before lengthening anything |
| Learning/compounding | `skills/compound-learnings` after every corrected mistake; the error ledger; weekly compounding review |
| Cost & governance | `models/routing.yaml` lanes + `modules/cost-monitor`; permission rails in the adapter |

## Step 4 — record it

Write the placement to a durable file the person owns (e.g.
`.claude/memory/MATURITY.md` or the team's equivalent): date, spine level, five axis
scores, whether the cap applied, weakest axis, prescription. Append one history line so
progression is visible at the next check-in. Report back in one tight paragraph:
placement, the one rule if the cap bit, and the single first action.

For teams: run this per engineer, then set each person's starting rung on the
[autonomy ladder](../../docs/autonomy-ladder.md) from their Verification score — never
from their spine claim.
