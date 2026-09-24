# Reserved profile and workspace contract 1.0.0

**Contract only, not implemented or enabled.** AIO-1185 reserves these interfaces for
AIO-1190–1193. All inputs/outputs use the adjacent Draft-07 schemas. Byte ceilings below
are additional semantic checks; JSON Schema character counts cannot enforce UTF-8 bytes.

## Broker and explicit installation

The existing [`config-broker.mjs`](../../../scripts/cli/config-broker.mjs) already accepts
**schemaVersion 2** with `defaultWorkspace`, `credentialSources`, and preserved unknown
keys. Do not call this a v1-to-v2 migration. Add `connectionProfiles` using the independent
`ProfilesExtension.version: "1.0.0"`. Migration input/output schemas describe the known
projection; the writer must preserve every existing unknown field and credential reference,
including absent optional legacy fields, without resolving or copying secrets. Backup and
atomic replacement are mandatory; unsupported versions fail without writes. Repeating the
same migration is a no-op. No profile, root, destination, or grant is inferred from cwd,
`defaultWorkspace`, or existing credentials. New profiles start with all four grants false;
explicit installer setup separately enables each. Previously registered identical profiles
retain their grants; migration cannot silently increase them.

Profiles bind one authenticated Brain origin/team/project and one credential-source name.
Names resolve only through `credentialSources`; missing references fail, never fall back to
a different credential. Use HTTPS origins without path, query, fragment, or userinfo.
Workspace roots are canonical absolute POSIX, Windows drive, or UNC paths; registration
resolves the real root, captures filesystem identity, and validates destination membership.
Brain-only roots/identity are null, their local grants false, and local allowlists empty.
Changing root, destination, credential binding, allowlists, or any grant increments generation.
Revocation is checked at every call and before each publishing item. Old readers may preserve
the extension but cannot execute it. New host entries pin a profile-capable artifact: never
fall back to an older reader or merge legacy default credentials with a selected profile.

Retain the installer's existing ownership, ACL, artifact-integrity, no-running-host, dry-run,
backup and rollback guarantees in [`mcp-host-install.md`](../../mcp-host-install.md).
`--read-only` disables actions, draft, and publish regardless of grants/selectors. Tool lists
are discoverability only. Brain authorization remains mandatory. No grant enables remote
writes, shell commands, external messages, or deletion.

## Bounded local operations

All seven inputs require `profileId` matching the launch-bound profile; cross-profile selection
fails `PROFILE_CHANGED`. `workspace_status` is secret-free configuration inspection; identity
verification failure is explicit, never cached as success. Other operations require workspace
mode and live root identity. List/read/collect need `workspaceRead`; write needs
`workspaceDraft`; preview/apply need `workspaceRead` and `workspacePublish`.

Paths are relative slash-separated names, never absolute paths, dot components, backslashes,
ADS, URI escapes, or glob expressions. Decode nothing. Resolve case and Unicode using the
host filesystem. Reject symlink/reparse traversal, hard-linked files, devices, and path races;
recheck identity at opening/replacement. Permit only `.md` text below registered read/draft
roots. Always deny `.git`, `.env*`, credential/config stores, executable/config files, and
reserved Windows device names. These denials also apply to collection. Read and draft roots
are independent; draft does not imply read. No implicit directory creation or deletion.

`workspace_list` lists immediate eligible entries, sorted by normalized relative path; default
limit 50, maximum 100, cursor bound to profile/generation/path and directory snapshot. A
changed snapshot returns `CONTENT_CONFLICT`. Read/write cap one file at 262,144 UTF-8 bytes;
reject invalid UTF-8 and oversized input/output, never truncate. SHA-256 covers exact bytes,
including BOM/newlines, lowercase `sha256:` hex; no normalization. Write requires null
`expectedHash` for exclusive create or matching existing bytes for atomic replacement.
An explicit access value must match frontmatter. Local admin drafts are allowed but never
publishable. Secret validation precedes writes; collisions/changed content preserve originals.

`aios_loop_collect` retains daily/weekly semantics (weekly default) and the shared collector
manifest from [`mcp-workspace.mjs`](../../../scripts/mcp-workspace.mjs), using only this root
and eligible registered paths. `manifestJson` is the complete existing manifest JSON, never
partial JSON; maximum 1,048,576 UTF-8 bytes, otherwise `LIMIT_EXCEEDED`. CLI/MCP use identical
core, clock, identity and serialization for comparison. Collection neither publishes nor
expands filesystem access.

## Stored publishing plans

