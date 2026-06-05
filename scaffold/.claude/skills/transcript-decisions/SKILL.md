---
name: transcript-decisions
description: |
  Extract decisions from meeting transcripts into decision-log rows. Runs a dynamic
  multi-agent workflow: fan-out extraction (one agent per transcript), dedup against
  the existing decision log, an adversarial grounding pass, then synthesis into
  log-ready rows. Use when processing a batch of transcripts or catching a decision
  log up after several meetings.
version: 1.0.0
kind: workflow-harness
workflow: transcript-decisions.workflow.js
triggers:
  - extract decisions from transcripts
  - process meeting transcripts
  - decisions from the meeting
  - catch up the decision log
  - transcript to decisions
---

# transcript-decisions

Turns meeting transcripts into **novel, grounded** decision-log rows — deduped
against what's already logged and adversarially checked for grounding.

## When to use it (volume gate)

| Use the harness when | Use a single-pass read when |
|----------------------|-----------------------------|
| A **batch** of transcripts to process | One short transcript |
| A large existing log where duplicate rows are a real risk | A quick capture |

On a single short transcript a one-pass read extracts just as completely — the
harness's value is automatic **dedup** + per-decision **grounding**, not raw recall.
See `docs/workflows.md`.

## How to run

A **template** — read `transcript-decisions.workflow.js`, then invoke the **Workflow tool**:

```
Workflow({
  scriptPath: ".claude/skills/transcript-decisions/transcript-decisions.workflow.js",
  args: {
    repoPath: "<absolute path to this team-ops repo>",
    transcriptPaths: ["01-intake/transcripts/2026-03-13-sprint-planning.md", "..."],
    decisionLog: "03-status/decision-log.md",   // optional; default
    runDate: "YYYY-MM-DD"
  }
})
```

> **Gotcha:** `args` arrives as a JSON *string*; the script calls `JSON.parse(args)`.
> Read-only — it returns rows; you review and append them to the log.

Returns `{ candidates, novel, verified, decisions, rows_markdown }`.

## Design notes
- **One extractor per transcript** → clean context per source; scales to batches.
- **Dedup** against the live log so already-recorded decisions don't reappear.
- **Batched adversarial grounding** — one verifier judges all candidates (quotes
  passed inline), dropping anything not actually decided in the transcript.
- **Read-once / small outputs / read-only**, per the shared skills conventions.
