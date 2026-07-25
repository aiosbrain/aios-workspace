---
name: skill-author
description: Write or improve a SKILL.md so it actually triggers and actually changes agent behavior. Use when the user says "create a skill", "turn this into a skill", "why isn't this skill triggering", or when compound-learnings decides a lesson deserves a skill.
source: Jesse Vincent (obra) — Superpowers skill-writing skill + pressure-testing; Anthropic skill-authoring guidance
am_pattern: C1
triggers:
  - write a skill
  - create a skill
  - new skill
  - skill.md
  - improve this skill
  - skill isn't triggering
---

You are authoring a skill — a packaged procedure an agent loads when a task matches.
A skill earns its place only if it (a) triggers at the right moment and (b) changes
what the agent would otherwise do. Most bad skills fail one of these.

## Anatomy

```
skills/<kebab-name>/SKILL.md     # required
skills/<kebab-name>/<helper>     # optional scripts/templates the skill references
```

Frontmatter: `name` (kebab, matches dir), `description` (the trigger — see below), and
in this pack also `source:` (provenance) and `am_pattern:` (maturity pattern tags).

## The description is the trigger — write it first

The runtime matches tasks against the *description*, not the body. Include:
- **when** to use it (task shapes, not vague topics), and when NOT to
- the **literal phrases** a user would say ("review this diff", "clean up branches")
- any hard sequencing ("use BEFORE writing code", "run AFTER tests pass")

Weak: `Helps with database work.`
Strong: `Guides schema migrations — use whenever adding/renaming a column or table.
Never edits migration files directly; generates them via the migration tool.`

## The body — instructions to a capable colleague

- Imperative voice, numbered steps for procedures, real commands with real paths.
- State the **hard rules** ("never X", "always Y before Z") separately and bluntly —
  buried rules don't survive contact with a busy agent.
- Include an output format if the skill produces a report.
- Keep it under ~100 lines. If it needs more, split the overflow into referenced helper
  files the agent reads on demand (progressive disclosure).
- Don't restate what the agent already knows (general engineering practice); encode
  only the delta — the decisions, order, and prohibitions specific to this procedure.

## Pressure-test before trusting (the obra step)

Run the draft against 2–3 realistic scenarios with a *fresh* agent (subagent or new
session), including one **decision-conflict** case where the easy path violates the
skill ("the test is failing and the deadline is now — does the agent still refuse to
skip it?"). If the agent ignores or misreads the skill, the fix is usually the
description (didn't trigger) or the hard-rules section (didn't bite) — not more prose.

## Maintenance

A skill that misfires twice gets rewritten or deleted. Skills are code: version them,
review changes to them, and prune ruthlessly — a stale skill is worse than none.
