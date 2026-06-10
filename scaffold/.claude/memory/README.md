---
access: team
---
# Memory — cross-session learning

This folder is how the repo's agents get better over time instead of re-deriving
(or re-committing) the same mistakes. It is tiered `access: team` so it syncs to
the Team Brain — the whole team's harness learning compounds, not just yours.

```
memory/
├── instincts.md     distilled, general rules — CONSULT BEFORE RUNNING HARNESSES
└── incidents/       one file per failure — the raw material rules distill from
```

## The progression (follow it in order; don't skip to "distill")

1. **Fail.** A harness misses its rubric after budget exhaustion, a verifier
   catches a recurring class of error, or the user corrects agent output.
2. **Investigate.** Write `incidents/YYYY-MM-DD-<slug>.md`: what happened, what
   the output said, what the truth was, and the suspected root cause.
3. **Verify.** Before moving on, confirm the root cause — re-run the failing
   step, check the source file, test the alternative. Record HOW it was
   confirmed in the incident file. An unverified guess stays a guess.
4. **Distill.** When a pattern has **two or more verified incidents**, append a
   one-line general rule to `instincts.md` with `derived-from:` links to its
   incidents. One incident is an anecdote; two are a rule candidate.
5. **Consult.** Sessions read `instincts.md` before running any harness (the
   repo CLAUDE.md says so); rubric verifiers receive it as supplementary
   criteria. Reading the rule replaces re-deriving it.

## Incident file format

```markdown
---
status: investigating | verified | distilled
date: YYYY-MM-DD
harness: <name or "session">
---
# <slug>

**What happened:** …
**Expected:** …
**Root cause:** …
**How verified:** …          ← required before status: verified
**Distilled into:** <rule id in instincts.md, once it is>
```

OGR05 (`validation/check-rubrics.sh`) checks that every instinct links at least
one incident file that exists — rules without evidence don't accumulate.
