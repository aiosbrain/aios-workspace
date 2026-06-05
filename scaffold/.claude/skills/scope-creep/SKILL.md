---
name: scope-creep
description: |
  Detect scope creep across an engagement's deliverables. Runs a dynamic
  multi-agent workflow: classify each deliverable against the scope baseline/ledger,
  then an adversarial reviewer re-grades each flag to the lowest defensible severity
  (removing false accusations against contracted work while keeping genuine
  out-of-scope items). Use before a sprint review, an invoice, a change-order
  discussion, or a client scope conversation.
version: 1.0.0
kind: workflow-harness
workflow: scope-creep.workflow.js
triggers:
  - check for scope creep
  - scope creep audit
  - are we in scope
  - deliverables vs scope
  - scope drift
  - what's out of scope
---

# scope-creep

A dynamic-workflow harness that compares delivered work against the scope
baseline/ledger and produces a **scope-creep register** of out-of-scope and watch
items — each one survived an adversarial re-grade, so the register is calibrated
against the costly error: **falsely accusing contracted work**.

## When to use it

Before any moment where scope is on the line — sprint review, invoice prep,
change-order drafting, or a client "is this in scope?" conversation. For a quick
gut-check on a single deliverable, read it against the baseline yourself.

## How to run

This is a **template**, not a fixed script. Read `scope-creep.workflow.js`, adjust
paths/severity bar to the engagement if needed, then invoke the **Workflow tool**:

```
Workflow({
  scriptPath: ".claude/skills/scope-creep/scope-creep.workflow.js",
  args: {
    repoPath: "<absolute path to this team-ops repo>",
    scopeBaseline: "00-engagement/scope-baseline.md",   // defaults shown
    scopeLedger: "00-engagement/scope-ledger.md",
    deliverablesGlob: "02-deliverables/sprint-1",        // a sprint dir
    runDate: "YYYY-MM-DD"
  }
})
```

> **Gotcha:** the Workflow tool passes `args` as a JSON *string*. The script already
> calls `JSON.parse(args)`. It is **read-only** against the repo; the calling session
> writes the register.

Returns `{ total_deliverables, out_of_scope, watch, downgraded_to_in_scope, flags, register_markdown }`.

## Design notes
- **Severity-downgrade refuter, not keep/drop.** A binary keep/drop refuter cuts false
  accusations but also discards genuine out-of-scope items (recall loss). This harness
  re-grades each flag to the **lowest defensible severity** (out-of-scope → watch →
  in-scope): a false accusation falls to in-scope and drops off the register, while a
  true out-of-scope item stays on it. Precision *and* recall.
- **One classifier per deliverable** → every deliverable is examined, not sampled.
- **Batched refute** — one reviewer re-grades all flags together (agent count is the
  dominant cost driver).
- **Keep structured outputs small** — classifiers read the (small) scope docs directly
  rather than relying on a single agent emitting a large digest, which can stall.

## Interpreting results (and a known limitation)
The register has three bands: **out-of-scope** (net-new work, no coverage — the
actionable signal), **watch** (covered-but-expanded or forward-looking — review), and
cleared **in-scope**. Where the scope baseline lacks an explicit line for a borderline
deliverable, the grade can oscillate between `watch` and `out-of-scope` across runs.
That is **genuine scope ambiguity, not a harness defect** — it is surfacing a
deliverable the scope docs don't clearly adjudicate, which is exactly what a human
should decide. The durable fix is a more granular scope baseline, not prompt-tuning.
