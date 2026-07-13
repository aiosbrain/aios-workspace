---
name: transcript-decisions
description: |
  Extract decisions from meeting transcripts into decision-log rows. Runs a dynamic
  multi-agent workflow: fan-out extraction (one agent per transcript), dedup against
  the existing decision log, an adversarial grounding pass, then synthesis into
  log-ready rows. Use when processing a batch of transcripts or catching a decision
  log up after several meetings.
version: 1.1.0
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

A durable CLI pipeline is available in every scaffolded workspace:

```bash
aios transcripts enable-sync
aios transcripts draft --transcripts 1-inbox/transcripts/meeting-a.md,1-inbox/transcripts/meeting-b.md
aios transcripts list
aios transcripts approve .aios/staging/transcript-decisions/<run>.json
```

`draft` writes grounded, deduplicated decision rows and task proposals to a durable local
admin-tier staging file. Edit or reject items there, then `approve` is the **one human gate**:
it appends approved rows to `3-log/decision-log.md` and `3-log/tasks-team.md`, then runs
`aios push`. Use `--no-push` only when deliberately staging the sync for later.

The legacy workflow template remains for runtimes that provide a Workflow tool, but the CLI is
the portable entrypoint for Claude Code, Codex, cron, and ordinary shells.

Returns `{ candidates, novel, verified, decisions, rows_markdown }`.

## Design notes
- **One extractor per transcript** → clean context per source; scales to batches.
- **Dedup** against the live log so already-recorded decisions don't reappear.
- **Batched adversarial grounding** — one verifier judges all candidates (quotes
  passed inline), dropping anything not actually decided in the transcript.
- **Read-once / small outputs / read-only**, per the shared skills conventions.
