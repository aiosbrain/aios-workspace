---
name: transcript-decisions
description: |
  Review meeting transcripts through the canonical aios transcripts CLI and typed
  review engine. Stages grounded decisions and explicit task commitments in an
  owner-local V2 record, reports TD1-TD6 grading, and requires one human approval
  before either local log changes. Use for one transcript or a batch.
version: 2.0.0
kind: skill
triggers:
  - review meeting transcripts
  - extract decisions and tasks from transcripts
  - process meeting transcripts
  - decisions and commitments from the meeting
  - catch up decision and task logs
  - transcript review queue
---

# transcript-decisions

Use the typed transcript review engine through `aios transcripts`. It extracts both
genuine decisions and explicit task commitments, grades the whole batch, and stages the
result for one owner approval. The CLI and typed engine are the only canonical execution
path.

Do not invoke a Workflow tool, execute or adapt `transcript-decisions.workflow.js`,
synthesize Markdown rows directly, or write either log as a substitute for approval. The
old workflow template is a retired, non-executable notice retained only so an update does
not silently delete a managed file from existing workspaces.

## Run the review

Drafting is always an explicit operator action:

```bash
aios transcripts draft --transcripts 1-inbox/transcripts/meeting-a.md,1-inbox/transcripts/meeting-b.md
aios transcripts list
aios transcripts approve .aios/staging/transcript-decisions/<stage>.json
```

Use these recovery paths when needed:

```bash
aios transcripts approve .aios/staging/transcript-decisions/<stage>.json --no-push
aios transcripts approve .aios/staging/transcript-decisions/<approved-failed-push-stage>.json
```

`draft` accepts repository-contained transcript paths. The engine reads both live logs,
extracts decisions and tasks, grades and corrects them within the configured budget, and
writes a collision-safe V2 JSON stage under `.aios/staging/transcript-decisions/` only when
there is a review record to preserve. A TD6-certified empty result is `no_changes` and
creates no stage.

Inspect the stage before approval. Its `reviewDigest` binds the transcripts, proposals,
and complete grade evidence; a hand-edited payload is not eligible for apply. Correct the
source/input and draft again when the proposed decisions or tasks need substantive changes.
When `approve` receives a V1 stage, it digest-checks the unchanged V1 bytes, regrades both
proposal kinds, and creates a separate V2 result. It applies that V2 result in the same
command only when the rubric passes; it never applies or overwrites the V1 record.

## V2 review states

Every persisted V2 stage retains decisions, tasks, ordered transcript digests, rubric
budget and loop history, a complete TD1-TD6 report, diagnostics, and independent push
state.

| Status | Meaning | Eligible action |
|---|---|---|
| `pending_review` | Every must-pass criterion passes; TD5 findings may remain. | Human may inspect and run `approve`. |
| `failed_rubric` | One or more must-pass criteria still fail after correction budget exhaustion. | Inspect; create a new draft. Never apply. |
| `grading_error` | Extraction or grading failed or returned an invalid result. | Inspect sanitized diagnostics; retry with a new draft. Never apply. |
| `approved` | Both local logs succeeded or were confirmed no-ops under the apply lock. | If its push failed, rerun `approve` on this stage to retry push without reapplying. |

The separate push state is `not_requested`, `skipped`, `pending`, `failed`, or `succeeded`.
It never changes the review status.

## What the gate proves

- TD1-TD4 must pass for every decision and every task: grounded quote, genuine
  decision/explicit commitment, substantive novelty, and typed lossless rendering to the
  matching destination header.
- TD5 is advisory: decision attribution or task assignee should be a named transcript
  participant, but a finding is preserved rather than blocking review.
- TD6 must pass transcript-wide. It checks the full text of every supplied transcript and
  accounts for every genuine decision and explicit task commitment, including a certified
  empty result.

`pending_review` therefore means the complete batch passed the must-pass criteria, not
that a candidate-only sample looked plausible.

## Approval and push outcomes

Approval is the one human write gate. The deterministic, synchronous apply step appends
novel decision rows to `3-log/decision-log.md` and novel task rows to
`3-log/tasks-team.md` under one repository lock. It is retry-safe and accepts only a valid,
digest-bound V2 `pending_review` stage.

By default the CLI attempts the existing `aios push` path only after local approval is
durable. `--no-push` records an explicit skip. A push failure does not roll back or repeat
the local apply; the stage remains `approved`, and rerunning `approve` on that approved
failed-push stage retries only the sync outcome. Stage JSON, transcript text, grade reports,
and diagnostics are never push inputs.

Exit `0` means `pending_review`, certified `no_changes`, `approved`, or a deliberate
`--no-push` outcome. Exit `1` is an operational, grading, or push failure. Exit `2` is
`failed_rubric`, invalid input, or a non-approvable status. After a push failure, local
approval is already durable; rerun `approve` on that approved stage.

## Privacy and cadence boundary

Transcript stages are owner-local `access: "admin"` JSON files created and maintained with
mode `0600`. They never enter shareable daily manifests, Changed signals, withheld counts,
or Team Brain payloads. The owner daily view may report exactly six local queue counts:
`pendingStages`, `decisions`, `tasks`, `failedRubric`, `gradingErrors`, and
`unreadableStages`. Team and external views omit transcript review entirely.

Automatic, scheduled, connector-triggered, and daily-triggered drafting are explicitly
deferred. A scheduler or daily orientation must never invoke `draft`, grade proposals,
approve a stage, or push content.
