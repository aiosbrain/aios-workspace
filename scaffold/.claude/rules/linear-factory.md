---
access: team
type: rule
summary: Agentic Linear factory — triage, pick-up-able specs, workstream batches, closeout
---

# Linear factory operations

**Applies only when this workspace's `aios.yaml` sets `pm_tool: linear`.** If it says
`clickup` or `none`, ignore this rule — `aios update` will remove it on the next sync (unless
you have edited it, in which case it warns and leaves it for you to delete).

Companion to the `aios-linear` and `workstream-update` skills. Linear issue bodies are **agent contracts** graded by `aios spec eval`.

`aios spec eval` runs out of the separate `aios-devtools` checkout (`--devtools-dir` →
`AIOS_DEVTOOLS_DIR` → the `@aiosbrain/aios-devtools` package). If none resolves, the command
cannot run — say so and stop. An unrunnable grader is **not** a passing grade, and it is not a
failing one either.

## Triage inbox

- Capture raw work (screenshot, one-liner) into **Triage** — do not interrupt active agent batches.
- `linear.mjs create "<title>" --template aios --state Triage`
- Intake: fill all template sections → `aios spec eval` → `set-state Backlog` when `SPEC_READY`.
- **Post-merge findings** (consolidate-findings output, `code-review-<slug>.md` artifacts) use
  the finding shape instead: `create "<title>" --template finding` with the classification
  labels applied at file time — `--label finding` plus one each of `repo:` / `defect:` /
  `sev:` / `det:` / `fence:` (vocabulary + queries: aios monorepo `docs/finding-taxonomy.md`).
  A finding filed without its dimensions surfaces in the needs-triage view, not plain Backlog.

## Pick-up-able spec shape

Use `docs/agentic-ergonomics/aios-issue-template.md` (or `aios spec init`). The **Template mapping** table in `.claude/rubrics/spec-readiness.md` is what maps each section to the criteria it satisfies — read it there rather than trusting a criterion range quoted here, which goes stale every time the rubric grows.

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
