---
eval_tier: full
spec_gate: block
---

# End-to-end transcript extraction contract V1 — workspace client

## Why

The current transcript command extracts only decisions and tasks, mixes model parsing with
filesystem writes, and cannot safely sync extracted facts or stakeholder mentions. This increment
adds a grounded, human-approved path for all four candidate kinds without uploading raw
transcripts or coupling local extraction fields to Team Brain storage fields.

## What

Preserve the existing `aios transcripts draft|approve` commands and decision/task behavior while
adding a stage-v2 review contract, tier-routed fact and stakeholder-mention logs, explicit
local-to-wire adapters, Brain API 1.12 payload conformance, compatibility failures that remain
retryable, and a dedicated synthetic extraction-evaluation harness.

This is one reviewable workspace PR; follow-ups are deferred to the paired Team Brain spec or the
explicit out-of-scope list below. The paired Team Brain PR owns persistence and must deploy before
this client is released. This spec is the self-contained parent plan for the workspace increment;
there is no separate Linear dependency.

## Interfaces and contracts

### Storage-neutral extraction boundary

Create a filesystem-free extraction module under `scripts/` that exports:

- a prompt builder;
- a strict model-output parser;
- grounding, normalization, deterministic-key, and within-stage deduplication functions;
- adapters from approved extraction candidates to Markdown rows;
- types represented at runtime by strict schemas.

The parsed output always has `decisions`, `tasks`, `facts`, and `stakeholders` arrays. Every
candidate must reference a supplied transcript path and a non-empty exact `sourceQuote` contained
verbatim in that transcript. Invalid or ungrounded candidates are omitted from approved candidates
and recorded in stage metadata with a stable reason.

### Review stage

Stage schema v2 is JSON and contains the four arrays, deterministic row keys, per-row `access`,
source transcript path, exact source quote, and rejected-candidate metadata. Facts and stakeholder
mentions default to `admin`; a reviewer must explicitly edit an approved fact or stakeholder row
to `team` or `external` before it is syncable. Approval continues to accept pending v1 stages for
decisions and tasks.

Row keys are SHA-256-derived from object kind, normalized semantic content, transcript path, and
source quote. Approval deduplicates within the stage and against existing row keys/content.

### Markdown storage

Approval creates missing files with canonical frontmatter and headers, then routes rows as follows:

- `team` fact and stakeholder rows: `3-log/`, with `kind` and `access: team`;
- `external` fact and stakeholder rows: `4-shared/`, with `kind` and
  `access: external`;
- `admin` fact and stakeholder rows: private `3-log/` files with `access: admin`.

Existing decision/task numbering and idempotent reapproval remain unchanged. Approved files store
only structured rows and approved source quotes; no file body or frontmatter contains the complete
source transcript.

### Brain API 1.12 wire contract

Bump `docs/brain-api.md`, `CLAUDE.md`, and `docs/contract/brain-contract.json` to 1.12. Add an
identical versioned JSON Schema at `docs/contract/item-payload-1.12.schema.json` and canonical valid
and invalid payload fixtures under `docs/contract/`.

The new wire kinds and exact strict row shapes are:

- `fact`: `row_key`, `title`, optional `occurred_at`, `fact_type` (`fact` or `event`),
  `source_path`, `source_quote`;
- `stakeholder_mention`: `row_key`, `name`, optional `role`, optional `context`, `source_path`,
  `source_quote`.

Strings are non-empty and bounded, unknown keys are rejected, and malformed rows invalidate the
whole item. Existing decision/task wire shapes and commands stay compatible. Explicit Markdown
parsers/adapters produce these wire rows; extractor field names are never compared directly with
wire field names.

The workspace conformance guard must prove documentation version, schema identifier/version,
runtime kind classification/parsers, canonical fixture validity, invalid-fixture rejection, and
the fixture content hash agree. Release evidence records the schema SHA-256, which must match the
vendored Team Brain copy.

### Push behavior

Extend `scripts/workspace-parse.mjs` and `scripts/aios.mjs` so only approved rows from syncable
tier-specific files produce `fact` or `stakeholder_mention` items. Admin files remain blocked by
the existing default-deny boundary. The item body/frontmatter must not contain a full source
transcript.

Successful pushes retain existing state/hash semantics. A rejected or partially failed item remains
dirty and retryable. When a Brain predating 1.12 rejects either new kind, show an actionable
`Brain API 1.12 required` error and do not write clean sync state for that item.

The client also treats the Brain's HTTP 422 response for `admin`, `private`, unknown access, or
malformed rows as a rejected item: it prints the server error, leaves that item dirty, and does not
retry it as a transient transport failure.

### Extraction fidelity evaluation

Add a dedicated runner and versioned synthetic gold corpus under `evals/transcript-extraction/`.
The corpus covers positive and negative examples for all four kinds, multiple speakers and files,
ambiguity, duplicate paraphrases, absent/misleading quotes, facts versus events, and similarly
named stakeholders.

Deterministic mode injects fixed output and verifies parsing, grounding rejection, deduplication,
adapters, and scoring. Live mode invokes the configured extraction model three times. Every run
must have 100% groundedness; per-kind semantic precision and recall must each be at least 0.80; at
least two of three runs must meet every threshold. Only synthetic inputs and aggregate results are
stored.

