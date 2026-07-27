# Follow-on domain spec — Transcript stakeholder enrichment

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). This is an
implementation-ready follow-on to the [Meetings transcript review pipeline](./meetings.md),
not part of AIO-370. No implementation is included with this spec.

## What / why

Meeting transcripts contain useful, provisional facts about how named people participate:
for example, a person explicitly owns a workstream, approved a decision, or committed to a
task. The workspace should let its owner review those evidence-backed observations without
turning a private transcript into a hidden reputation score or silently mutating shared
organizational data.

This follow-on adds an owner-local observation store and one explicit review boundary. It
does not change the shipped team-tier stakeholder query surface, promote observations to the
Brain, or export anything unless the operator later selects an explicit sanitized artifact.

## Dependencies and build tier

**Deps:** AIO-370's typed transcript review engine and V2 stage contract must land first so
suggestions can bind to a stable transcript review id, review digest, and transcript digests.
No Brain, Company Graph, Unified Inbox, scheduler, GUI, or `6-business/` slice is a dependency.

**Build with:** opus / high. The future slice handles sensitive transcript-derived evidence,
identity ambiguity, atomic local mutation, tier-safe export, and compatibility with a shipped
team-tier query surface; it requires high-effort implementation and adversarial privacy review.

## Scope

**In scope for a future implementation:**

- Propose categorical stakeholder observations from repository-contained transcripts after
  transcript decisions/tasks have been graded.
- Let the operator edit or remove suggestions, resolve identities, and then accept all
  remaining suggestions as one atomic local operation.
- Maintain a universal admin-local JSON observation store under `.aios/` for every workspace
  context.
- Preview and export a deliberately selected, sanitized team-tier stakeholder artifact
  without pushing it.

**Explicitly out of scope:**

- Numeric trust, confidence, influence, performance, sentiment, or relationship scores.
- Inference of sensitive personal categories or protected characteristics.
- Automatic acceptance, scheduled enrichment, connector-triggered mutation, or daily-loop
  mutation.
- Automatic Team Brain promotion, Company Graph mutation, or changes to the existing
  stakeholder query commands.
- A new Brain endpoint, item kind, payload field, schema migration, or `docs/brain-api.md`
  revision. This follow-on requires **no Brain API bump**.
- Storage in `6-business/`, `1-inbox/`, the Unified Inbox journal, or any other spine folder.

## Interface-first contracts

A future typed meetings-domain module exposes these narrow contracts through its public
barrel; the CLI remains an adapter:

- `StakeholderObservationV1`: one accepted, evidence-backed categorical observation.
- `StakeholderSuggestionV1`: one editable proposal tied to a transcript review and a
  specific evidence span.
- `StakeholderReviewV1`: the owner-local suggestion batch and its review state.
- `loadStakeholderObservations(root) -> StakeholderObservationStoreV1`.
- `stageStakeholderSuggestions(options) -> StakeholderReviewV1`.
- `acceptStakeholderSuggestions(options) -> StakeholderAcceptanceResult`, a synchronous,
  deterministic, all-or-none replacement of the local observation store.
- `previewStakeholderAssets(options) -> StakeholderAssetPreview` and
  `exportStakeholderAssets(options) -> StakeholderAssetExportResult`.

The future CLI surface is:

```text
aios stakeholder-observations list [--json]
aios stakeholder-observations edit <review> --patch <workspace-relative-json-patch> [--json]
aios stakeholder-observations approve <review> [--json]
aios stakeholder-assets preview --entities <ids> --fields <fields> --dest <workspace-relative-path> [--json]
aios stakeholder-assets export --entities <ids> --fields <fields> --dest <workspace-relative-path> [--json]
```

`edit` applies a typed, repository-contained patch; it does not accept free-form prompt prose.
It writes a new digest-bound review revision rather than trusting hand-edited JSON. `approve`
has no per-suggestion acceptance flags: the operator edits or removes unwanted suggestions
first, then one approval accepts **all and only the remaining suggestions atomically**.

## Universal admin-local storage

Every context (`consultant`, `employee`, and `business-owner`) uses the same paths:

```text
.aios/stakeholders/observations.v1.json
.aios/staging/stakeholder-enrichment/<review-id>.json
.aios/locks/stakeholder-observations.lock
```

