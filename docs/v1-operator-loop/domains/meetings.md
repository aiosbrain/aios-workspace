# Domain spec — Meetings (Granola ingestion, decisions, stakeholder map)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
Meetings are where decisions get made and where "who owns what" lives. The weekly closeout (C5) must catch unlogged decisions and surface a stakeholder picture; the loop relies on meeting-derived decisions as first-class signals.

## Reuse (shipped, KEEP)
- Granola source connector (sibling **aios-team-brain** repo: ingestion/aios_ingest/sources/granola.py, 319 LOC) — OAuth, auto transcript pull, webhook/scheduler triggers (brain PR #34).
- `transcript-decisions` harness — multi-agent extraction → decision-log rows with rubric-gated grounding.
- `granola-digest` skill (per-meeting + daily digest).
- Stakeholder map CLI + MCP surface (AIO-141). Its shipped contract remains below as historical
  domain documentation; it is not part of the active AIO-370 increment.

## Build (net-new clean TS)
- **Transcript review pipeline (AIO-370)**: replace the untyped proof of concept with a typed,
  rubric-gated V2 engine that stages decisions and tasks for one human approval, applies both logs
  safely, and keeps sync outcome separate from local approval. This is the approved slice specified
  below and is one reviewable PR.
- **Governance-nudge harness**: flag transcripts touching governance/compliance topics and draft a brief — rebuild the prior-build nudge *concept* clean (keyword/topic detection → drafted brief), not the legacy code. *(Separate build item; its own future issue.)*
- Normalize meeting decisions into tier-tagged signals for C1. *(Separate build item; its own future issue.)*

### Transcript review pipeline (AIO-370)

#### What / why

Connector ingress can place raw meeting transcripts in the workspace, but extraction is not trusted
enough to write the decision and task logs directly. AIO-370 provides a durable, owner-reviewable
boundary: extract both decisions and explicit task commitments, grade the whole batch, persist the
review evidence, and require one local approval before touching either log. Local approval and a
subsequent `aios push` are distinct outcomes so a network failure cannot make a completed local
write look unapplied or cause it to be applied twice.

This increment replaces the implementation behind the existing `aios transcripts` surface. The
current `scripts/transcripts.mjs` is an untyped proof of concept and becomes a thin CLI adapter; it
is not a workflow-layer implementation to port verbatim. The existing
`scaffold/.claude/rubrics/transcript-decisions.md` supplies the TD1–TD5 policy baseline. The builder
generalizes that policy to decisions **and** tasks and adds TD6 as described below.

#### Scope and increment boundary

**In scope, one PR:**

- Create the typed engine under new `src/operator-loop/meetings/` modules with one public barrel,
  `src/operator-loop/meetings/index.ts`. The public surface owns V2 stage types, draft/grade,
  V1 approval-time regrading/upgrade, synchronous apply, stage listing, push-state bookkeeping, and
  the read-only daily count summary. Internal extraction, grading, persistence, and apply helpers
  remain private to the domain.
- Keep `cmdTranscripts` in existing `scripts/transcripts.mjs` as the thin adapter for `draft`,
  `list`, and `approve`; existing `scripts/aios.mjs` remains the command router and help surface.
- Attach a local owner-only optional transcript-review field to the existing
  `DailyOrientation` in `src/operator-loop/daily.ts`, through the meetings engine's narrow summary
  function. C4 is an Operator Loop composition point; the meetings engine does not import or call
  any sibling domain.
- Update the existing transcript-decision rubric policy and add focused unit/CLI tests. This slice
  may replace the existing proof-of-concept tests, but it does not preserve the V1 implementation
  as a second execution path.

The evaluation and implementation target of this active increment is **AIO-370 only**. The shipped
AIO-141 reference later in this domain document is neither a second public surface nor a deliverable
of this PR.

**Explicitly deferred / out of scope:**

- Automatic, scheduled, connector-triggered, or daily-triggered drafting. AIO-370 is manually
  invoked; the daily command may report counts but never starts extraction or grading.
- A stakeholder store, attendee-to-stakeholder mutation, or stakeholder review flow. The AIO-141
  read-only stakeholder query surface below remains a separate concern.
- Any GUI view or GUI approval action.
- Any Team Brain endpoint, payload, schema, or `docs/brain-api.md` change.
- Emitting a meeting signal into C1, classifying transcript review as Changed, or normalizing
  approved rows into the shareable manifest. Those remain separate build items.

**Build with:** opus / high. The slice combines a model-graded state machine with two-file local
write safety and deserves high-effort implementation and adversarial review.

**Dependencies:** AIO-366 connector ingress has landed and can provide transcript files, but is not
a runtime prerequisite because `draft` accepts explicit local paths. Existing
`3-log/decision-log.md` and `3-log/tasks-team.md` are the two apply targets. There are no Brain API,
GUI, scheduler, stakeholder-store, or sibling-domain dependencies.

**Traceability:** this subsection is the durable implementation spec for Linear task AIO-370 in the
Meetings domain. Its named acceptance tests below are the definition of done; the deferred bullets
are separate future tasks and must not be absorbed into the AIO-370 plan.

#### Interface-first contracts

The engine exposes these named contracts before implementation steps:

- `TranscriptReviewStageV2`, the persisted discriminated union described below.
- `DraftTranscriptReviewResult`, either `{ outcome: "staged", stagePath, stage }` or the certified
  empty `{ outcome: "no_changes", transcripts, rubricBudget, loops, gradeReport, diagnostics }`.
- `draftTranscriptReview(options) -> Promise<DraftTranscriptReviewResult>` for model-driven
  drafting/regrading, plus the CLI-level V1 approval upgrade described below.
- `applyPendingTranscriptStage(options) -> ApplyResult`, a **synchronous and deterministic**
  low-level operation. It accepts only a persisted V2 `pending_review` stage; V1, failed, errored,
  and approved stages are rejected without touching either log.
- `summarizeTranscriptReview(root) -> TranscriptReviewCounts`, a read-only local projection used
  only by the owner daily wrapper.
- `recordTranscriptPushAttempt(...)` and the CLI orchestration around them; push is never part of
  the low-level apply transaction.

No AIO-370 function emits a C1 signal. The domain-level meeting signal contract later in this
document remains the contract for the separate normalization slice, not this PR.

#### Persisted V2 stage contract

Every created stage is an admin-only JSON record under
`.aios/staging/transcript-decisions/`. `TranscriptReviewStageV2` is discriminated by
`version: 2` and exactly one of these statuses:

| Status | Meaning and allowed next action |
|---|---|
| `pending_review` | All must-pass rubric criteria pass; a human may inspect and invoke `approve`. This is the only status the low-level apply accepts. |
| `failed_rubric` | One or more must-pass criteria still fail after the rubric correction budget. It is inspectable but cannot be applied; run a new draft/regrade. |
| `grading_error` | Extraction/grading could not produce a trustworthy result (provider, timeout, invalid response, or grader execution error). It is inspectable but cannot be applied. |
| `approved` | Both local logs were successfully handled under the repository lock. It retains the full review record and adds immutable apply results. Push may still be skipped, pending, failed, or succeeded independently. |

Every status persists the candidate `decisions`, candidate `tasks`, and ordered `transcripts`
(`path`, SHA-256 digest, and bytes/character count), plus `createdAt`, `access: "admin"`, and a
stable stage id. It also stores a `reviewDigest` over the immutable transcript digests, decisions,
tasks, rubric budget/loops, final report, and diagnostics. Apply recomputes and requires this digest;
a manual payload edit is never treated as previously graded and requires a new draft/regrade.
The apply/push records are excluded from `reviewDigest` so their atomic bookkeeping does not
invalidate the reviewed payload. Every status also persists all of the following review state
rather than only a score:

- `rubricBudget`: the configured maximum number of correction attempts. The initial grade does not
  spend budget; at most `rubricBudget` revisions follow it.
- `loops`: the ordered initial grade and every revision/regrade attempt, including the candidate
  counts and a complete report for that attempt.
- `gradeReport`: the final complete TD1–TD6 report. It contains an overall `pass`, `fail`, or
  `error` verdict and one entry for every criterion with must/advisory classification, outcome,
  findings, affected candidate ids/transcript paths, and evidence. A grading exception does not
  omit criteria: unassessed entries are recorded with `error` outcomes.
- `diagnostics`: structured extraction/grader/provider/parse errors and non-blocking warnings. Raw
  transcripts are not copied into diagnostics.
- `push`: separate state `not_requested | skipped | pending | failed | succeeded`, with ordered
  attempts and sanitized diagnostics. This state never changes the review status.

Stage creation is collision-safe and non-overwriting: create the private directory if needed, use
an exclusive create (`wx`) with a timestamp plus digest/random suffix, retry a bounded number of
name collisions, and fail rather than overwrite. Each stage is created with mode `0600`; every
subsequent stage replacement (approval or push bookkeeping) is an atomic same-directory
temp-file-and-rename and restores mode `0600`.

#### Rubric and correction loop

TD1–TD4 are generalized from decision rows to **every decision and task candidate**:

| ID | Contract | Gate |
|---|---|---|
| TD1 | Each candidate's `sourceQuote` occurs verbatim or near-verbatim in its named transcript. | must pass |
| TD2 | A decision candidate is an actual decision and a task candidate is an explicit commitment; discussion, suggestions, open questions, and inferred work are excluded. | must pass |
| TD3 | The candidate is novel in its own batch and against its matching live log, by substance rather than only exact spelling. | must pass |
| TD4 | The candidate has the required typed fields and losslessly renders to the current header/column order of its matching destination (`decision-log.md` or `tasks-team.md`). | must pass |
| TD5 | Decision attribution / task assignee is a named person present in the transcript. | advisory only; findings persist but never block |
| TD6 | Transcript-wide completeness: across the **full text of every supplied transcript**, every genuine decision and explicit task commitment is either represented by a candidate or identified as substantively present in the matching live log. Candidate-only or quote-only grading is insufficient. | must pass |

The grader receives the full transcripts, both live-log indexes, and both candidate collections.
Before any model call, deterministic preprocessing resolves repository-contained transcript paths,
reads exact bytes, records SHA-256 digests and sizes, validates/parses both destination headers, and
builds typed live-log dedupe indexes. A malformed/escaping path, unreadable input, or invalid header
fails before extraction/grading. Model output is schema-validated before it becomes candidate input
to the rubric loop.
Any TD1–TD4 or TD6 failure enters the bounded correction loop. When must-fails remain after the
configured correction attempts, a `failed_rubric` stage is written and the CLI exits 2. Provider,
timeout, schema, or grader execution failure writes `grading_error` with the complete error-shaped
report and exits 1. TD5 findings survive into `pending_review` but do not consume correction budget.

An empty extraction is not automatically success. `no_changes` is returned only when TD6 passes
over every full transcript and certifies that there are no novel decisions **and** no novel tasks
after comparison with the live logs. A certified `no_changes` response prints/returns its report
but creates **no staging file at all**. An empty result without that certification is
`failed_rubric` or `grading_error`, never `no_changes`.

#### Digest-bound V1 approval upgrade

`aios transcripts approve <v1-stage> [--no-push] [--json]` is the V1 upgrade path. The command reads
the exact V1 bytes and records their SHA-256 digest, parses the V1 record, resolves its named
transcripts inside the repository, and treats **both** its decisions and tasks as untrusted
candidate input to the complete V2 TD1–TD6 grading/correction loop. After grading and immediately
before creating a V2 stage, it re-reads the V1 bytes and requires the same digest. Digest drift is
an integrity exit 2: no V2 stage is created, neither log is written, and push is not invoked.

When the source digest is stable, approval creates a distinct collision-safe `0600` V2 stage that
includes `migration: { sourcePath, sourceDigest, sourceVersion: 1 }` and current transcript digests.
It never mutates, renames, truncates, or overwrites the V1 file or an earlier V2 stage. A passed
regrade produces `pending_review` and the **same `approve` command** immediately invokes the
V2-pending-only low-level apply; there is no second human command. `failed_rubric` exits 2 and
`grading_error` exits 1 after preserving their distinct V2 review stage, but neither outcome writes
either log or invokes push. A certified empty V1 regrade returns `no_changes`, exits 0, creates no V2
stage, writes no log, and does not push.

#### Approval, locking, atomicity, and retry safety

`applyPendingTranscriptStage` performs no model or network call and is synchronous. Before any
write it validates the complete V2 schema/status, `reviewDigest`, and both destination headers,
then acquires one repository-scoped transcript-apply lock under `.aios/locks/`. Lock acquisition is bounded and
never steals an existing lock; a busy/stale lock is an operational exit 1 with no writes and an
actionable diagnostic. All meetings-engine apply paths honor this lock.

While holding the lock, apply re-reads both logs, recomputes substantive dedupe sets, assigns row
numbers from the locked snapshots, and renders both replacements. The retry identity is stable:
decision key = normalized decision substance; task key = normalized task substance plus assignee.
It deduplicates within the stage and against the live log, so a retry after a partial prior attempt
cannot append the already-written rows again.

Each changed log is replaced atomically using a same-directory exclusive temp file, flush/close,
and rename; unchanged logs are left byte-identical. Preflight failures touch neither log. Because
two filesystem renames cannot form one cross-file transaction, a second-log failure may leave the
first replacement visible. In that case the stage remains `pending_review`; a retry observes the
first log through the stable dedupe keys, writes only the missing work, and does not duplicate rows.
The stage becomes `approved` **only after both log operations succeed or are confirmed no-ops**, and
its own status/apply-result replacement is atomic and mode `0600`. A failure to persist `approved`
also remains safely retryable because both logs dedupe under the lock.

#### Push state and CLI exit contract

`aios transcripts approve <v2-stage> [--no-push] [--json]` first invokes the low-level apply. By
default, and only after the stage is locally `approved`, the adapter attempts the existing
repository `aios push` path for the eligible changed logs. `--no-push` is an explicit choice: it
records `push.state: "skipped"` and never invokes push. A push failure never rolls back either log
or the `approved` status; it records a failed attempt and exits 1. Re-running
`aios transcripts approve <approved-v2-stage>` when its push state is `failed` retries only the
existing `aios push` path and never re-applies either log. A successful retry exits 0 and records
`succeeded`; another push failure remains exit 1. Re-running an already approved stage with a
successful or deliberately skipped push is an idempotent exit 0. Stage files, transcripts, grade
reports, and diagnostics are never push inputs.

All transcript subcommands honor this exact process-exit contract (JSON and text modes are the
same):

| Exit | Meaning |
|---|---|
| `0` | Successful state: a `pending_review` stage was created, `no_changes` was certified with no file, a stage was `approved`, listing succeeded, or deliberate `--no-push` was recorded. This also covers successful approve-based push retry. |
| `1` | Operational failure, `grading_error`, or push failure: provider/timeout/response error, ordinary missing/read/write/atomic-write failure, or busy lock. Local approval may already be durable when only push failed; output must report local approval and failed push separately. |
| `2` | `failed_rubric`, invalid stage, or non-approvable/integrity state: unsupported/corrupt stage schema or status, repository-escaping path, review/source digest drift, destination-header mismatch, or any request that cannot safely become/reuse `pending_review`. No ineligible apply or push occurs. |

`draft` always reports the outcome/status and counts; `approve` always reports V1 regrade/V2 stage,
local apply, and push states separately as applicable. No branch prints success text before its
durable state transition has completed.

#### Optional owner-only daily orientation

The owner form of `DailyOrientation` may add this optional local field when there is transcript
review work to report:

`transcriptReview?: { pendingStages, decisions, tasks, failedRubric, gradingErrors, unreadableStages }`

The six counts come directly from local admin staging files. `pendingStages` counts V2
`pending_review` files; `decisions` and `tasks` total their reviewable candidates;
`failedRubric` counts V2 `failed_rubric`; `gradingErrors` counts V2 `grading_error`; and
`unreadableStages` counts files that cannot be safely read/parsed/validated, without exposing their
path or content. Approved stages are not pending work and do not contribute candidates.

This field is attached after ordinary daily manifest classification and is owner-only. It is
**omitted entirely** (not zeroed or aggregated) from `--as team`, `--as external`, and any saved or
supplied shareable manifest. Transcript review is never a C1 signal, never appears in Changed,
never increments `counts.withheld`, and never leaks a stage path/status/diagnostic through a
shareable `DailyOrientation`. The count read is side-effect-free and never drafts, grades,
approves, or pushes.

#### Acceptance (AIO-370 — observable)

- `test/operator-loop/meetings-stage.test.mjs` proves all four V2 discriminants persist decisions,
  tasks, transcript digests, rubric budget/loops, a complete TD1–TD6 report, diagnostics, and
  separate push state; simultaneous same-timestamp drafts create distinct `0600` files and never
  overwrite either file.
- `test/operator-loop/meetings-rubric.test.mjs` proves TD1–TD4 gate decisions and tasks, TD5 remains
  advisory, TD6 fails when a genuine item anywhere in a full transcript is omitted, correction
  attempts are bounded exactly by `rubricBudget`, and grader exceptions produce the complete
  `grading_error` record.
- The rubric test also proves an empty extraction creates no file only when transcript-wide TD6
  certifies `no_changes` with exit 0; a non-certified empty extraction becomes `failed_rubric`
  (exit 2) or `grading_error` (exit 1) and is never reported as success.
- `test/operator-loop/meetings-v1-approve.test.mjs` proves `approve <v1-stage>` leaves the V1 bytes
  unchanged, digest-checks before and after grading, embeds that digest in a distinct `0600` V2
  stage, regrades both decisions and tasks, and applies a passed regrade in the same command. Digest
  drift, rubric failure, and grading error write no logs and invoke no push.
- `test/operator-loop/meetings-apply.test.mjs` proves the low-level apply is synchronous,
  deterministic, and V2-pending-only; concurrent approvals serialize under the repository lock,
  each changed log is atomically replaced, and approved is not persisted until both logs finish.
- The apply test injects failure after the first log replacement, retries the still-pending stage,
  and proves the first log is not duplicated, the second is completed exactly once, and only then
  is status `approved`.
- `test/operator-loop/meetings-cli.test.mjs` executes `draft`, V1/V2 `approve --no-push`, default
  `approve`, and approve-based failed-push retry in text and JSON modes and asserts the exact 0/1/2
  mapping, including an approved-local/failed-push result that exits 1 and never reapplies on retry.
- `test/operator-loop/meetings-daily.test.mjs` proves all six exact owner counts and asserts the literal
  absence of `transcriptReview`, stage data, Changed entries, and withheld-count movement in team
  and external output and in saved/supplied shareable manifests.
- Existing transcript CLI tests continue to pass after their imports move to the typed engine, and
  TypeScript typecheck plus the repository test command pass with no V1 implementation fallback.

### Shipped reference — stakeholder map surface (AIO-141; not AIO-370 scope)

**Status:** shipped historical contract, retained for domain context. Nothing in this subsection is
an implementation task, dependency, or acceptance criterion for the active AIO-370 PR above.

**What / why.** The team-brain holds a structured Company-Graph (actors, roles, org chart, who-owns-what) in Postgres, but a workspace user has no way to query it. Surface it as a queryable, tier-respecting **CLI + MCP** view — the agent-native way every other brain read is exposed — so the loop and the operator can answer "who owns domain X" and "who attended meeting Y" without leaving the workspace.

**Data model consumed (real paths).**
- **People + ownership**: the brain's `graph_entities` / `graph_relationships` tables (actors + `OWNS`/`TOUCHES`/`PRODUCES`/`REPORTS_TO` edges), projected by the additive **team-tier** endpoint `GET /api/v1/company-graph` documented in `docs/brain-api.md` (v1.5). The endpoint does the ownership join server-side (edge → owned workflow's `name` + `job_family`).
- **Attendance**: existing meeting markers already pullable via `GET /api/v1/items` (`kind: artifact`, `frontmatter.meeting: true`, comma-joined `participants`). No new item kind, no new schema.

