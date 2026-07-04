# AIOS Team Brain — API Contract

**Version: 1.5** (`/api/v1`). This document is the single pinned contract between the
contributor repo (this toolkit's `aios` CLI) and the `aios-team-brain` service. Both
sides build against this file. Treat any drift between this doc and either implementation
as a bug.

**Change policy.** A **breaking** change (altering an existing endpoint's request/response
shape or semantics) requires a **major version bump** (`/api/v2`) and a matching change in
both repos. **Additive** changes — new endpoints, new item kinds — stay within the current
major **only if both directions degrade gracefully**: the server keeps old endpoints, and
**clients MUST tolerate a `404` on any endpoint they call** (the CLI does this for the
writeback/registration pulls), so a newer client still works against an older brain.

*Revisions (additive within v1):*
- *2026-06-18 — added `GET /api/v1/decisions` (dashboard decision writeback) and
  `GET /api/v1/projects` (brain-project registration). Newer CLIs call these but tolerate a
  `404` from an older brain, so they remain backward-compatible.*
- *2026-06-18 — documented `POST /api/v1/codebases` (codebase scan ingest, team-tier) and
  added optional AEM **agent-readiness** fields to its metrics payload (`readiness_level`,
  `readiness_pct`, `readiness_pillars`, `readiness_rubric_version`). Additive — scanners that
  omit them are unaffected; an older brain that predates the columns ignores them.*
- *2026-06-19 — `POST /api/v1/codebases` now **requires the full raw-metrics block** (commits /
  loc / files / `recent_commits` / scaffolding). A sparse/partial push (e.g. readiness-only) is
  rejected `422` — the metrics upsert REPLACES the row on `(codebase_id, head_sha)`, so a partial
  push would zero existing analytics. Readiness fields stay optional. The canonical pusher is the
  ingestion sidecar (`aios-ingest scan`); the workspace's `aios assess-codebase` is now
  offline/read-only (its sparse `--push` was removed).*
- *2026-06-19 — added `POST /api/v1/metrics` (AEM **individual** maturity daily aggregate from
  `aios analyze --push`). Team-tier only; `external`/`admin` rejected. A standalone endpoint, not
  an `/items` kind. Newer CLIs tolerate a `404` from an older brain.*
- *2026-06-19 — added `GET /api/v1/integrations` (enabled integration selections for connector
  tooling). Non-secret only: secrets stay encrypted at rest and are never returned over HTTP.
  Newer CLIs/connectors tolerate a `404` from an older brain.*
- *2026-06-20 — added optional task PM-link fields and `POST /api/v1/work-events`
  for merged-work completion events. Additive: older CLIs keep sending the six-column
  task table, and newer automation tolerates a `404` from an older brain.*
- *2026-06-22 — **v1.2**: added optional task **hierarchy** fields — `parent` (the epic's
  `row_key`), `labels` (string array), and `priority` (`none|low|medium|high|urgent`) — to both
  the `POST /api/v1/items` task rows and the `GET /api/v1/tasks` writeback. These let the brain
  be the source of truth that projects a structured board (epics → sub-issues, labels, priority)
  into the primary PM tool. Additive: the six-column table stays valid; older CLIs omit the new
  fields and an older brain ignores them. Task **`body`/description is intentionally NOT a contract
  field** — it is canonical in the brain's Postgres `tasks.body`, authored in the dashboard, and
  never round-trips through markdown.*
- *2026-06-22 — added `POST /api/v1/costs` (external AI provider daily spend from
  `aios analyze --push`). Team-tier only. Cursor dashboard USD + Claude session-log estimates.
  Newer CLIs tolerate a `404` from an older brain.*
- *2026-07-03 — **v1.3**: added an optional `ce_band` scalar (integer `0`–`4`) to the
  `POST /api/v1/metrics` payload — a coarse client-side **cognitive-ergonomics** band (higher =
  more protected attention, scored relative to the operator's own baseline) derived alongside the
  `provisional` placement. Additive and provenance-only: older CLIs omit it and an older brain
  ignores it; when present the brain persists it verbatim and never recomputes it.*
- *2026-07-03 — **v1.4**: documented **Linear→brain inbound apply** (AIO-145, completing the
  deferred Phase 5 of brain→PM projection). A semantic/behavioral bump with **no wire-shape
  change** to any request/response — the `POST /items` and `GET /tasks` shapes are unchanged, so it
  stays within `v1`. Adds the normative **"Bidirectional PM sync (Linear ⇄ brain)"** section below:
  status is applied Linear→brain only when the brain hasn't changed since its last projection
  (`status: pm-wins-if-brain-unchanged`; `title/body/labels/priority` stay brain-wins); a PM change
  concurrent with a pending brain change is **surfaced as a conflict, never auto-merged**;
  Linear-native issues are **adopted as `team`-tier tasks** (never `admin`, never tier-elevated); and
  an inbound apply updates the projection baseline (`last_projected_status` + fingerprint)
  **atomically** with `tasks.status` so the next projection is a guaranteed no-op (no echo loop). The
  trigger is **poll-driven** (the existing ingest scheduler) and gated by a per-team opt-in;
  near-real-time **Linear webhooks remain out of scope for v1** (tracked as a fast-follow). This rule
  is kept **separate from** the markdown↔dashboard "last write wins per `row_key`" conflict rule
  below — the two axes (Linear⇄brain vs markdown⇄dashboard) resolve independently.*
- *2026-07-04 — **v1.5**: added `GET /api/v1/company-graph` (AIO-141 — the workspace stakeholder-map
  surface). A new **team-tier** read that projects the brain's structured Company-Graph
  (`graph_entities` / `graph_relationships`) as `people[]` (actors + role/job_family/org edges) and
  `ownership[]` (server-resolved `OWNS`/`TOUCHES`/`PRODUCES` edges → the owned workflow's name +
  job_family). Additive: a newer CLI/MCP calls it but **tolerates a `404` from an older brain**, and
  an unseeded team returns `200 { "people": [], "ownership": [] }` (never `500`). **"Who attended
  meeting Y" is NOT served here** — attendance is derived client-side from existing `GET /items`
  meeting markers (`frontmatter.meeting: true`, `participants`); no new item kind, no who-met-whom
  edges. Section below.*

---

## Vocabulary (normative)

### Access tiers

Canonical values: **`admin` | `team` | `external`**.

- `client` (consultant context), `company` (employee context), and `private` are the
  **friendly labels** authors write. `client`/`company` normalize to `external`;
  `private` normalizes to `admin`. All normalization happens on ingest; responses
  always use canonical values.
- `admin` (friendly `private`) content **never syncs**. The client enforces this
  (default-deny before any network call); the server independently rejects it with
  `422`.
- Files with **no `access` frontmatter do not sync** (client-side default-deny). The
  CLI reports them as `blocked` with the reason.

### Item kinds

`deliverable` | `transcript` | `decision` | `task` | `artifact` | `skill`

`decision` and `task` items are markdown files containing the canonical status tables
(`3-log/decision-log.md`, `3-log/tasks.md`). For these, the client also parses
table rows into `rows[]` so the brain can materialize structured entities.

**Forward-compat:** clients MUST ignore item kinds they don't recognize (a v1 client
that predates `skill` simply skips those items on pull). New kinds are additive.

### Skills (kind `skill`)

A shared skill is published as multiple items under one path prefix
`.claude/skills/<name>/`:

- **`.claude/skills/<name>/SKILL.md`** — kind `skill`. Unlike other kinds, its `body`
  carries the **full SKILL.md including its own frontmatter** (so pull is lossless and
  the skill is runnable verbatim). Its item `frontmatter` carries a manifest:

  ```json
  {
    "skill": "<name>",
    "access": "team",
    "manifest": { "references": ["decision-audit.workflow.js"] },
    "source_project": "<origin workspace slug>",
    "source_actor": "<member who shared it>"
  }
  ```

- **`.claude/skills/<name>/<ref>`** — each reference file as kind `artifact`, with
  `frontmatter.skill = <name>` and `frontmatter.skill_ref = true`.

Skills are team- or outward-tier only (never `admin`/`private`). Pull a whole skill
with `?path_prefix=.claude/skills/<name>/`. Installation into a workspace's live
`.claude/skills/` is always an explicit client-side act — pulled skills never
auto-activate.

---

## Authentication

Every request carries:

```
Authorization: Bearer aios_<key_id>_<secret>
X-AIOS-Team: <team_id>
```

- Keys are issued per **member** in the brain's admin UI and shown once. The brain
  stores only `sha256(secret)`.
- A key is valid only for its own team; `X-AIOS-Team` must match or the request fails.
- Failures return `401` and are audit-logged with source IP.

## Error envelope

All errors:

```json
{ "error": { "code": "string", "message": "human-readable", "request_id": "uuid" } }
```

Codes: `unauthorized` (401), `forbidden_tier` (422, admin content), `invalid_payload`
(422), `payload_too_large` (413, >1 MB), `rate_limited` (429, with `Retry-After`),
`internal` (500).

## Rate limits

- `POST /items`: 120/min per key
- `GET /items`, `GET /tasks`: 60/min per key
- `GET /integrations`: 60/min per key
- `GET /company-graph`: 60/min per key
- `POST /query`: 10/min per member; daily budgets enforced server-side
- `POST /metrics`: 60/min per key
- `POST /work-events`: 60/min per key

---

## `POST /api/v1/items` — push (upsert)

One item per request. Idempotent.

```json
{
  "project": "northwind-aios",
  "path": "2-work/governance-framework.md",
  "kind": "deliverable",
  "content_sha256": "hex",
  "actor": "alex",
  "access": "team",
  "frontmatter": { "status": "review", "owner": "alex", "sprint": "sprint-1" },
  "body": "full markdown body (frontmatter stripped)",
  "rows": []
}
```

- `project`: slug of the workspace's project (from `workspace.yaml` name —
  legacy: `project.yaml` / `engagement.yaml` — slugified).