The canonical store and review records are JSON with `access: "admin"`, created with mode
`0600`, replaced by same-directory temp-file-and-rename, and never included in `aios push`.
The lock is repository-scoped, bounded, and never stolen. No context-specific alternative
exists: in particular, business-owner workspaces must never place this data in `6-business/`.
The observation store and reviews are also never Unified Inbox entries, journal records,
notifications, or reply-policy inputs.

`StakeholderObservationStoreV1` has this boundary shape:

```ts
interface StakeholderObservationStoreV1 {
  version: 1;
  access: "admin";
  updatedAt: string;
  observations: StakeholderObservationV1[];
}

interface StakeholderObservationV1 {
  id: string;
  entity: { canonicalId: string; displayName: string };
  category: "owns" | "approves" | "decides" | "committed" | "attended" | "expertise_stated";
  subject: string;
  evidence: {
    transcriptPath: string;
    transcriptDigest: string;
    sourceQuote: string;
    occurredAt?: string;
  };
  acceptedFrom: { reviewId: string; suggestionId: string; acceptedAt: string };
}
```

The closed category set is deliberately factual and categorical. `subject` records the
explicitly stated workstream, decision, commitment, meeting, or expertise topic; it is not a
free-form personality judgment. Schema validation rejects extra score/rank fields.

## Evidence and prohibited inference

Every suggestion and accepted observation must cite a repository-contained transcript path,
the exact transcript SHA-256 digest, and a verbatim or near-verbatim `sourceQuote`. The quote
must directly support the category, named entity, and subject. Hearsay, model-only summaries,
silence, tone, and co-occurrence are insufficient.

The extractor may emit categorical observations only. It must not calculate or persist a
numeric trust/confidence/influence/performance/sentiment score, a hidden equivalent such as
ordered risk bands, or a model probability. It must not infer health, disability, race,
ethnicity, nationality, religion, political views, union membership, sexual orientation,
gender identity, age, family status, biometric/genetic data, or other sensitive categories.
If transcript text explicitly contains such data, the enrichment pipeline still excludes it
from suggestions, diagnostics, previews, and exports.

## Identity resolution and review state

`StakeholderReviewV1` is `pending_review`, `invalid`, or `accepted`. It records its source
transcript-stage id and review digest, ordered transcript digests, suggestions, diagnostics,
and a digest over all immutable review content.

Each suggestion starts with exactly one of:

- `resolved`: one stable `canonicalId` and display name;
- `ambiguous`: two or more candidate identities with evidence for the ambiguity; or
- `unresolved`: no safe match.

The pipeline never guesses a match from name similarity alone. Before approval, the operator
must resolve each ambiguous/unresolved suggestion to one canonical identity or remove it.
Approval schema validation rejects a review containing any ambiguous/unresolved identity,
missing evidence, prohibited category, or transcript-digest mismatch. There is no partial
acceptance fallback.

The operator may edit transcript-derived suggestions after extraction through the typed `edit`
path. Each edit creates an atomic review revision, recalculates its digest, and retains a
sanitized revision receipt. Approval then acquires the observation lock, revalidates the entire
remaining batch, deduplicates by entity/category/normalized subject/evidence digest, renders one
replacement store, and renames it atomically. Either every remaining suggestion is accepted or
the prior store stays byte-identical. An empty remaining batch may be explicitly accepted as a
no-op and records no observations.

## No implicit promotion or graph mutation

Accepted observations remain owner-local. Acceptance does not call `aios push`, create a
shareable manifest item, emit a C1 signal, write a Company Graph entity/edge, call an MCP tool,
or contact the Team Brain. There is no automatic promotion path from an observation to canonical
organization truth.

The existing team-tier commands remain byte-for-byte compatible in interface and meaning:

```text
aios stakeholders --owns <domain>
aios stakeholders --who <person>
aios stakeholders --meeting <meeting>
```

They continue to query the shipped Team Brain/Company Graph and meeting-item surface. They never
read `.aios/stakeholders/observations.v1.json`, merge local observations into results, or change
tier behavior.

## Signal contract

This feature emits **no Operator Loop signal**. In particular, it does not produce the
domain-wide tier-tagged shape
`{ kind, source, tier, occurredAt, ref, payload }`, register a C1 source, or add a Changed
item. A future decision to emit observations would require a separate spec and privacy review;
it is not an implicit part of this follow-on.

