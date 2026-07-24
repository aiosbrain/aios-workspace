---
access: team
type: rule
summary: Agentic Linear factory — triage, pick-up-able specs, workstream batches, closeout
---

# Linear factory operations

Companion to the `aios-linear` and `workstream-update` skills. Linear issue bodies are **agent contracts** graded by `aios spec eval`.

## Triage inbox

- Capture raw work (screenshot, one-liner) into **Triage** — do not interrupt active agent batches.
- `linear.mjs create "<title>" --template aios --state Triage`
- Intake: fill all template sections → `aios spec eval` → `set-state Backlog` when `SPEC_READY`.

## Pick-up-able spec shape

Use `docs/agentic-ergonomics/aios-issue-template.md` (or `aios spec init`). Required sections map to SR1–SR7 in `.claude/rubrics/spec-readiness.md`.

## Outcome hierarchy

- Parent issues = outcomes/epics; children = shippable slices.
- Title in outcome language ("Operator sees unified inbox timeline"), not implementation jargon.
- Dependencies via `linear.mjs blocks <blocker> <blocked>`.

## Workstream batches

- Run `workstream-update` before starting parallel agents.
- 3–5 workstreams, non-overlapping code surfaces.
- Finish in-progress trees before new epics.
- Each prompt names AIO ID(s), verification checklist, and "unsupervised batch" expectation.

## Session closeout

Before ending a batch:

1. PR merged (or blocked with `set-state Blocked` + escalation comment)
2. Acceptance criteria subsections ticked in issue or PR evidence
3. Transcript copied to `.aios/loop/<AIO-n>/` when using `aios ship`
4. `aios time capture` for runtime log

## Agent writes in Linear

Use `LINEAR_API_KEY` for a bot/service identity — not personal OAuth — so assignments and closes notify correctly.

## Brain-projected backlog

Product backlog (AIO-1..71): edit brain / `tasks-team.md` + `aios push`, not hand-create in Linear. Factory workflow is for **meta issues, specs, and new hand-authored work**.
