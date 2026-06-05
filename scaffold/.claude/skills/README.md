# Team-Ops Skills — Dynamic-Workflow Harnesses

Project-agnostic skills deployed into every team-ops repo. Skills here must be
**generic** — no client names, no engagement-specific paths. Everything
engagement-specific arrives through the workflow's `args`.

## What lives here

| Skill | Kind | Notes |
|-------|------|-------|
| `decision-audit/` | workflow-harness | Per-rule fan-out + adversarial verify over the decision log |
| `scope-creep/` | workflow-harness | Per-deliverable classify + **severity-downgrade** refuter |

More harnesses are on the roadmap (see the repo issues): transcript → decisions,
weekly synthesis, ticket-hygiene.

## Harness conventions (the design rules)

These come out of a controlled study comparing single-pass skills against
multi-agent harnesses (`docs/workflows.md`). Follow them when adding a harness.

1. **Adversarial verification is the value, not fan-out.** A successful harness wins
   because an *independent* agent grounds/refutes the producing agent's claims. A
   fan-out with no verification can amplify one agent's hallucination and do *worse*
   than a single pass. Any harness that emits findings or claims needs a
   `verify(claim, evidence) → {real, reason, severity}` stage.
2. **Prefer "re-grade severity" over binary keep/drop** in refuters. Keep/drop trades
   recall for precision; re-grading preserves both.
3. **Read shared context once; pass it inline.** Don't let every sub-agent re-read the
   same large file — that is the dominant cost. Have the first reader return the
   relevant excerpt and pass it inline downstream.
4. **Earn coverage structurally.** One agent per rule / per item beats one agent told
   "check everything," which tends to sample and assert completeness.
5. **Batch by rule/group to control agent count.** Agent *count* × per-agent context
   overhead is the cost driver, not file size.
6. **Keep each agent's structured output small.** A single agent asked to emit a large
   digest can stall; split it or read source directly.
7. **Gate by input size.** For small inputs a single-pass skill is cheaper *and* at
   least as good. Only engage the harness above a size/volume threshold.
8. **Synthesis needs a fidelity gate.** Completeness ≠ correctness. Any harness that
   *summarizes* must verify material claims against their source before shipping.
9. **`args` arrives as a JSON string** from the Workflow tool — always `JSON.parse(args)`.
10. **Be read-only.** Harnesses analyze and return data; the calling session writes output.

## Skill folder layout

```
<skill-name>/
├── SKILL.md                      # frontmatter: kind: workflow-harness, workflow: <file>
└── <skill-name>.workflow.js      # the harness (a TEMPLATE — tune per engagement)
```

Treat the `.js` as a template, not a script to run verbatim: read it, adapt
`RULES`/paths/thresholds to the engagement, then run.