## Explicit stakeholder asset preview and export

`aios stakeholder-assets preview|export` is the only future path from accepted local
observations to a shareable file. Both commands require all three explicit selectors:

- `--entities`: one or more exact accepted canonical entity ids;
- `--fields`: an allowlisted subset of `displayName`, `categories`, `subjects`,
  `evidenceDates`, and `evidenceRefs`;
- `--dest`: a normalized workspace-relative destination whose existing parent and resolved
  target are team-tier.

Missing or wildcard selectors fail closed. Absolute paths, `..` escapes, symlink escapes,
admin/external destinations, `.aios/`, `1-inbox/`, `5-personal/`, `6-business/`, and Unified
Inbox storage all fail before rendering. `preview` returns the exact sanitized artifact and
destination decision without writing. `export` recomputes the same preview, requires it to pass
the team-tier leak gate, then atomically writes only that artifact with `access: team`
frontmatter. Raw quotes, transcript paths, transcript digests, review/stage paths, diagnostics,
unselected entities, unselected fields, and sensitive-category text are always removed.

Export never invokes `aios push`. Sharing remains a separate, deliberate command after the
operator inspects the artifact:

```text
aios stakeholder-assets preview --entities person-17 --fields displayName,categories,subjects --dest 2-work/stakeholders/person-17.md
aios stakeholder-assets export --entities person-17 --fields displayName,categories,subjects --dest 2-work/stakeholders/person-17.md
aios push
```

## Failure and retry contract

- Validation, identity ambiguity, digest drift, path/tier refusal, lock contention, or render
  failure occurs before mutation and leaves the store/destination byte-identical.
- Store acceptance and asset export use stable dedupe/render identities, so retry cannot
  duplicate observations or alter a successful artifact.
- No command prints success before its atomic replacement is durable.
- Diagnostics contain category, suggestion id, and sanitized reason only; they never copy raw
  transcript text or sensitive data.

## Acceptance — observable future implementation

- Focused store tests stamp consultant, employee, and business-owner workspaces and prove all
  three use only `.aios/stakeholders/observations.v1.json` with admin access and mode `0600`;
  no `6-business/`, spine, or Unified Inbox file is created.
- Extraction tests accept only evidence-backed closed categories, reject a missing/mismatched
  quote, reject numeric/ordinal trust equivalents and extra score fields, and exclude explicit
  and inferred sensitive-category observations from stages, diagnostics, and storage.
- Identity tests prove similar names remain ambiguous, and approval refuses without mutation
  until every ambiguous/unresolved suggestion is resolved to one canonical id or removed.
- Review tests edit/remove suggestions through the typed path, then prove approval accepts all
  remaining suggestions in one atomic store replacement; an injected mid-replacement failure
  leaves the prior store byte-identical and retry produces no duplicates.
- Isolation tests prove acceptance performs no network/MCP call, no Brain promotion, no Company
  Graph mutation, no C1/Changed/Unified-Inbox emission, and no `aios push` invocation.
- Compatibility tests prove `aios stakeholders --owns|--who|--meeting` retain their existing
  arguments, team-tier gating, data source, and output fixtures and never read the local store.
- Asset CLI tests require exact entities, fields, and a workspace-relative team-tier destination;
  reject wildcards/path escapes/symlinks/wrong tiers; and prove preview and export render the same
  sanitized artifact without raw evidence or unselected data.
- Push-separation tests prove a successful export makes no network call and that only a later,
  separately invoked `aios push` can share the team-tier artifact.
- Contract tests prove `docs/brain-api.md` is unchanged and no new endpoint, item kind, or payload
  field is required.

## Delivery sequence for the future issue

1. Add red-first typed schema, evidence/category, identity, atomicity, path/tier, privacy, and
   compatibility tests from the acceptance section.
2. Implement the admin-local store and review state in the meetings domain without sibling-domain
   imports or signal emission.
3. Add the `stakeholder-observations` review adapter and prove atomic batch acceptance.
4. Add `stakeholder-assets preview|export` with the shared sanitizer/leak gate and atomic writer.
5. Run all three scaffold contexts, targeted stakeholder compatibility tests, domain isolation,
   typecheck, and the normal repository gates. The future implementation must not edit
   `docs/brain-api.md`.
