# ARCH1 — Sync contract + docs drift check

Parent: Pre-release architecture epic.

## Why

`docs/brain-api.md` is the contract the push/pull sync path reads. When that file drifts from the
brain checkout it references, push/pull can silently transport the wrong shape. This task detects
drift **and records the result** so a release is never cut on an unverified sync contract. It is a
detection-and-report task, not a remediation task — fixing drift (a `brain-api.md` bump) is a
separate, out-of-scope change.

## What

- Run `npm run check:docs` (wraps `scripts/check-docs-drift.mjs`) on aios-workspace.
- Extract the **version line** from `docs/brain-api.md` and record it, together with the drift-check
  result, in the review doc.

### Version line — definition

The **version line** is the single line in `docs/brain-api.md` matching the regex `^version:\s*\S`
(the leading `version:` field). Extraction is deterministic:

```
grep -m1 -E '^version:\s*\S' docs/brain-api.md
```

- If exactly one match: record that line **verbatim** (whole line, including the `version:` prefix).
- If zero matches: record the literal token `VERSION-LINE-ABSENT`.

This removes ambiguity: two builders running the same command record byte-identical strings.

## Acceptance criteria

The task succeeds whether or not drift exists. Success = the result is **recorded**, not that the
check passes.

1. `npm run check:docs` has been run and its **exit code captured** into the review doc as
   `check:docs exit: <N>`.
2. The **version line** (per the definition above) is recorded in the review doc on a line of the
   form `brain-api version line: <verbatim line | VERSION-LINE-ABSENT>`.
3. Drift branch is handled explicitly and observably:
   - **exit 0 (no drift):** review doc contains `drift: none`.
   - **exit nonzero (drift detected):** review doc contains `drift: DETECTED` plus the captured
     stderr/stdout of the check under a `#### drift output` sub-heading, and a line
     `escalation: operator — brain-api bump required (out of scope for ARCH1)`. The builder does
     **not** attempt the bump and does **not** fail the task; recording the escalation *is* the
     deliverable for this branch.
4. `npm run aios -- spec eval docs/pre-ship/arch1-sync-contract-drift.md` exits **0**.

## Must-path resolution (drift present)

A cold-start builder that hits a nonzero `check:docs` exit follows criterion 3's nonzero branch:
record `drift: DETECTED`, capture the check output, write the operator-escalation line, and mark the
task complete. Do not fail the task, do not file the brain-api bump. There is no undefined outcome on
the acceptance path — the nonzero exit is an expected, handled state.

## Builder vs operator closure

- **Builder delivers:** the review doc section containing the captured exit code, the version line,
  the drift branch (`none` or `DETECTED` + output + escalation line).
- **Operator verifies:** when a brain checkout is present, confirms the recorded version line matches
  that checkout; if `drift: DETECTED` was escalated, schedules the brain-api bump (separate task).

## Integration points (existing files)

- `docs/brain-api.md` — read-only source of the version line.
- `scripts/check-docs-drift.mjs` — invoked via `npm run check:docs`; not modified.

## New files to create

- `docs/pre-ship/architecture-review-YYYY-MM-DD.md` — the review doc. Parent dir `docs/pre-ship/`
  exists; `YYYY-MM-DD` is replaced with the run date. This file is created by this task.

## Deps

Deps: none.

## Scope

**In scope:** run `check:docs`, extract and record the version line, record the drift result and
(if drifted) the operator escalation, into the new review doc.

**Out of scope / deferred:** any edit to `docs/brain-api.md` (the brain-api bump), any change to
`scripts/check-docs-drift.mjs`, and any push/pull sync-code change. Remediation of detected drift is
deferred to a separate operator-owned task.

## Build-with

Build-with: sonnet / low.

## Tier-safety

This task touches a sync/brain contract surface (`docs/brain-api.md`, the push/pull contract).
Posture: **admin-tier, read-only, default-deny.** The task only *reads* `brain-api.md` and *reads*
the drift-check output; it writes solely to the new review doc under `docs/pre-ship/`. No mutation of
any sync/brain surface, no team/external-tier exposure, and no bump is permitted from this task — the
only mutation path (brain-api bump) is explicitly denied and routed to operator escalation.

## Testability

Every deliverable is demonstrable by a named, re-runnable check against the review doc
(`REVIEW=docs/pre-ship/architecture-review-YYYY-MM-DD.md`):

- **Exit code recorded:** `grep -qE '^check:docs exit: [0-9]+' "$REVIEW"`.
- **Version line recorded:** `grep -qE '^brain-api version line: (version:.*|VERSION-LINE-ABSENT)$' "$REVIEW"`.
- **Drift branch recorded (one of):**
  - no-drift: `grep -qx 'drift: none' "$REVIEW"`, **or**
  - drift: `grep -qx 'drift: DETECTED' "$REVIEW" && grep -q '#### drift output' "$REVIEW" && grep -q '^escalation: operator' "$REVIEW"`.
- **Recorded version line matches source (self-verify):**
  `grep -q "brain-api version line: $(grep -m1 -E '^version:\s*\S' docs/brain-api.md)" "$REVIEW"`
  (skip when the source has no version line and `VERSION-LINE-ABSENT` was recorded).
- **Spec conformance:** `npm run aios -- spec eval docs/pre-ship/arch1-sync-contract-drift.md` exits **0**.