Preview takes 1–100 explicit paths (no recursive discovery), validates tiers and task revisions,
and stores immutable payload bytes, source hashes, item operation IDs, root identity,
destination and generation. It excludes admin/missing-tier/unsupported/unchanged content with
reasons; no eligible items returns `INVALID_CONTENT`. Eligible parsed item count is at most
100 and aggregate payload bytes at most 1,048,576. Kinds follow existing push mappings;
notes use their separate action. `payloadHash` hashes exact UTF-8 serialized item bytes.
`planHash` hashes RFC 8785 canonical JSON of the returned plan excluding `planHash`.
Expiry is precisely `createdAt + 900 seconds`, checked against trusted local wall time;
clock rollback invalidates the plan. Apply at or after expiry returns `PLAN_EXPIRED`.

Apply accepts only the stored plan ID, never caller replacement content/destination. Setup's
publishing grant permits apply without another approval prompt, but does not bypass server
policy. Revalidate every source hash, root, generation, destination, tier and expected revision
before the first side effect and each remaining item. Changed/revoked plans never send remaining
items. Process sequentially with durable per-item receipts and stable idempotency IDs; persist
intent before sending. After uncertain delivery, resolve by operation ID before retrying.
Succeeded receipts never replay; pending approval remains pending; denied/conflict requires a
fresh plan, while transient failed/not-attempted items may resume before expiry. Partial writes
are reported, never described as rollback. Apply returns every item's receipt, including
unattempted items; complete requires all succeeded, pending_approval indicates pending receipts,
partial indicates failures, and stale indicates post-progress invalidation. `canResume` is true
only when remaining work is safely retryable on the unchanged, unexpired, authorized plan.

## Durable server receipts (reserved API)

`POST /api/v1/items/publish` uses `PublishItemInput/Output`;
`GET /api/v1/items/publish/{operationId}?projectId=…` uses `PublishStatusInput/Output`.
The authenticated actor/team and authorized project scope the operation key. Server validates
`payloadHash` against exact UTF-8 `payloadJson`, parses it against the existing kind's `/items`
row contract for non-task kinds, and enforces tier/revision validation through shared ingestion services. Maximum
payload is 1,048,576 bytes. Persist operation intent and resulting receipt durably; domain
write and corresponding durable receipt outcome commit atomically. Same operation ID and identical payload/metadata
returns its receipt; different payload, kind, tier, or expected revision returns
`IDEMPOTENCY_CONFLICT`. A different actor cannot query or replay another actor's receipt unless
explicitly authorized by policy. Unknown/inaccessible IDs return `OPERATION_NOT_FOUND` without
revealing existence. No credentials, actor override, or caller audit fields are accepted.
Publishing authorization is separate from Brain action permission. A missing endpoint returns
`UNAVAILABLE`: never fall back to legacy `/items` for a governed plan. Status lookup is safe to
retry after transport loss and requires renewed authorization. In-flight receipt state is
`processing` with retryable false; it means intent recorded but outcome not yet confirmed,
and must be polled, not submitted with a new ID.


### Task publishing preserves row concurrency

For `kind: task`, both `PlanItem` and `PublishItemInput` require typed `taskBatch` conforming
to `tasks.schema.json#/definitions/Batch`, with nonempty rows. `payloadJson` must equal the
RFC 8785 canonical serialization of that entire batch; `payloadHash` covers those exact bytes.
The parsed batch binds `project_id = projectId`, `operation_id = operationId`, and
`source_item_id = itemId`; preview stores these same identities in its immutable envelope.
Each row retains its own task ID, row key, expected revision, complete four-field baseline,
and incoming values. Validate every row before side effects. `expectedRevision` is null for
task batches: a source document revision must never replace individual task revisions.
For other kinds `taskBatch` is null and `expectedRevision` governs only the document.
Neither branch accepts legacy actor, source-identity overrides, arbitrary metadata, or diff
based deletions; omitted task rows leave existing tasks unchanged.

A task receipt carries typed `taskResult` from `tasks.schema.json#/definitions/Result`.
Every submitted task appears in `applied` with its resulting revision (including unchanged
accepted rows), or in `conflicts` with current revision and reasons. Duplicate task IDs or row
keys are rejected before applying any row. A task receipt has null document `revision`;
`entityId` identifies its source item, never a fabricated single task. Success requires all
rows accounted for as applied and zero conflicts. Conflict receipts retain both previously
applied rows and per-row conflicts. Persist each row's result atomically with its domain
change, then complete the aggregate receipt. Recovery resumes only rows without a durable
result; identical retries return existing outcomes without applying completed rows again.
Conflicts require a refreshed preview with a new operation ID. Non-task receipts have null
`taskResult`; non-task succeeded receipts retain their document revision. Publication never
falls back to legacy many-row `/items` ingestion for task batches.
