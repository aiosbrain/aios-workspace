# MCP next contract — revision 1.0.0

Status: **proposed, contract-only**. This supplement specifies the next local stdio
release; passing its fixtures proves specification consistency, not runtime support.
The governing requirements are Linear AIO-1185 and its parent. Runtime consumers must
pin this directory's manifest and the reviewed contract commit before implementation.

The canonical Brain API document includes this supplement at document revision 1.30.
Its member-facing version remains 1.27; gateway negotiation remains 1.10. At the
inspected baseline, Brain commit `5b9400e74ff9b470682b785dcd33366cfbd74172`
actually declares 1.23 and vendors a 1.23 fixture. This pre-existing discrepancy is
not repaired by claiming future routes work. The release candidate gate must reconcile
implemented capabilities, declarations and the deployed version before enablement.

## Artifacts and boundaries

- `actions.schema.json`: closed member action requests, outcomes, status, task reads.
- `tasks.schema.json`: revision-aware workspace reconciliation and conflicts.
- `profile.schema.json`, `workspace.schema.json`, [workspace.md](workspace.md):
  explicit connections, local files and publishing.
- `operations.json`: reserved CLI/MCP mapping, transport, input/output schema and grants.
- `*-fixtures.json`: valid/invalid wire examples and semantic truth tables.
- `read-baseline.json`: snapshots of the existing nine read tool inputs/annotations.
- `manifest.json`: content-addressed artifacts. Brain vendors the same JSON bytes;
  neither repository imports the other's runtime modules.

JSON Schema draft-07 measures string lengths in Unicode code points. Unknown input
properties are rejected. IDs/revisions are opaque strings; callers never derive a
revision from time. Dates must also pass real Gregorian calendar validation (regex
alone is insufficient). These files are neither an HTTP router nor an authorization
implementation. Semantic vectors must be run against real consumers in their
implementation issues; reference checks here cannot establish persistence or isolation.

## Additive HTTP surface and feature negotiation

Reserve `POST /api/v1/actions/submit`, `GET /api/v1/actions/{action_id}`,
`GET /api/v1/tasks/{task_id}`, and `POST /api/v1/tasks/reconcile` with the
`mcp-next/1` request discriminator. Reuse the existing action/policy/audit services
internally, but do not send the new shape to the legacy `/actions` endpoint: that
endpoint accepts caller-supplied policy resources and has unrelated handler semantics.
New clients treat an absent capability, unknown contract version or 404 as
`capability_unavailable`, preserve old reads, and never fall back to legacy writes.
No version-string comparison alone enables writes.

`brain_status` retains its old input and result fields and adds optional
`capabilities: { contract_versions: ["mcp-next/1"], actions: [...], task_revisions: true }`
from an authenticated server capability response. Reserve this additive object on
`GET /api/v1/me`; absent means unavailable. Local granted capabilities are displayed
separately from server capabilities. All other legacy read tool inputs and successful
results stay unchanged. Future `note` item readers must tolerate unknown kinds;
new readers understand notes through existing item retrieval, graph and query paths.

## Governed action contract

The only new allowlisted action types are `note.append`, `task.create`, `task.update`
and `decision.record`. They do not expose the generic registry. `code.run`, legacy
`note.create`, arbitrary resources, deletes, messaging, administration and remote
writes are excluded. Legacy `note.create` remains a legacy deliverable-ingest action;
it is not silently redefined as an append-only note and is never called by these tools.

The selected connection supplies project destination to the operation layer. The
server resolves it within the authenticated team, verifies live membership and
project access, and derives the policy resource from the validated entity. The model
cannot provide actor, team, access tier, policy resource or credentials. Task IDs
must resolve inside that destination. Missing and inaccessible entities both use
404 `not_found`. Member credentials are required; delegated read tokens are rejected.
A local setup grant only permits requesting an action; it cannot bypass domain or
server policy authorization. Read-only overrides write grants on every dispatch.

Decision creation preserves the shared domain's admin/lead and visible-project
requirements. Policy evaluation may continue treating agents as role member; a
policy allow cannot confer domain privileges. `created_by`, `decided_by`, time,
team access and row identity are server-derived. Rationale/title/impact are content,
not attribution. Decisions remain immutable for this release and participate in
canonical retrieval, graph, dashboard and pull/writeback without forging provenance.

Validate and authenticate before side effects; record the durable action before
policy execution. A valid authorized request receives an action/audit identity even
when policy denies it. Malformed or unauthenticated transport errors use
`TransportError` without leaking action/entity IDs. Map success to 200, approval to
202, denial to 403, conflict to 409, validation/execution failure to 422; transient
server failure to 503, rate limiting to 429. Status GET is 200 for an accessible
stored action regardless of its business outcome. Authenticate and recheck access
for every lookup; only the initiating member may inspect it through this API.

A durable action may be requested/running while an execution claim is held. Status
GET explicitly returns those states; a duplicate submit during execution returns
202 with `ActionStatus`, never a false failure/success. Claims must fence concurrent
and restarted executors. Commit action outcome, domain mutation, audit reference and
any outbound work atomically. No second mutation after a crash between commit and
response. Pending approval may become denied or run after the existing human approval
channel resolves it. Recheck original member, credential revocation, destination and
policy immediately before resumed execution; do not reconstruct a privileged synthetic
principal. MCP cannot approve its own action. Terminal execution outcomes are stable;
downstream sync is a separate current status and may change afterward.