**Interface-first (contracts named before steps).** The wire contract is `GET /api/v1/company-graph` in `docs/brain-api.md`; the workspace surfaces are `cmdStakeholders` in `scripts/aios.mjs` (`aios stakeholders --owns|--who|--meeting`) and the `brain_stakeholders` tool in `scripts/brain-mcp.mjs`, both built on the shared client in `scripts/brain-client.mjs`.

**Query shapes.** `who owns <domain>` · `who reports to / about <person>` · `who attended <meeting>`.

**Tier-safety posture.** Team-tier-only surface for V1. The `graph_entities`/`graph_relationships` tables carry a `team_id` but **no per-row tier column and no RLS backstop**, so tier is an app-code gate: the endpoint returns **`403 forbidden_tier`** for an `external`-tier key, and the CLI probes `GET /me` and **rejects all three modes for a non-`team` key up front** (so `--meeting`, which hits `/items`, can't leak a partial answer). Default-deny otherwise; no `admin`-tier content is reachable through the surface.

**Build with:** opus / high — contract-first and cross-repo (a coordinated brain endpoint + a pinned-contract bump), so it deserves the top tier.

**Deps:** the brain-side `GET /api/v1/company-graph` endpoint (separate `aios-team-brain` PR) must deploy before a workspace release advertises v1.5; the CLI/MCP tolerate a `404` and degrade cleanly, so they can merge first. No other workspace slices must land first.

#### Acceptance (AIO-141 — observable)
- `aios stakeholders --owns "Financial Close"` **prints** "Nadia Kovalchuk" (the actor who `OWNS` the seeded `wf-001` "Month-End Financial Close" workflow) against a seeded/demo graph.
- `aios stakeholders --who "Nadia Kovalchuk"` **outputs** her role, job_family, resolved reports-to name, and owned workflow name(s).
- `aios stakeholders --meeting "<seeded meeting title>"` **prints** the attendee list read from the meeting item's `participants`, after paginating the full `/items` cursor loop (a >200-artifact fixture still finds the meeting).
- An `external`-tier key makes `--owns` / `--who` / `--meeting` each **fail with `403 forbidden_tier`** (tier probe), never a partial answer.
- Against an older brain (endpoint returns `404`) or an unseeded team (`200 {people:[],ownership:[]}`), the CLI **prints** a clean "company graph not available / empty" line, not a stack trace.
- `node scripts/brain-mcp.test.mjs` **passes** with `brain_stakeholders` listed by `tools/list` and dispatching against injected snake_case `people`/`ownership` fixtures.

#### Deferred (AIO-141 — out of scope)
- Live Company-Graph ingestion (the structured graph is seed-fixture-only today; AIO-141 signs off against the seeded/demo graph).
- Pairwise **who-met-whom** graph edges (a real `meeting` entity + attendance edges); V1 derives attendance from `items.participants`.
- A per-tier `access` column on the graph tables (would let the surface go finer than team-tier-only).
- A GUI stakeholder view; CLI + MCP ship first.

## Signal contract (emitted to C1)
`{ kind: "meeting", source: "granola", tier, occurredAt, ref: <transcript id / decision row>, payload: { title, participants, decisions[], governanceFlags? } }`

## Acceptance
> Per-item acceptance is stated in each Build subsection. AIO-370's observable acceptance is in
> **[Transcript review pipeline (AIO-370) → Acceptance](#acceptance-aio-370--observable)** and
> AIO-141's is in
> **[Stakeholder map surface (AIO-141) → Acceptance](#acceptance-aio-141--observable)**. The two
> items below are the *domain-level* acceptance for the still-deferred build items.
- Weekly closeout catches an unlogged decision from the week's transcripts (a `3-log/decision-log.md` row the transcripts imply but that is absent). *(Deferred build item.)*
- Governance-flagged meeting produces a drafted brief; decisions carry the correct tier (consented/sanitized) before any sync. *(Deferred build item.)*