- `actor`: the resolved member identity (must match a member `actor_handle` on the
  brain side; unknown actors are accepted but flagged in the dashboard provenance).
- `rows`: present **only** for `kind: decision|task`. Shapes below.

**Task rows** (parsed from `tasks.md` `| ID | Task | Assignee | Status | Sprint | Due |`;
newer CLIs also accept optional `PM`, `PM URL`, and the v1.2 `Parent`, `Labels`, `Priority` columns):

```json
{ "row_key": "P0.1", "title": "...", "assignee": "alex",
  "status": "in_progress", "sprint": "Wave 1", "due": "2026-03-27",
  "parent": "P0", "labels": ["integration", "wave-1"], "priority": "high",
  "pm_provider": "plane", "pm_external_id": "P0.1", "pm_url": "https://..." }
```

Status values the client sends verbatim; the server normalizes to
`backlog|ready|in_progress|blocked|done` (unknown → `backlog`, raw value preserved).
The PM-link fields are optional and provider-neutral. `pm_provider` identifies the
external project-management system (`plane` or `linear` in v1), `pm_external_id` is
the provider's durable issue/work-item key, and `pm_url` is display/provenance only.

**Hierarchy fields (v1.2, all optional):** `parent` is the `row_key` of this row's epic
(the parent must exist in the same project; the server rejects a missing parent or a cycle).
`labels` is a string array (rendered in markdown as a single comma-separated `Labels` cell).
`priority` is one of `none|low|medium|high|urgent` (unknown → `none`). These let the brain
project a structured board into the primary PM tool. **`body`/description is NOT a task-row
field** — it lives only in the brain's `tasks.body` (dashboard-authored) and never travels
through markdown or this contract.