### Identity and retry

Task/decision clients supply an opaque operation ID. Durable uniqueness is
`(authenticated member, team, destination project, operation_id)` across action types;
stored identity and canonical request bytes are compared before executing. Identical
retries return the original action/entity; changed type or payload returns 409
`operation_id_conflict`. Never recycle completed keys. Retain tombstones if details
are archived; unknown transport outcomes are resolved by replay/status, not a new ID.
Do not return old results after access has been revoked.

Notes accept **only title/body**. Reject blank content; preserve accepted content
exactly (no trimming, Unicode normalization or newline rewriting after validation).
Limits are 200 and 25,000 code points. Dedup key is SHA-256 of UTF-8 JSON encoding of
`["note/1", member_id, team_id, project_id, title, body]`, with array order fixed and
no insignificant JSON whitespace. A unique durable constraint/claim makes concurrent
identical submissions converge on one note/action. Date is never part of identity.
A changed title/body creates a new note. Path, timestamps, attribution, kind `note`
and access `team` are server-owned. No overwrite, caller-selected tier, or external
promotion route. Replays must reauthorize before disclosing the existing note.

## Task revision and reconciliation contract

The edit set is exactly `title`, `assignee`, `status`, `due`. Task IDs and source
`row_key` are stable. `assignee` is a member ID or null (never display-name matching);
`due` is a calendar date or null, consistent with the existing feed name. Adapters
explicitly map DB `due_date` and UI `dueDate`. Canonical status spelling is checked
against the current task vocabulary before runtime enablement. Empty strings do not
mean null. Null clears assignee/due; omitted PATCH fields are unchanged. Task body,
sprint, parent, labels and priority are untouched.

Create requires all four values, and atomically establishes revision and row identity.
GET returns the current revision, permitted fields and eligible assignee/status values
for that destination. Eligibility may change after read; revalidate on write. If the
eligible set exceeds its bounded response, refuse with an actionable error instead
of returning an apparently complete truncated list. A direct edit compares the opaque
expected revision in the same transaction as mutation and durable outbox enqueue;
stale edits return conflict, leaving all fields unchanged. `raw_status` is cleared on
an authoritative status edit so the old return leg cannot suppress it as an echo.

For each workspace/provider link, store synchronized per-field baselines. Compare
normalized values with that baseline independently for all four fields:

| Brain changed | Incoming changed | Rule |
| --- | --- | --- |
| no | no | no-op |
| no | yes | apply incoming |
| yes | no | preserve Brain; outbound pending |
| yes | yes, equal | agree; advance baseline |
| yes | yes, different | conflict; preserve Brain and incoming evidence |

Apply nonconflicting fields without losing unrelated edits; retain unresolved field
baselines. Persist updated values, revision, baseline advances, conflict records and
outbound intents in one transaction per row. Never decide by timestamp alone.
Provider state/assignee IDs map explicitly; absent, ambiguous or retired mappings
produce `mapping_required`, no guessed assignment/status. Due dates participate in
projection comparisons. Keep Linear/Plane external IDs and existing adoption links;
never recreate an issue merely because a field differs.

Workspace reconcile carries complete baseline/values for each row and its expected
revision. Stale revision conflicts that row before any field apply; other valid rows
may proceed, with per-row outcomes. An empty/missing row is never deletion. Provider
reads/writes use their concurrency facilities where available; otherwise re-read
before and after writes, record the observed provider state, and do not claim atomic
cross-system CAS. Advance the provider baseline only after verified acknowledgement;
unconfirmed delivery remains pending and retriable. Inbound baseline/value updates
must be atomic to prevent echoes. Conflict resolution is an explicit four-field edit
against a newly fetched revision; no force option bypasses authorization/CAS.

### Opt-in and legacy safety

Enable revision-aware behavior per project only after a baseline backfill and supported
clients/providers are verified. Existing unaffected projects retain legacy semantics.
For enabled tasks, a revisionless legacy `/items` batch that changes or deletes any
protected row is rejected **before any part of that batch is applied**, with 409
`upgrade_required` and refresh/upgrade guidance. This includes implicit diff deletion
by omission. An unchanged legacy replay may remain a no-op and must not move revisions
or baselines. Other projects/batches are not rejected. Guard every writer, including
dashboard edits and scheduled projection, against bypassing revision/outbox rules.

Roll out additively and disabled first. Rollback disables new action/profile entrypoints
and pauses reconciliation workers; it does not downgrade enabled rows to unsafe
last-write-wins or remove durable actions, notes, outbox entries or receipt identities.
Re-enablement resumes from saved revisions and baselines.

## Compatibility and implementation evidence

| Combination | Required result |
| --- | --- |
| Existing client + new server, project not enabled | Existing read/write behavior retained |
| Existing revisionless writer + enabled changed/deleted task | Entire affected batch rejected, upgrade guidance |
| New client + old/undeclared server | Old reads work; new operations unavailable without fallback |
| Read-only or delegated read connection | No new action/file-write/publish authority |
| Brain-only connection | No filesystem access |
| Workspace connection without explicit profile | Fail closed, no cwd discovery |
| Retried committed operation or applied preview | Same entity/receipt, no duplicate write |

Acceptance here is schema/vector validation, the existing conformance suite, byte/hash
parity with Brain and independent review. Runtime issues must add real DB/HTTP, host,
revocation/race/fault tests against these vectors. Release requires verified deployed
capability/version alignment; this contract PR does not certify it.
