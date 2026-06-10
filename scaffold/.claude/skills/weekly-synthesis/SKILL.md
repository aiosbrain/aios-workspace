---
name: weekly-synthesis
description: |
  Produce a weekly team digest (decisions, scope moves, task deltas, risks) with
  a rubric-gated self-correction loop: an independent verifier grades the draft
  against .claude/rubrics/weekly-synthesis.md and the harness revises until the
  rubric passes or its budget is spent. Use at sprint boundaries or when someone
  asks "what happened this week?".
version: 1.0.0
kind: workflow-harness
workflow: weekly-synthesis.workflow.js
triggers:
  - weekly synthesis
  - weekly digest
  - what happened this week
  - sprint summary
  - synthesize the week
---

# weekly-synthesis

The flagship **self-correction loop** harness (skills conventions #11–13):
Collect → Draft → **Grade** (independent verifier, fresh context, grades against
the rubric using the Read tool on sources) → **Correct** (revise only the failing
criteria) → loop until pass or budget exhausted.

## Before running

Read `.claude/memory/instincts.md` (the harness passes distilled rules to both
the drafter and the grader). If the run **fails its rubric after budget
exhaustion**, record an incident in `.claude/memory/incidents/` per
`.claude/memory/README.md` — that is how failures become rules.

## How to run

```
Workflow({
  scriptPath: ".claude/skills/weekly-synthesis/weekly-synthesis.workflow.js",
  args: {
    repoPath: "<absolute path to this team-ops repo>",
    windowStart: "2026-06-03",        // optional; default: 7 days ending windowEnd
    windowEnd: "2026-06-10",
    rubricPath: ".claude/rubrics/weekly-synthesis.md",  // optional; default
    budget: 3                          // optional; default from rubric frontmatter
  }
})
```

Returns `{ passed, loops_used, budget, grade_report, digest_markdown }`.

**A failed gate is a result, not an exception** — the digest and its grade
report are returned either way. Review the grade report before publishing a
digest that didn't pass; never silently drop the report.

## Design notes
- **Independent grading** — the verifier gets the rubric, the candidate, and
  source paths; never the drafter's reasoning. Self-critique inside one context
  is what this design exists to avoid.
- **Correct, don't regenerate** — revision preserves passing content; a full
  regenerate can trade one failure for new ones.
- **Read-once** — sources are read in Collect and passed as excerpts; the
  grader re-reads only what grounding checks require.
