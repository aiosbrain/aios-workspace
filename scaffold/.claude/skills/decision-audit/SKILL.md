---
name: decision-audit
description: |
  Governance audit of an engagement decision log. Runs a dynamic multi-agent
  workflow: one verifier per rule (structurally-earned coverage of every entry)
  followed by an adversarial verification pass that removes false positives.
  Use when asked to audit / QA / lint the decision log, check governance hygiene,
  or before a sprint close-out or client handover.
version: 1.0.0
kind: workflow-harness
workflow: decision-audit.workflow.js
triggers:
  - audit the decision log
  - decision log hygiene
  - check the decision log
  - governance audit
  - lint decisions
  - decision-log QA
---

# decision-audit

A dynamic-workflow harness that audits a decision log against a set of governance
rules and returns only **adversarially-verified** findings — not a raw pass that
dumps unverified flags.

## When to use it

| Use the harness when | Use a quick single-pass read when |
|----------------------|-----------------------------------|
| The log is large (dozens+ of entries) | The log has only a handful of entries |
| Before a sprint close-out / client handover | A casual spot-check |
| You need trustworthy, low-false-positive findings | You just want a rough scan |

In testing, a single-pass audit produced many findings of which the large majority
were false positives; the harness's adversarial pass cut that to a small set of
verified, actionable items. See `docs/workflows.md`.

## How to run

This is a **template**, not a fixed script. Read `decision-audit.workflow.js`,
adjust `RULES`/paths/`rounds` to the engagement if needed, then invoke the
**Workflow tool**:

```
Workflow({
  scriptPath: ".claude/skills/decision-audit/decision-audit.workflow.js",
  args: {
    repoPath: "<absolute path to this team-ops repo>",
    decisionLog: "03-status/decision-log.md",        // optional; this is the default
    clientSurfaceLog: "03-status/client-surface-log.md",
    runDate: "YYYY-MM-DD",                            // for the stale-decision rule
    rounds: 1                                          // loop-until-dry cap; raise for very large logs
  }
})
```

> **Gotcha:** the Workflow tool passes `args` as a JSON *string*. The script already
> calls `JSON.parse(args)` — keep that if you fork it.

Returns `{ total_entries, coverage, confirmed, rejected, findings, report_markdown }`.
The workflow is **read-only** against the log; the calling session writes the report
wherever the engagement keeps audit output.

## Design notes
- **One finder per rule** → coverage of every entry is *structurally earned*, not
  self-asserted.
- **Adversarial verification** is the value-add — it removes the false-positive noise
  a raw pass emits. See `../README.md` for the shared conventions.
- **Read once:** finders return each offending row's `entry_excerpt`; verifiers receive
  it inline and do not re-read the file.
- **Batch verify by rule:** one verifier judges all of a rule's candidates. Agent
  *count* is the dominant cost driver — batching keeps a large-log run affordable.

## Tuning levers
| Lever | Effect |
|-------|--------|
| `rounds` (default 1) | loop-until-dry; raise only for very large logs |
| verify batch granularity | per-rule (default) = cheaper, more conservative; per-finding = higher recall, more agents |
| `ruleSet` | swap/extend the governance rules per engagement |