## Implementation tasks

1. Add the 1.12 schema, fixtures, generator/hash fields, documentation revision, and conformance
   tests before changing runtime payload production.
2. Add failing unit tests for strict four-array parsing, empty output, malformed output, grounding,
   rejection metadata, deterministic keys, and deduplication; then implement the filesystem-free
   extraction boundary.
3. Add failing approval tests for v1/v2 compatibility, file creation, tier routing, explicit
   promotion, idempotency, deduplication, and unchanged decision/task numbering; then implement
   the filesystem layer.
4. Add failing sync tests for both new kinds, exact wire adapters, admin blocking, transcript
   exclusion, partial-failure retry state, and old-Brain compatibility messaging; then extend
   classification, parsing, and payload construction.
5. Add the synthetic corpus, deterministic evaluation tests, live three-run mode, aggregate report,
   and release evidence template.

## Acceptance criteria

- Existing transcript CLI commands still work, and a pending v1 stage can be approved.
- A v2 extraction with all four kinds reports every ungrounded candidate and writes only grounded,
  approved candidates.
- Fact and stakeholder rows default to admin; only reviewer-promoted team/external rows become
  syncable.
- Approval creates canonical files when absent, preserves numbering, and produces no duplicates on
  repeated approval.
- `aios push` sends exact 1.12 rows for team/external files, never sends admin files or full raw
  transcript bodies, and marks only successful items clean.
- A pre-1.12 rejection produces `Brain API 1.12 required` and leaves the item dirty.
- Workspace JSON Schema, fixtures, runtime parsers, docs, version anchors, and the paired Team Brain
  schema hash are mechanically identical.
- Deterministic extraction evaluation passes; live evaluation reports three runs and applies the
  stated 100% groundedness and 0.80 precision/recall gate.
- All required validation commands below pass in clean scaffolded workspaces for consultant,
  employee, and business-owner contexts.

## Integration points

- `scripts/transcripts.mjs` — filesystem-facing draft and approval commands.
- `scripts/workspace-parse.mjs` and `scripts/workspace-parse.d.mts` — kind classification and
  Markdown-to-wire parsing.
- `scripts/aios.mjs` — push planning, payload submission, error/state behavior.
- `scripts/brain-client.mjs` — structured API errors used for compatibility messaging.
- `docs/brain-api.md` and `docs/contract/brain-contract.json` — pinned sync contract and existing
  cross-repository conformance fixture.
- `scripts/gen-contract-fixture.mjs` and `test/contract-conformance.test.mjs` — contract generation
  and workspace drift guard.
- `test/transcripts.test.mjs` and `test/sync-execution-smoke.test.mjs` — existing CLI and sync test
  seams.
- `scripts/scaffold-project.sh` and `validation/validate-all.sh` — three-context acceptance.

## Dependencies

- Team Brain 1.12 must be deployed before releasing the emitting workspace client.
- Use the existing model boundary in `scripts/model-call.mjs`, Node test runner configured by
  `package.json`, `node:crypto` hashing used by `scripts/transcripts.mjs`, Markdown parsing in
  `scripts/workspace-parse.mjs`, and push state in `scripts/aios.mjs`. Add no runtime dependency
  unless the JSON Schema conformance test cannot use an already-installed validator.
- Live evaluation needs configured model credentials; deterministic evaluation and every release
  contract test must run without credentials.

## Scope

In scope: local extraction and grounding, human review, tier routing, fact/stakeholder sync,
versioned shared schema/fixtures, compatibility handling, and synthetic fidelity evaluation.

Out of scope: a Brain dashboard or dedicated read endpoint, canonical member/company-graph
mutation, numbered-spine configurability, replacing Team Brain's meeting-task extractor, and
uploading raw transcripts.

## Build-with

Build-with: GPT-5.6 high effort. The change crosses model parsing, local storage, access control,
wire compatibility, and release evaluation.

## Tier-safety

Raw transcripts remain `admin` and never leave the workstation. Source quotes leave only after
human approval and only on rows explicitly assigned `team` or `external`. Missing access remains
default-deny, admin/private remains blocked locally, and the Brain returns HTTP 422 if any
admin/private or invalid-tier item reaches its boundary. The client surfaces that 422 and preserves
dirty sync state. Unknown tiers are never coerced into a syncable tier. Stakeholder mentions are
evidence records, not canonical identities.

Approval appends rows to the personal workspace's Markdown logs and deduplicates by deterministic
row key. The personal workspace is a single-writer surface, so concurrent approval processes are
unsupported; no cross-process lock is required in this increment.

## Testability

Run from the workspace worktree:

```bash
npm run aios -- spec eval docs/specs/transcript-extraction-contract-v1.md
node --test test/transcript-extraction*.test.mjs test/transcripts.test.mjs \
  test/workspace-parse.test.mjs test/contract-conformance.test.mjs \
  test/sync-execution-smoke.test.mjs
npm run lint
npm test
```

Then scaffold consultant, employee, and business-owner workspaces into separate temporary
directories, run `validation/validate-all.sh` on each, exercise deterministic extraction and
approval, and run the required local Bugbot gate against the final diff. A live-eval release
artifact must name the model, corpus version, three aggregate score sets, contract SHA-256, and
verdict without containing credentials or real transcript text.