The six-column table remains valid and is the default scaffold; the optional columns are additive.

**Decision rows** (parsed from `decision-log.md`
`| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |`):

```json
{ "row_key": "12", "decided_at": "2026-03-20", "title": "...", "rationale": "...",
  "decided_by": "Priya Sharma", "impact": "...", "tier": 2, "audience": "team" }
```

**Server semantics (normative):**

1. Upsert project on `(team_id, project)`.
2. If an item exists at `(team_id, project, path)` with identical `content_sha256` →
   `200 {"status":"unchanged"}`; only `synced_at` is bumped.
3. Otherwise upsert the item; if the body changed, append an immutable version record.
4. If `rows[]` present: **diff-sync by `row_key`** — upsert all incoming rows; rows
   absent from the payload are deleted **only if** they originated from sync
   (UI-created rows are never deleted by a push).
5. `access: client`/`company` → stored as `external`. `access: admin`/`private` →
   `422 forbidden_tier`.
6. Every accepted push is audit-logged with key id, member, and item path.

**Response:** `201 {"status":"created","id":"uuid"}` /
`200 {"status":"updated"|"unchanged","id":"uuid"}`

## `GET /api/v1/items?since=<ISO8601>&project=<slug>&kinds=a,b&path_prefix=<p>` — pull

Returns items the calling key's member tier may see (tier filtering is re-applied
server-side in SQL), updated strictly after `since`. Keyset-paginated.

Query params: `since`, `cursor`, `project`, `kinds` (comma list), and **`path_prefix`**
— restrict to items whose `path` begins with the prefix (used for on-demand fetches:
a whole skill folder via `.claude/skills/<name>/`, or one deliverable by its path).

```json
{
  "items": [
    { "id": "uuid", "project": "northwind-aios", "path": "...", "kind": "deliverable",
      "access": "team", "frontmatter": {}, "body": "...", "content_sha256": "hex",
      "actor": "riley", "updated_at": "ISO8601" }
  ],
  "next_cursor": "opaque-or-null"
}
```

Pass `cursor=<next_cursor>` to continue. Page size 200.

The CLI writes pulled items **append-only** under `1-inbox/from-brain/` (legacy:
`01-intake/from-brain/`) — it never overwrites working files; promotion into the
spine stays a deliberate human act.

## `GET /api/v1/items/<id>` — fetch one item

Returns a single item by id, tier-filtered (an external-tier key gets `404` for a
team item). Same object shape as one element of the `items[]` array above. `404
not_found` if the id doesn't exist or is above the caller's tier. Used by on-demand
pulls and dashboard detail views.

## On-demand pull (client commands)

The CLI exposes these over the endpoints above:

- `aios push skill <name>` — publish `.claude/skills/<name>/` (SKILL.md as kind
  `skill` + references as `artifact`s).
- `aios pull skill <name>` — `GET …?path_prefix=.claude/skills/<name>/` → write to
  `1-inbox/from-brain/skills/<name>/` with provenance.
- `aios pull deliverable <path>` — `GET …?path_prefix=<path>` → write under
  `1-inbox/from-brain/<project>/<path>`.
- `aios install-skill <name>` — promote a pulled skill into `.claude/skills/`
  (offline, append-only, explicit; refuses to overwrite without `--force`).

## `GET /api/v1/tasks?since=<ISO8601>` — task writeback

Returns task rows created or modified **in the dashboard UI** since the cursor, so the
CLI can merge them into the local `3-log/tasks.md`:

```json
{
  "tasks": [
    { "project": "northwind-aios",
      "rows": [ { "row_key": "T-09", "title": "...", "assignee": "riley",
                  "status": "ready", "sprint": "sprint-2", "due": null,
                  "parent": "T-00", "labels": ["frontend"], "priority": "medium" } ] }
  ],
  "next_cursor": null
}
```

The v1.2 `parent`, `labels`, and `priority` fields are included so dashboard edits to the
hierarchy round-trip back into markdown; they are optional and an older brain omits them.
**`body` is never returned here** — it is dashboard/Postgres-only and intentionally outside
the markdown round-trip.

Merge semantics on the client: match by `row_key`; update existing rows in place;
append unknown rows to the table; never delete local rows. When the brain sends optional
hierarchy fields, the client emits the optional `Parent | Labels | Priority` columns
(`labels` comma-joined in one cell); a six-column local table is upgraded in place and an
existing six-column table without these edits is left untouched.

## `GET /api/v1/decisions?since=<ISO8601>` — decision writeback

Returns decision rows created or edited **in the dashboard UI** since the cursor, so the
CLI can merge them into the local `3-log/decision-log.md`. **Tier-scoped:** an
`external`-tier key receives only `audience: "external"` rows.

```json
{
  "decisions": [
    { "project": "northwind-aios",
      "rows": [ { "row_key": "ui-4341377c", "decided_at": "2026-06-18",
                  "title": "...", "rationale": "...", "decided_by": "John",
                  "impact": "...", "tier": null, "audience": "team" } ] }
  ],
  "next_cursor": null
}
```

Merge semantics mirror tasks: match by `row_key` (the decision-log `#` column); update
existing rows in place; append unknown rows; never delete local rows. UI-created rows
carry a `ui-…` key; the brain never diff-deletes decisions, so a UI row survives until
it is written back and re-pushed.

> **Reserved key namespace.** Row keys beginning `ui-` are **reserved** for rows created in
> the dashboard (a `ui-` + random-hex id minted by the brain). Markdown authors must not
> hand-write `ui-*` keys in `tasks.md` / `decision-log.md`, so a round-tripped UI row keeps a
> stable identity and can't collide with a human-authored row.

## `GET /api/v1/projects` — team project list (team-tier only)

Lets `aios pull` register **brain-created** projects (created in the dashboard, never
pushed from a repo) as local marker files under `1-inbox/from-brain/_projects/`. An
`external`-tier key gets `403 forbidden_tier`. The CLI writes a marker only for
`brain_only` projects it doesn't already have; full local scaffolding is deferred.

```json
{
  "projects": [
    { "slug": "northwind-aios", "name": "Northwind AIOS", "brain_only": false },
    { "slug": "q3-planning",    "name": "Q3 Planning",    "brain_only": true }
  ]
}
```

## `GET /api/v1/company-graph` — structured stakeholder map (team-tier only)

Projects the brain's structured **Company-Graph** (the `graph_entities` / `graph_relationships`
Postgres tables) as a queryable people + ownership view for the workspace stakeholder-map surface
(`aios stakeholders`, MCP `brain_stakeholders`). This answers **"who owns domain X"** and
**"who reports to / about whom."** It is the structured-graph counterpart to `POST /api/v1/query`
(the NL Graphiti memory) — a *different* subsystem: this endpoint returns typed rows, not prose.

**Team-tier only** — an `external`-tier key gets `403 forbidden_tier`. The graph tables carry a
`team_id` but **no per-row tier column and there is no RLS backstop** on the Postgres target, so the
tier boundary is an **app-code gate** (same posture as `/metrics`, `/costs`, `/codebases`,
`/projects`). Rate limit: 60/min per key. Clients **MUST tolerate a `404`** from an older brain that
predates this endpoint (the forward-compat rule).

**Request:** no body. Team-scoped to the key's team via `X-AIOS-Team`.

**Response `200` — snake_case throughout** (every v1 field is snake_case: `display_name`,
`job_family`, `content_sha256`):

```json
{
  "people": [
    { "entity_id": "actor-006", "name": "Nadia Kovalchuk",
      "role": "Head of Finance", "job_family": "Finance",
      "reports_to": "actor-005" }
  ],
  "ownership": [
    { "person_id": "actor-006", "relationship": "OWNS",
      "target_id": "wf-001", "target_kind": "workflow",
      "target_name": "Month-End Financial Close",
      "target_job_family": "Finance" }
  ]
}
```

**Server semantics (normative):**

1. `people[]` is every `graph_entities` row with `entity_type = "actor"` for the caller's team.
   `role`, `job_family`, and `reports_to` are projected out of the entity's `attrs` object (the seed
   stores the whole fixture object in `attrs`, so `attrs.role` / `attrs.job_family` /
   `attrs.reports_to` are present); a missing attr is emitted as `null`.
