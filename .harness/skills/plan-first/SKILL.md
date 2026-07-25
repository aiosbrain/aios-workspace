---
name: plan-first
description: Research → Plan → Implement discipline for any non-trivial change. Use BEFORE writing code when a task touches more than one file, introduces a dependency, changes behavior users see, or when the user asks to "plan", "spec", or "design" something. Skip only for one-sentence diffs.
source: Dex Horthy (HumanLayer, advanced-context-engineering / 12-factor agents); Boris Cherny (plan-mode-first)
am_pattern: B1, B3
triggers:
  - write a plan
  - implementation plan
  - plan before
  - plan this work
  - break down this task
  - plan first
---

You are running the RPI loop: **Research → Plan → Implement**. The plan — not the diff —
is where human review has the most leverage. A bad line in a plan becomes hundreds of bad
lines of code, so the plan is the artifact you polish and the human approves.

## Phase 1 — Research (fresh context, subagents if available)

1. Restate the task in one sentence. If any requirement is ambiguous, **interview the
   requester first** — ask the 2–3 questions whose answers change the design. The #1
   agent failure is running with a wrong assumption.
2. Explore the code that the change touches: entry points, the module boundaries, an
   existing "good example" to copy, the tests that cover the area. Push bulk
   file-reading into subagents that return summaries — keep this session's context for
   the decisions. Aim to keep context utilization in the 40–60% band; if research gets
   noisy, compact what you learned into notes and continue from those.
3. Write down the constraint set: what must not change, what must be true after.

## Phase 2 — Plan (the reviewed artifact)

Produce a plan with exactly these sections:

- **What / why** — the behavior and the reason it matters.
- **Approach** — modules touched, interfaces/types named *before* implementation steps,
  trade-offs considered (one alternative, one sentence on why not).
- **Acceptance criteria** — itemized, each one observable/self-verifiable (a command, a
  test name, a visible behavior).
- **The check** — the single command or procedure the implementer runs to know it works.
- **Out of scope** — what is deliberately cut.

Grade it against `rubrics/spec-readiness.md` mentally (or with the adversarial-verifier
agent): *could a cold-start agent with no conversation history pick this up and start
correctly?* If not, it isn't ready.

**Stop here for human review of the plan.** Do not start implementing in the same breath
unless the requester pre-approved that.

## Phase 3 — Implement

Execute against the approved plan, ideally in a fresh session with the plan as input.
The plan's acceptance criteria are the definition of done. If implementation reveals the
plan was wrong, **go back and change the plan** — code drifting silently from its plan
is a bug in one of them.
