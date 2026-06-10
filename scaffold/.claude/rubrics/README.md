# Rubrics — checkable criteria for self-correction loops

A rubric turns "is this output good?" into criteria an **independent verifier
sub-agent** can check one by one. Harnesses that synthesize (skills convention
#11–12) load their rubric, grade the candidate output in a fresh context, revise
on must-fails, and loop until the rubric passes or the budget is spent.

## Format (validated by OGR05, `validation/check-rubrics.sh`)

```markdown
---
kind: rubric
applies_to: <harness-name>
budget: 3                  # max grade→correct loops
pass: no-must-fails        # all Must=yes criteria pass; others are advisory
---
| ID  | Criterion                                  | Check method   | Must |
|-----|--------------------------------------------|----------------|------|
| X1  | …                                          | grounding-read | yes  |
```

**Check methods** (how the verifier should test the criterion):

- `grounding-read` — open the named source files and confirm the claim/quote exists.
- `tier-scan` — scan the output for content above the allowed access tier.
- `count-vs-index` — count items in the output vs. items in the source index/log.
- `deterministic` — mechanically checkable (length, format, required sections).

## Rules

- Criterion IDs are unique within a rubric.
- `Must: yes` failures block the gate; `Must: no` failures are reported but don't.
- Keep rubrics short (≤ ~8 criteria) — every criterion costs verifier attention.
- Rubrics are tuned per repo, like the harnesses themselves: a template, not law.
- The verifier also receives `.claude/memory/instincts.md` as supplementary
  criteria (skills convention #13).