2. `ownership[]` is a **server-side join**: every `graph_relationships` row whose
   `relationship_type` is one of `OWNS` / `TOUCHES` / `PRODUCES` for the team, with its `to_id`
   resolved against `graph_entities` to fill `target_name` (the entity's `name`), `target_kind`
   (its `entity_type`, typically `workflow`), and `target_job_family` (`attrs.job_family`). Edges
   point at **workflow entities**, not free-text domains — this join is what makes a
   `--owns "<domain>"` substring query matchable. An edge whose `to_id` doesn't resolve is skipped.
3. **Empty-graph contract:** an authenticated team-tier key on an **unseeded** team (the structured
   graph is seed-fixture-only today) returns `200 { "people": [], "ownership": [] }` — never `500`.
4. **Attendance ("who attended meeting Y") is NOT served by this endpoint.** It is derived
   client-side from existing `GET /api/v1/items` meeting markers (`kind: artifact`,
   `frontmatter.meeting: true`, comma-joined `participants`). There is no meeting entity and no
   who-met-whom / attendance edge in the structured graph in v1 (deferred).

**Errors:** `401` invalid key/team; `403 forbidden_tier` for a non-team key; `429` rate-limited
(60/min per key).

> **Cross-repo sequencing.** The workspace CLI/MCP consumers merge independently because they
> tolerate a `404` (they degrade to a clean "company graph not available / empty" message). But a
> **tagged workspace release that advertises v1.5 `company-graph`** requires the `aios-team-brain`
> endpoint **deployed first**; gate that with `/docs-sync` (contract-version + feature-vs-website
> check) before tagging.

## `GET /api/v1/integrations` — enabled integration selections (non-secret)

Returns the authenticated team's **enabled** integration selections for connector
tooling. This endpoint is intentionally non-secret: it returns selection/config metadata
only, never connector credentials.

**Auth:** same API-key scheme as the other v1 routes:

```
Authorization: Bearer aios_<key_id>_<secret>
X-AIOS-Team: <slug-or-id>
```

**Request:** no body.

**Response `200`:**

```json
{
  "integrations": [
    {
      "id": "uuid",
      "type": "slack",
      "name": "eng",
      "config": { "channelIds": ["C1", "C2"] },
      "status": "enabled"
    }
  ]
}
```

- `config` is the per-type **non-secret** selection (channels, repos, keywords, etc.).
- The connector secret is never returned by this endpoint: no `secret`, no
  `secret_ciphertext`. Secrets are stored encrypted at rest and decrypted only
  in-process by the ingestion runner; they never cross the API boundary.
- Results are team-scoped to the key's team. Disabled integrations are omitted.

**Errors:** `401` invalid key/team; `429` rate-limited (60/min/key).

## `POST /api/v1/work-events` — merged-work completion event

Records an observable work event (currently a merged PR) and advances matching AIOS
task rows to `done`. This is the automation path used by repo-level CI after a PR
lands on `main`; it is also safe for local tooling to call after manually completing
work.

```json
{
  "project": "northwind-aios",
  "event_kind": "merged",
  "repo": "AIOS-alpha/aios-team-brain",
  "merged_sha": "abc123...",
  "pr_url": "https://github.com/AIOS-alpha/aios-team-brain/pull/42",
  "pr_title": "W1.2.1 Add per-member cost aggregation",
  "pr_body": "AIOS-Work: W1.2.1",
  "work_keys": ["W1.2.1"],
  "actor": "alex"
}
```

**Server semantics (normative):**

1. Team-tier keys only; `external` keys receive `403 forbidden_tier`.
2. `project`, `repo`, `merged_sha`, and `event_kind` are required. `event_kind` is
   currently `merged`; future event kinds are additive.
3. `work_keys[]` is preferred. If omitted, the server may derive keys from PR title,
   body, branch, or trailers using the same conservative grammar as the client helper.
4. For each key, insert or update one idempotent `work_events` row keyed by
   `(team_id, repo, merged_sha, row_key, event_kind)`.
5. If a task row exists in the named project, update that row to `status: "done"` and
   trigger PM-provider sync through the task's PM link. Re-sending the same event is a
   no-op apart from refreshing timestamps.
6. If no task row exists, preserve the event as `unresolved` for dashboard/admin
   reconciliation; never silently create a done task.

**Response:**

```json
{
  "status": "ok",
  "applied": [{ "row_key": "W1.2.1", "task_id": "uuid" }],
  "unresolved": [],
  "pm_sync": [{ "row_key": "W1.2.1", "provider": "plane", "status": "synced" }]
}
```

## `POST /api/v1/query` — natural-language query

```json
{ "question": "What did we decide about governance review gates?", "project": null }
```

Response is an SSE stream (`text/event-stream`):

- `event: delta` — `{"text": "..."}` answer tokens
- `event: sources` — final trailer:
  `{"sources":[{"id":"S1","item_id":"uuid","project":"...","path":"...","kind":"decision"}]}`
- `event: done` — `{"input_tokens":n,"output_tokens":n,"cost_usd":n}`

Answers are grounded only in tier-visible items; citations use `[S#]` inline markers
that map to the `sources` trailer. The CLI's `aios query` prints the answer followed by
a numbered source list.

---

## Conflict semantics (tasks, two-way)

A task row can change in markdown (synced by push) and in the dashboard (Kanban drag)
between syncs. Resolution: **last write wins per `row_key`** on `updated_at`. The
`origin` flag (sync|ui) only governs deletion (push never deletes UI rows). Document
disagreements surface in `aios status` when the local table and last-pulled state
diverge.

This rule governs the **markdown ⇄ dashboard** axis only. The **Linear ⇄ brain** axis
(inbound apply, below) resolves on a different, field-level policy and the two are
independent: a row can be settled on one axis while conflicted on the other.

## Bidirectional PM sync (Linear ⇄ brain) — inbound apply (v1.4)

> **Status:** contract-first (this section lands before the matching `aios-team-brain`
> code). Projection stays brain→Linear (brain-wins) as documented in
> [`docs/v1-operator-loop/domains/tasks-pm.md`](./v1-operator-loop/domains/tasks-pm.md);
> this section adds the **inbound** direction (Linear→brain) that completes the round trip.
> Brain-internal only: no `/api/v1` request/response shape changes, so no external client
> (the `aios` CLI) is affected. Documented here because `brain-api.md` is the single pinned
> place where cross-boundary task semantics are versioned.

Historically the brain projects tasks one-way into Linear and **silently overwrites** any
status a human drags on the Linear board at the next projection. Inbound apply makes those
board edits durable and lets a Linear-native issue become an owned brain task, without
creating an echo loop.

**Field-level policy (default `INBOUND_FIELD_POLICY`, per-team configurable later):**

| Field | Direction | Rule |
|-------|-----------|------|
| `status` | Linear → brain | `pm-wins-if-brain-unchanged` — applied at **state-group** granularity (not raw state name) only when the brain has not changed the task since its last projection. |
| `title` · `body` · `labels` · `priority` | brain → Linear | brain-wins (projection); never applied inbound in v1. |

**"Brain unchanged" is fingerprint equality, not a status-only check.** The brain recomputes
`projectionFingerprint(task)` over the whole projectable shape (title, body, labels, priority,
parent, sprint, assignee, status-group) and compares it to the link's stored
`projection_fingerprint`. Equal ⇒ nothing is pending outbound ⇒ safe to accept an inbound
status. This subsumes a status-group comparison and avoids swallowing a pending title/body edit.

**Resolution matrix (per task):**

| Linear moved? | Brain has a pending change? | Outcome |
|---------------|-----------------------------|---------|
| yes | no (fingerprint equal) | **apply** Linear status → `tasks.status` |
| yes | yes (fingerprint differs) | **conflict** — surfaced for human resolution, never auto-merged |
| no  | yes | normal outbound projection's job; inbound does nothing |
| no  | no | no-op |

A state name in Linear that no longer resolves to a known state group (renamed/deleted state,
so no baseline can be established) is treated as a **conflict**, not an apply.

**Loop-prevention invariant (normative).** An inbound apply updates
`last_projected_status` **and** `projection_fingerprint` **atomically** with `tasks.status`
(single DB transaction, guarded on the expected pre-apply status for optimistic concurrency —
a concurrent brain edit aborts the apply and becomes a conflict). The next reactive projection
therefore sees an equal fingerprint and makes **zero** provider writes. This is what prevents
the inbound → outbound → inbound echo loop (the "regenerate" gotcha).

**Inbound adopt/create — tier safety (normative).** A Linear-native issue (no `aios-ext`
footer, not already linked) becomes a **`team`**-tier `kind=task` item. Inbound **never**
creates `admin`/`private` content and **never elevates** tier — preserving the same boundary
the API enforces at `422`. Adoption sets the task's `provider_resource_id` to the existing
Linear issue (so projection never creates a duplicate), backfills the durable
`aios-ext: <row_key> · source: <src>` footer, and marks the task owned. Tier provenance flows
from the task's source item `access` (`team`), not from any new field.

**Trigger — poll-first.** Inbound apply and adopt run on the existing **30-min ingest
scheduler** (and the admin "Sync now" / "Reconcile" path), gated per team by an opt-in flag
(default off) so enabling Linear-writes-brain is a deliberate, reversible, per-team act.
**Near-real-time Linear webhooks remain out of scope for v1** (see below) and are tracked as a
fast-follow; poll covers every acceptance criterion.

## Out of scope for v1

Hours sync; binary artifact upload (storage bucket); **webhooks** (incl. the near-real-time
Linear inbound webhook receiver — HMAC-over-raw-body verification, signing-secret provisioning,
team routing, replay/idempotency — tracked as a fast-follow to the v1.4 poll-driven inbound
apply above); bulk endpoints; embedding-based retrieval (server may add it transparently —
contract unchanged).

---

## OKF Bundle endpoint (Tier 3 extension)

> **Status:** Implemented (brain: `app/api/v1/okf-bundle/route.ts`; client:
> `aios pull-bundle`). Both sides build against this document; treat any drift
> as a bug. The v1 endpoints above are unchanged.

### `GET /api/v1/okf-bundle` — pull the engagement's OKF link graph

```
GET /api/v1/okf-bundle?project=<slug>&since=<ISO8601>&include_body=false&tier=team|external
Authorization: Bearer aios_<key_id>_<secret>
X-AIOS-Team: <team_id>
```

**Parameters:**
- `project` — optional; filter to one project slug. Omit to return all projects visible to the caller's tier ceiling.
- `since` — optional ISO8601 cursor; return only nodes updated after this timestamp.
- `include_body` — boolean, default `false`. When `false`, returns frontmatter + link graph only (the navigation layer). When `true`, includes full body text.
- `tier` — optional; `team` or `external`. Defaults to the caller's tier ceiling.

**Response:**

```json
{
  "bundle": {
    "project": "northwind-aios",
    "generated_at": "ISO8601",
    "nodes": [
      {
        "path": "2-work/governance-framework.md",
        "title": "Governance Framework",
        "kind": "deliverable",
        "access": "team",
        "frontmatter": { "status": "final", "owner": "jordan", "sprint": "sprint-1" },
        "links": [
          "../3-log/decision-log.md",
          "ai-readiness-assessment-report.md"
        ],
        "body": null
      }
    ]
  },
  "next_cursor": "opaque-or-null"
}
```

**Server semantics (normative):**

1. The server derives the markdown link graph from item bodies using the same link grammar as the client (`[text](relative.md|.yaml)`, excluding anchors and URLs). Whether it does so at ingest (denormalized) or on read is an implementation detail; output is identical. (Current brain: on read.)
2. `GET /okf-bundle` returns the same graph regardless of extraction timing.
3. Links are document-relative paths (same format the client writes). The server does not validate them — broken or cross-project links are preserved so clients can report them.
4. `include_body=false` is the primary mode for graph hydration. `include_body=true` is rate-limited at 10/min per key because it returns full text.
5. **Tier filtering:** The same SQL tier filter as `GET /items` applies. `links[]` is also filtered: links pointing to documents above the caller's tier ceiling are redacted.

**Rate limits:** `GET /okf-bundle`: 30/min per key. Page size 500 nodes (keyset-paginated by `updated_at`).

### `aios pull-bundle` — pull the OKF bundle to local cache

```
aios pull-bundle [--include-body]
```

Downloads the OKF bundle from the brain and writes `.aios/bundle.json` (gitignored).
This is the client side of the contract; enables future `aios graph --bundle` mode
for cross-project traversal without local file walking.

```json
{
  "project": "northwind-aios",
  "pulled_at": "ISO8601",
  "nodes": [ ... ]
}
```

The `--include-body` flag passes `include_body=true` to the endpoint (subject to the
10/min rate limit). Without it, only frontmatter + links are pulled.

---

## Codebase analytics endpoint (extension)

> **Status:** Implemented (brain: `app/api/v1/codebases/route.ts`, ingest
> `lib/codebases/ingest.ts`; canonical pusher: the ingestion sidecar `aios-ingest scan`).
> Team-tier only. `aios assess-codebase` scores locally (`--json`) but does not push.

### `POST /api/v1/codebases` — codebase scan ingest

Records a point-in-time scan of a repository. **Team-tier only** — an `external`-tier key
gets `403 forbidden_tier` (codebase analytics never reach external stakeholders; tier
isolation is enforced in app code, with no DB backstop). Rate limit: 60/min per key.

```json
{
  "codebase": { "slug": "my-repo", "full_name": "org/my-repo", "provider": "github" },
  "metrics": {
    "head_sha": "abc123…",
    "window_days": 90,
    "loc": 12000,
    "files": 240,
    "commits_window": 40,
    "ai_commits_window": 18,
    "additions_window": 3200,
    "deletions_window": 900,
    "recent_commits": [{ "sha": "abc123", "author": "Jo", "ai": true, "committed_at": "2026-06-18T…" }],
    "has_claude_md": true,
    "has_agents_md": false,
    "agents_md_count": 0,
    "skills_count": 7,
    "commands_count": 3,
    "test_coverage_pct": null,
    "readiness_level": "L3",
    "readiness_pct": 61.11,
    "readiness_pillars": { "testing": { "passed": 2, "total": 2 }, "docs": { "passed": 2, "total": 3 } },
    "readiness_rubric_version": "1.0.0"
  }
}
```

- The core raw-scan fields above (commits / loc / files / `recent_commits` / scaffolding) are
  **required**; a sparse/partial push is rejected `422` (see the 2026-06-19 revision). `window_days`,
  `test_coverage_pct`, and the cadence inputs may be omitted.
- The scan is keyed by `(team_id, slug)` for the codebase and `(codebase_id, head_sha)` for the
  metrics point (idempotent: re-pushing the same commit updates in place, no duplicate point).
- **AEM agent-readiness** fields (`readiness_*`) are **optional and scored scanner-side** against
  the canonical rubric (`agentic-engineering-maturity/rubric/agent-readiness.json`); the brain
  persists them verbatim and does not recompute them. The brain's own heuristic `agentic_score`
  is computed separately from the raw scaffolding/coverage inputs.
- Optional `contributions[]` and `issues[]` arrays carry per-author/day rollups and GitHub issues.

**Response:** `201 { "status": "ok", "codebase_id": "uuid", "metrics_id": "uuid", ... }`

---

## Agentic-maturity endpoint (AEM individual scope)

> **Status:** Implemented (brain: `app/api/v1/metrics/route.ts`, ingest
> `lib/metrics/individual-maturity-ingest.ts`; client: `aios analyze --push`). Team-tier only.

Records one day's agentic-maturity aggregate for a member, derived by `aios analyze` from that
member's **local** agent-session logs (Claude Code / Codex / Cursor). **Raw session content never
leaves the machine** — only the ratios, counts, and scores below cross the boundary. This is a
standalone analytics endpoint, **not** an `/items` kind.

### `POST /api/v1/metrics` — agentic-maturity daily aggregate

**Team-tier only** — an `external`-tier key gets `403 forbidden_tier` (maturity is team-only
intelligence; tier isolation is enforced in app code, with no DB backstop).
Rate limit: 60/min per key.

```json
{
  "member": "alex",
  "metric": "aem-individual",
  "date": "2026-06-19",
  "window_days": 1,
  "signals": {
    "delegation_ratio": 0.18,
    "correction_loop_avg": 1.4,
    "error_rate": 0.05,
    "cost_per_task": 0.42,
    "tokens_per_task": 31000,
    "cache_hit_rate": 0.71,
    "tool_diversity": 9.0,
    "verify_tool_rate": 0.22,
    "subagent_usage": 0.06
  },
  "provisional": { "spine": "L3", "axes": {
    "verification": 3.1, "context_hygiene": 3.8, "autonomy": 2.4,
    "learning": 3.0, "cost_governance": 3.6
  } },
  "ce_band": 3,
  "sessions": 41,
  "tasks": 137
}
```

- `member` is optional; it defaults to the authenticated key's member. A supplied `member`
  must match a member on the caller's team or the push is rejected.
- The point is keyed by `(team_id, member_id, date)` — idempotent: re-pushing the same day
  updates in place, no duplicate snapshot.
- `signals` are structural facts only (ratios + counts) — **no tool names, no branch, no cwd,
  no message text, no per-session detail**. Together with the coarse `ce_band` scalar and the
  `provisional` placement, these are the entire privacy surface.
- `ce_band` (v1.3, optional) is a single coarse **cognitive-ergonomics** band, integer `0`–`4`
  (higher = more protected attention — longer focus blocks, fewer interrupts, concurrency matched to
  the operator's own norm), scored client-side relative to the operator's own baseline and derived
  alongside `provisional`. It is provenance-only: the brain persists it verbatim and never recomputes
  it. Omitting it is valid; an older brain ignores it.
- `provisional` carries the **client-side** AEM placement (axes 0–4 + Spine `L1`–`L5`) computed by
  `scripts/analyze/aem.mjs`. The brain **recomputes the canonical** axis/Spine scores from
  `signals` server-side (`lib/metrics/individual-maturity.ts`) so team rollups have one authority; it
  persists `signals`, `provisional`, and `canonical`. Both scorers apply the Spine **verification
  gate** (cap at L3 when the Verification axis ≤ 1) identically — keep their thresholds in sync.

**Response:** `201 { "status": "ok", "snapshot_id": "uuid", "canonical": { "spine": "L3", "axes": { … } } }`

---

## External AI cost endpoint (W2.1)

> **Status:** Implemented (brain: `app/api/v1/costs/route.ts`, ingest `lib/costs/ingest.ts`;
> client: `aios analyze --push`). Team-tier only.

Records one day's external AI provider spend for a member, pushed from a workstation via
`aios analyze --push`. **Cursor** figures come from the billing dashboard API (authoritative USD).
**Claude** figures are token-based estimates from local session logs (`source: session-logs`).
This is a standalone analytics endpoint, **not** an `/items` kind.

### `POST /api/v1/costs` — daily provider spend

**Team-tier only** — an `external`-tier key gets `403 forbidden_tier`. Rate limit: 120/min per key.

```json
{
  "member": "john",
  "date": "2026-06-22",
  "provider": "cursor",
  "source": "dashboard-api",
  "project": "aios",
  "input_tokens": 17220546,
  "output_tokens": 1184106,
  "cache_read_tokens": 199447220,
  "cost_usd": 83.57,
  "events": 116,
  "meta": {
    "models": { "composer-2.5-fast": 40.69, "gpt-5.3-codex": 31.25 },
    "included_usd": 40.69,
    "overage_usd": 40.81
  }
}
```

- `provider`: `cursor` | `claude` | `anthropic` | `openai` | `codex` | `other`
- `source`: e.g. `dashboard-api` (Cursor billing) or `session-logs` (Claude estimate)
- `project`: optional contribution tag (default `aios` from CLI; empty string = untagged)
- Idempotent on `(team_id, member_id, date, provider, source, project)` — re-push updates in place.
- `meta` is opaque JSON for model breakdowns; no raw session content.

**Response:** `201 { "status": "ok", "cost_id": "uuid", "member_id": "uuid" }`

Dashboard: Admin → Usage shows brain spend + external provider spend combined.
