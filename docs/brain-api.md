# AIOS Team Brain — API Contract

**Version: 1.10** (`/api/v1`). This document is the single pinned contract between the
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
- *2026-07-09 — **v1.6**: documents shipped-but-undocumented surfaces found by the 2026-07-09
  audit; **no wire changes**. Adds: kind **`blueprint`** (team blueprint publish, over the existing
  `POST`/`GET /api/v1/items`); **`GET /api/v1/me`** (authenticated identity); **`POST
  /api/v1/actions`** (Organ 4 policy-governed actions); **`POST /api/v1/graph-query`** (Graphiti
  natural-language search, experiment); **`GET /api/v1/members`** (team roster + cross-tool
  identities); **`GET /api/v1/conversations`** and **`GET /api/v1/conversations/<id>`** (owned
  chat-thread history); **`GET /api/v1/identities/resolve`** (external-id → member resolution); and
  **`GET`/`POST`/`DELETE /api/v1/me/slack-token`** (the owner's personal Slack token, owner-only).
  Also adds the **`GET /api/v1/tasks` tier-scoping note** (an `external`-tier key sees only
  `audience: "external"` rows — the same row filter `/decisions` already documented) and
  **completes the rate-limit quick-reference table** with every implemented route's actual limit.
  Every endpoint above was already live in the shipped server before this revision; this closes the
  doc-vs-code gap, it does not open one.*
- *2026-07-10 — **v1.7**: added **`POST /api/v1/members/invite`** (admin-key member onboarding:
  creates/re-invites a member and best-effort **cascades invitations to the team's configured
  external tools** — Linear workspace invite, Slack join link, GitHub org invite). Contract-first:
  this section lands before the matching `aios-team-brain` implementation and the
  `aios member invite` CLI client. Additive — newer CLIs tolerate a `404` from an older brain.
  This is the first **role-gated endpoint** (admin-role key required) besides the blueprint
  publish; adds the `forbidden_role` error code. Section below.*
- *2026-07-10 — **v1.8**: added **`POST /api/v1/subscriptions`** (a member's flat AI-tool
  subscription — e.g. Claude Max 20× at $200/mo — distinct from per-token spend). The brain's
  Usage page separates three honest tiers: **subscriptions** (flat), **billed** metered spend
  (`source` ≠ `session-logs`), and **API-equivalent value** (token estimates, `source =
  session-logs`). Contract-first; additive — a newer CLI tolerates a `404` from an older brain.
  Section below.*
- *2026-07-13 — **v1.9**: added team-tier **`GET /api/v1/pm-sync/health`** projection
  observability and explicit **`GET /api/v1/tasks?all=1`** full-table reads. Plain `GET /tasks`
  remains the dashboard writeback feed. Additive — newer CLIs tolerate a `404` health endpoint.*
- *2026-07-14 — **v1.10**: added the contract-first AIOS-managed, read-only GitHub gateway:
  member connect/validate/status/disconnect/repository-discovery endpoints plus the server-only
  Executor lease, exact-call authorize/redeem, outcome, approval, and durable resume-claim
  contract. Additive — a newer workspace treats `404` as `managed_gateway_unavailable`, never
  falls back to a local/environment PAT, and leaves direct connector state unchanged.*

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

`deliverable` | `transcript` | `decision` | `task` | `artifact` | `skill` | `blueprint`

`decision` and `task` items are markdown files containing the canonical status tables
(`3-log/decision-log.md`; tasks live in one of `3-log/tasks-team.md`,
`3-log/tasks-private.md`, `5-personal/tasks.md`, or the legacy `3-log/tasks.md` — the
client classifies any `tasks*.md` basename as kind `task`). For these, the client also
parses table rows into `rows[]` so the brain can materialize structured entities. Only
`tasks-team.md` (or an equivalent `team`/`external`-tier file) is ever eligible to push —
`tasks-private.md` and `5-personal/tasks.md` are tier-blocked/outside `sync_include` by
design (AIO-364).

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

### Team blueprint (kind `blueprint`)

A team's selected tool set (which integrations/connectors the team uses, defined in the
dashboard's Team tab) is published as a single item:

- **`.aios/blueprint.json`** — kind `blueprint`, `frontmatter: { blueprint_version, published_by
  }`, `body` is the tool-selection JSON verbatim.
- **Role-gated, not just tier-gated.** `POST /api/v1/items` accepts `kind: "blueprint"` only from a
  `lead`/`admin`-role member key; a `member`-role key gets `403 forbidden` ("only a team lead or
  admin can publish the team blueprint"). This is the one item kind with a role check — every other
  kind is tier-gated only.
- Pull with `GET /api/v1/items?kinds=blueprint`; the client takes the most recently updated item.

Client commands: `aios push blueprint` (publish `.aios/team-blueprint.json`) and `aios pull
blueprint` (fetch → `.aios/blueprint.json`, merged locally by `connector.mjs` into each member's
per-tool config).

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

## `GET /api/v1/me` — authenticated identity

Returns the calling key's own member identity, role, and tier — no secrets. Lets a client
tailor its behavior without keeping a parallel roster: e.g. only `lead`/`admin` roles see the
team-blueprint publish surface (§ "Team blueprint" above), and `aios stakeholders` probes this
first and rejects **every** mode up front for a non-`team`-tier key, so a partial answer can
never leak from a later `/company-graph` or `/items` call.

**Request:** no body.

**Response `200`:**

```json
{ "actor": "alex", "role": "lead", "tier": "team", "team": "uuid" }
```

**Client-used:** yes — `aios whoami` and the tier probe in `aios stakeholders` (both in
`scripts/aios.mjs`), and the MCP surface (`scripts/brain-mcp.mjs`).

**Errors:** `401` invalid key/team. **Rate limit:** none (identity lookup only).

## Error envelope

All errors:

```json
{ "error": { "code": "string", "message": "human-readable", "request_id": "uuid" } }
```

Codes: `unauthorized` (401), `forbidden_tier` (422, admin content or managed-gateway tier
violation), `forbidden_role`
(403, endpoint requires a higher member role — v1.7), `invalid_payload` (422),
`payload_too_large` (413, >1 MB), `rate_limited` (429, with `Retry-After`),
`managed_gateway_unavailable` (client classification for an older Brain's 404),
`github_invalid_token`, `github_insufficient_permissions`, `github_connection_exists`,
`github_connection_not_found`,
`github_upstream`, `gateway_version_mismatch`, `gateway_blocked`, `gateway_approval_required`,
and `internal` (500).

## Rate limits

Complete per-route quick reference (every route below carries its own per-key fixed-window
limit; `internal` server errors degrade to a bounded in-process fallback rather than opening
the gate — see `lib/api/rate-limit.ts`):

- `POST /items`: 120/min per key
- `GET /items`, `GET /tasks`, `GET /pm-sync/health`: 60/min per key
- `GET /decisions`, `GET /projects`: 60/min per key
- `GET /integrations`: 60/min per key
- managed GitHub `connect`: 10/min per member; `validate`: 20/min; `status`: 60/min;
  `disconnect`: 10/min; repository discovery: 30/min
- `GET /company-graph`: 60/min per key
- `POST /query`: 10/min per member; daily budgets enforced server-side
- `POST /metrics`: 60/min per key
- `POST /work-events`: 60/min per key
- `POST /costs`: 120/min per key
- `POST /codebases`: 60/min per key
- `GET /okf-bundle`: 30/min per key (`include_body=true`: 10/min per key)
- `GET /me`: none (identity lookup only)
- `POST /actions`: 60/min per key
- `POST /graph-query`: 30/min per key
- `GET /members`: 60/min per key
- `POST /members/invite`: 10/min per key
- `GET /identities/resolve`: 120/min per key
- `GET /conversations`, `GET /conversations/<id>`: none (owner-scoped reads)
- `GET /me/slack-token`: 60/min per key; `POST /me/slack-token`: 20/min per key;
  `DELETE /me/slack-token`: none

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

**Task rows** (parsed from a `tasks*.md` file's `| ID | Task | Assignee | Status | Sprint | Due |`;
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
CLI can merge them into the local `3-log/tasks-team.md` (or the legacy `3-log/tasks.md`
for a workspace that hasn't migrated to the three-home split — AIO-364). **Tier-scoped:** an `external`-tier key
receives only `audience: "external"` rows — via the `visibleTasks` choke-point in
`lib/auth/visibility.ts`, the same file and pattern as the `visibleDecisions` choke-point that
gates `GET /api/v1/decisions` below, applied to the `tasks` table's inherited `audience` column
(sourced from the task's originating item's `access`).

This plain endpoint is the dashboard **writeback feed**, not a complete task-table read. Pass
`?all=1` for the explicit tier-filtered full read (up to the endpoint's 500-row bound). The
response declares `mode: "writeback"` or `mode: "table"` so callers cannot confuse the two.

```json
{
  "mode": "writeback",
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

## `GET /api/v1/pm-sync/health?limit=<N>` — projection observability (team-tier only)

Returns derived projection health plus the most recent projection runs. `limit` defaults to 10
and is clamped to 1–50. The health status is `never_run`, `ok`, `stale`, or `failed`; `lastRun`
is null only before the first projection. An `external`-tier key gets `403 forbidden`. Rate limit:
60/min per key. Clients **MUST tolerate `404`** from a pre-v1.9 brain.

```json
{
  "health": { "status": "ok", "ageMs": 42000, "lastRun": { "ok": true, "created": 2, "unchanged": 1, "error_count": 0, "finished_at": "2026-07-13T00:00:00Z" } },
  "runs": []
}
```

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
> hand-write `ui-*` keys in a `tasks*.md` file / `decision-log.md`, so a round-tripped UI row keeps a
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

> **Server-only; no toolkit client currently calls this.** `aios-workspace` has no caller for
> this endpoint in `scripts/aios.mjs`, `scripts/brain-mcp.mjs`, or `scripts/connector.mjs` as of
> the 2026-07-09 audit — team blueprint pull (`.aios/blueprint.json`, kind `blueprint` above)
> covers the equivalent client need today. Document-or-deprecate is an open question for John,
> flagged in the PR body rather than decided here.

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

## Managed GitHub gateway (v1.10, contract-first)

These endpoints are the workspace-facing lifecycle for the AIOS-managed, read-only GitHub pilot.
They are additive and may not be deployed yet. The exact seven-tool registry and trust boundaries
are pinned in
[`prd-executor-mcp-gateway.md`](./prd-executor-mcp-gateway.md) and
[`architecture/executor-credential-gateway.md`](./architecture/executor-credential-gateway.md).

### Common authorization and tier behavior

All member-facing endpoints use the normal bearer key and `X-AIOS-Team`. The authenticated key
must resolve to an active member in that team and the request tier must be exactly `team`.
`external`, `admin`, a missing tier, cross-team/member identity, or tier elevation returns:

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{"error":{"code":"forbidden_tier","message":"Managed GitHub requires team tier","request_id":"uuid"}}
```

That rejection occurs before connection or credential lookup. Its body and logs contain no
credential existence hint. The PAT is admin-secret material despite the member-scoped operation:
it is accepted only into Brain's credential boundary, encrypted server-side, and never returned,
logged, synchronized, or included in an error.

### `POST /api/v1/integrations/github/connect`

Creates the authenticated member's managed connection. A member has at most one active managed
GitHub connection per team in the pilot.

```json
{
  "access": "team",
  "credential": "<write-only-fine-grained-token>",
  "repository_selection": "selected",
  "repositories": ["owner/repo"],
  "correlation_id": "uuid"
}
```

- `credential` is required, write-only, and never echoed. Classic PAT prefixes are rejected.
- `repository_selection` is `selected` or `all_accessible`; `repositories` is required and
  non-empty only for `selected`, with at most 100 unique `owner/repo` values.
- The server validates the current GitHub identity, selected repositories, and the four read-only
  permission labels before activating the connection. Validation cannot invoke a write endpoint.
- The request does not accept Executor tenant, subject, owner, member, or connection identifiers.
  Brain resolves the active member's self-host Executor member-key/subject binding server-side and
  attests it against the authenticated gateway service/environment before persisting the managed
  connection. Missing, ambiguous, stale, or mismatched attestation fails closed before PAT
  validation or persistence; a member-supplied identifier can never establish ownership.

**Response `201`:**

```json
{
  "connection": {
    "id": "opaque-connection-ref",
    "mode": "managed",
    "status": "connected",
    "github_login": "octocat",
    "repository_selection": "selected",
    "repositories": ["owner/repo"],
    "permissions": {
      "metadata": "read",
      "contents": "read",
      "issues": "read",
      "pull_requests": "read"
    },
    "validated_at": "2026-07-14T00:00:00.000Z",
    "credential_expires_at": null
  }
}
```

The response has no credential, ciphertext, secret reference, lease, or header. A duplicate active
connection is `409 github_connection_exists`; callers validate or disconnect rather than overwrite.

**Errors:** `401 unauthorized`; `409 github_connection_exists`; `422 forbidden_tier`,
`invalid_payload`, `github_invalid_token`, or `github_insufficient_permissions`; `429`; `502
github_upstream`; `503 gateway_version_mismatch`. Validation failure deletes or revokes the
unactivated encrypted candidate and returns only a non-secret classification.

### `POST /api/v1/integrations/github/validate`

Revalidates the active member connection without accepting or returning a PAT.

```json
{ "access": "team", "correlation_id": "uuid" }
```

**Response `200`:** the same non-secret `connection` object as connect, with refreshed
`status`, `github_login`, repository selection, permission labels, `validated_at`, and optional
credential expiry. `status` is `connected`, `degraded`, `revoked`, or `disabled`.

**Errors:** `401`; `404 github_connection_not_found`; `422 forbidden_tier`; `429`; `502
github_upstream`; `503 gateway_version_mismatch`. An expired/revoked credential returns `200` with
`status: "revoked"` when GitHub provides a conclusive auth result; transport ambiguity returns the
typed upstream error and does not change a previously connected status to revoked.

### `GET /api/v1/integrations/github/status?access=team`

Returns only non-secret lifecycle state and the last validation summary.

**Response `200`:**

```json
{
  "connection": {
    "id": "opaque-connection-ref",
    "mode": "managed",
    "status": "connected",
    "github_login": "octocat",
    "repository_selection": "selected",
    "repositories": ["owner/repo"],
    "permissions": {
      "metadata": "read",
      "contents": "read",
      "issues": "read",
      "pull_requests": "read"
    },
    "validated_at": "2026-07-14T00:00:00.000Z",
    "credential_expires_at": null,
    "gateway": {
      "executor_version": "1.5.33",
      "companion_version": "semver",
      "contract_version": "1.10"
    }
  }
}
```

**Errors:** `401`; `404 github_connection_not_found`; `422 forbidden_tier`; `429`.

### `DELETE /api/v1/integrations/github`

Idempotently disconnects the authenticated member. Request body:

```json
{ "access": "team", "correlation_id": "uuid" }
```

Brain revokes the connection and secret reference, invalidates unconsumed leases, denies pending
approvals, and settles resumable executions before responding. Immutable audit/execution records
remain. No PAT is exported.

**Response `200`:**

```json
{
  "disconnected": true,
  "connection_id": "opaque-connection-ref-or-null",
  "revoked_leases": 2,
  "settled_approvals": 1,
  "settled_executions": 1
}
```

An already-absent connection returns `200` with `connection_id: null` and zero counts.

**Errors:** `401`; `422 forbidden_tier`; `429`; `500 internal`. An internal failure is
transactional: the endpoint never reports success after only partial revocation.

### `GET /api/v1/integrations/github/repositories?access=team&cursor=<opaque>&limit=<N>`

Discovers repositories visible through the active member credential. `limit` defaults to 30 and is
capped at 100. The server uses fixed GitHub repository-list endpoints; arbitrary URLs, methods,
queries, and search are not accepted.

**Response `200`:**

```json
{
  "repositories": [
    {
      "full_name": "owner/repo",
      "private": true,
      "default_branch": "main",
      "archived": false
    }
  ],
  "next_cursor": null
}
```

No repository content, PAT, lease, upstream Authorization header, or GitHub response headers are
returned.

**Errors:** `401`; `404 github_connection_not_found`; `422 forbidden_tier` or
`invalid_payload`; `429` (including a bounded translation of GitHub rate limiting); `502
github_upstream`; `503 gateway_version_mismatch`.

### Older-Brain compatibility

A v1.10 workspace **must tolerate `404`** for each managed endpoint. It classifies an endpoint-level
404 as `managed_gateway_unavailable`, tells the member the Team Brain must be upgraded, and makes no
state change. It must not reinterpret that 404 as a missing connection, fall back to a workspace
`.env`/environment/file PAT, register a direct GitHub connector, or overwrite an existing direct
connector. A route that exists and returns the typed `github_connection_not_found` remains the
normal not-connected state.

## Executor gateway server contract (v1.10, server-only)

These routes are not workspace/sync endpoints. They are authenticated with a rotated, hashed
`GatewayServiceIdentity`, bind one deployment environment, and are never callable with a member
API key. Requests and responses use JSON over TLS. Every route rejects an Executor/companion/
contract version mismatch before lease or credential work.

The server-only types are `GatewayServiceIdentity`, `ExecutorSubjectBinding`,
`GatewayConnectionRef`, `ResolutionLease`, `GatewayPolicyRule`, `GatewayExecution`,
`GatewayApproval`, `AuthorizeDecision`, and `ExecutionOutcome`.

### `POST /api/internal/executor-gateway/v1/resolve-lease`

```json
{
  "executorTenantId": "opaque-tenant",
  "executorSubjectId": "opaque-subject",
  "connectionRef": "opaque-connection-ref",
  "correlationId": "uuid"
}
```

**Response `200`:**

```json
{
  "lease": "opaque-one-use-value",
  "expiresAt": "2026-07-14T00:00:30.000Z"
}
```

The public Executor `CredentialProvider.get(id)` returns this envelope. The stored lease is hashed,
one-use, audience-bound, and expires after 30 seconds. Neither request nor response contains a PAT.
Identity/tier/revocation failures return a typed non-secret error before credential lookup.

### `POST /api/internal/executor-gateway/v1/authorize-and-redeem`

```json
{
  "lease": "opaque-one-use-value",
  "toolkit": "aios-github-readonly",
  "tool": "github.repository.get",
  "normalizedArgs": { "owner": "owner", "repo": "repo" },
  "requestHash": "sha256-hex",
  "correlationId": "uuid",
  "idempotencyKey": "opaque"
}
```

Brain rebinds active service/team/member/Executor subject/connection/provider and verifies the
server-computed normalized arguments hash. The response is exactly one tagged union:

```json
{ "decision": "block", "code": "policy_denied", "executionId": "uuid" }
```

```json
{
  "decision": "require_approval",
  "executionId": "uuid",
  "approvalId": "uuid",
  "expiresAt": "2026-07-14T00:15:00.000Z"
}
```

```json
{
  "decision": "allow",
  "executionId": "uuid",
  "sealedCredential": "v1.<opaque-aead-envelope>",
  "credentialExpiresAt": null
}
```

Block and approval contain no credential. Allow is returned only after the immutable decision
audit insert commits and consumes the lease. `sealedCredential` is an opaque authenticated AEAD
envelope bound to both `executionId` and the authenticated gateway service identity. Only the host
companion may open it immediately before the one permitted GitHub request; it destroys the
request-local plaintext and envelope reference immediately afterward. Neither form may enter the
sandbox, persistence, logs, MCP, errors, or outcome.

### `POST /api/internal/executor-gateway/v1/record-outcome`

```json
{
  "executionId": "uuid",
  "correlationId": "uuid",
  "classification": "success",
  "upstreamStatusClass": "2xx",
  "responseBytes": 1234
}
```

The classification is one of `success`, `blocked`, `approval_required`, `credential`, `network`,
`upstream`, `response_too_large`, or `internal`. No result body, raw arguments, headers, lease, or
credential is accepted. Outcome recording never authorizes a call.

### `POST /api/internal/executor-gateway/v1/approvals/{approvalId}/decision`

Admin-authorized request:

```json
{ "decision": "approved", "approverMemberId": "uuid", "correlationId": "uuid" }
```

`decision` is `approved` or `denied`. The transition is append-only/audited and fails for settled,
expired, wrong-team, or stale-policy approvals. Approval expiry is 15 minutes.

### `POST /api/internal/executor-gateway/v1/executions/{executionId}/resume-claim`

```json
{
  "executorTenantId": "opaque-tenant",
  "executorSubjectId": "opaque-subject",
  "toolkit": "aios-github-readonly",
  "correlationId": "uuid",
  "idempotencyKey": "opaque"
}
```

The transaction rebinds identity/policy, takes the writer-honored exclusive claim, and returns one
of:

```json
{
  "status": "claimed",
  "executionId": "uuid",
  "tool": "github.repository.get",
  "normalizedArgs": { "owner": "owner", "repo": "repo" },
  "sealedCredential": "v1.<opaque-aead-envelope>"
}
```

```json
{ "status": "settled", "executionId": "uuid", "result": "already_claimed" }
```

```json
{ "status": "blocked", "executionId": "uuid", "code": "expired_or_revoked" }
```

Only `claimed` can contain `sealedCredential`, and only after strict audit. It has the same
execution-and-service AEAD binding and companion-only request-local open/destruction contract as an
initial allow. Concurrent claims produce one `claimed`; every loser is safely `settled`. The
encrypted request envelope and approval state are Brain-owned, so `aios_gateway.resume` works after
a full Executor restart.

### Internal failure and audit rules

Resolver, authorization, strict-audit, credential decryption, stale policy/version, revoke/expiry,
and replay failures are distinct and fail closed. `external`/`admin`, cross-team/member/subject, or
tier elevation returns HTTP `422 forbidden_tier` before credential lookup and makes zero GitHub
requests. Audit metadata is allowlisted to IDs, bindings, toolkit/tool, argument hash, policy and
decision references, correlation/idempotency, timing, upstream status class/byte count, and a
non-secret outcome classification. It excludes the PAT, `sealedCredential`, lease, headers, raw
normalized arguments, request envelope plaintext, GitHub body, and repository/issue/PR content.

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

---

### `POST /api/v1/subscriptions` — flat AI-tool subscription (v1.8)

**Team-tier only** — an `external`-tier key gets `403 forbidden_tier`. Rate limit: 60/min per key.

A member's **flat** monthly subscription to an AI tool (Claude Max/Pro, Cursor, …). This is the
real recurring spend, **distinct from per-token usage** (`/costs`): subscription usage is not billed
per token, so a token estimate is a *value* signal, never the bill. Pushed by `aios analyze --push`
from the detected plan (or `.aios/cost-config.json` override).

```json
{
  "member": "john",
  "provider": "claude",
  "plan": "max_20x",
  "monthly_usd": 200,
  "source": "config"
}
```

- `provider`: `cursor` | `claude` | `anthropic` | `openai` | `codex` | `other`
- `plan`: free-form plan key (e.g. `max_20x`, `pro`, `custom`)
- `monthly_usd`: flat recurring cost, `>= 0`
- `source`: how it was determined — `config` (override) | `keychain` (detected) | `manual`
- Idempotent on `(team_id, member_id, provider)` — re-push updates the current plan in place.

**Response:** `201 { "status": "ok", "subscription_id": "uuid", "member_id": "uuid" }`

Dashboard: Admin → Usage shows subscriptions (flat) separately from billed spend and API-equivalent
value.

---

## Action layer endpoint (Organ 4, extension)

> **Status:** Implemented (brain: `app/api/v1/actions/route.ts`, `lib/actions/`, policy engine
> `lib/policy/`). **No `aios-workspace` client calls this today** — server-only from this
> repo's point of view. It is the entry point an agent runtime uses to ask the brain to perform
> a policy-governed operation on a member's behalf.

### `POST /api/v1/actions` — request a policy-governed action

The principal is always the authenticated key's member, treated as role `member` for policy
purposes (agents act *on behalf of* a member; privilege is granted by policy matching
actor/tier, never inherited from the caller's own dashboard role).

```json
{ "type": "note.create", "resource": "project:northwind-aios/*", "params": { "text": "..." } }
```

- `type` — the action id, matched against both the handler registry and policy rules (built-in
  handlers today: `note.create`, `code.run`).
- `resource` — the policy match target (e.g. `project:<slug>/*`); defaults to `*`.
- `params` — handler-specific arguments.

**Server semantics (normative):**

1. The request is recorded first (`actions` table, `status: "requested"`), before authorization
   — every request leaves an audit trail even if denied.
2. The policy engine (`lib/policy`) authorizes `{ principal, action: type, resource }` and
   returns one of `allow` / `deny` / `require_approval`.
3. `deny` → the action is marked `denied` and the response is `403`. `require_approval` → an
   `approval_requests` row is filed and the response is `202` with `status: "pending_approval"`;
   a human resolves it out-of-band (dashboard). `allow` → the matching handler executes.
4. `code.run` executes inside an isolated sandbox (E2B microVM) when `E2B_API_KEY` is
   configured; with no sandbox wired, `code.run` **fails closed** (`status: "failed"`), it never
   runs unsandboxed.
5. Every transition (denied / pending_approval / succeeded / failed) is audit-logged.

**Response:** `200` on `succeeded`, `202` on `pending_approval`, `403` on `denied`, `422` on
`failed`:

```json
{
  "actionId": "uuid",
  "status": "succeeded",
  "decision": "allow",
  "result": { "output": {} }
}
```

**Errors:** `401` invalid key/team; `422 invalid_payload` malformed request; `403` denied by
policy; `429` rate-limited. **Rate limit:** 60/min per key.

---

## Graph-memory query endpoint (extension)

> **Status:** Implemented (brain: `app/api/v1/graph-query/route.ts`, `lib/graph/graphiti-client.ts`).
> **No `aios-workspace` client calls this today** — server-only from this repo's point of view.
> An experiment alongside `POST /api/v1/query`: a lower-level, structured-facts NL search
> against the Graphiti temporal-knowledge-graph memory, versus `/query`'s prose-answer SSE
> stream over the brain's own item store.

### `POST /api/v1/graph-query` — natural-language search over Graphiti graph memory

```json
{ "query": "What did we decide about governance review gates?" }
```

Body accepts `query` (1–2000 chars, required) and `maxFacts` (1–100, optional, default 20).

**Server semantics (normative):**

1. Tier-enforced by scoping to the `group_id`s the caller's tier may see
   (`visibleGroupIds(teamSlug, memberTier)`) — Graphiti itself has no tier awareness, so this
   scoping is the **sole** isolation boundary (same posture as `/company-graph`, `/metrics`,
   `/costs`, `/codebases`, `/projects`: app-code gate, no DB/RLS backstop).
2. `503 not_configured` if `GRAPHITI_URL` is unset — this is an optional subsystem, not a
   contract requirement.
3. Every query is audit-logged (`graph.query`) with tier, group count, and result count.

**Response `200`:**

```json
{
  "facts": [
    {
      "uuid": "...",
      "fact": "the governance review gate requires two approvers",
      "valid_at": "2026-06-18T00:00:00Z",
      "invalid_at": null,
      "source_node_name": "...",
      "target_node_name": "..."
    }
  ]
}
```

**Errors:** `401` invalid key/team; `422 invalid_payload`; `503 not_configured` (Graphiti not
wired); `502` on a Graphiti request failure; `429` rate-limited. **Rate limit:** 30/min per key.

---

## Team roster & identity-resolution endpoints (extension)

> **Status:** Implemented (brain: `app/api/v1/members/route.ts`,
> `app/api/v1/identities/resolve/route.ts`, `lib/identity/`). **No `aios-workspace` client calls
> either endpoint today** — server-only from this repo's point of view. Both exist so an
> external tool that needs "how do I reach teammate X" (e.g. a Hermes comms agent, or the
> `slack` CLI's teammate resolver) can read the single source of truth instead of keeping a
> parallel contact list.

### `GET /api/v1/members` — team roster with cross-tool identities

**Team-tier only** — an `external`-tier key gets `403 forbidden_tier` (the roster is team
metadata). Optional query filters: `?email=<addr>` (exact roster email), `?handle=<handle>`
(exact `actor_handle`), `?provider=<p>` (only members with an identity for that provider,
narrowing each member's `identities` to that provider).

**Response `200`:**

```json
{
  "members": [
    {
      "id": "uuid", "email": "alex@…", "display_name": "Alex", "actor_handle": "alex",
      "github_login": "alexgh", "avatar_url": "https://…", "role": "lead", "tier": "team",
      "identities": [{ "provider": "slack", "externalId": "U…" }],
      "email_aliases": []
    }
  ]
}
```

`github_login`/`avatar_url` are populated by the admin GitHub sync (used by e.g. `aios
timeline` to resolve avatars from the brain before falling back to GitHub's public CDN).

**Errors:** `401`; `403 forbidden_tier` (non-team key); `429`. **Rate limit:** 60/min per key.

### `GET /api/v1/identities/resolve` — resolve an external identifier to a member

**Team-tier only.** Exactly one resolution input is required:
`?provider=<p>&external_id=<id>` (a provider user id, e.g. `provider=slack&external_id=U…`),
`?email=<addr>` (roster email or alias), or `?handle=<handle>` (`actor_handle`).

**Response `200`:**

```json
{
  "member": {
    "id": "uuid", "email": "alex@…", "display_name": "Alex", "actor_handle": "alex",
    "github_login": "alexgh", "role": "lead", "tier": "team"
  },
  "identities": [{ "provider": "slack", "externalId": "U…" }],
  "email_aliases": [],
  "slack_id": "U…"
}
```

`slack_id` is a convenience field (the Slack identity's `externalId`, or `null`) for the
`slack` CLI's resolver.

**Errors:** `401`; `403 forbidden_tier` (non-team key); `400 bad_request` (no/ambiguous
resolution input, or `external_id` without `provider`); `404 not_found` (nothing resolves);
`429`. **Rate limit:** 120/min per key.

---

## Member invite endpoint (v1.7)

> **Status:** contract-first — this section lands before the matching `aios-team-brain`
> implementation and the `aios member invite` CLI client. Clients MUST tolerate a `404`
> from an older brain (the standard forward-compat rule) and degrade to "invite from the
> dashboard's `/admin/members` page instead."

### `POST /api/v1/members/invite` — invite a member + tool cascade

Creates (or re-invites) a member on the caller's team, issues their Team Brain sign-in
(magic-link email when mail delivery is configured, otherwise a manual password), and
**best-effort cascades invitations to the team's configured external tools** — a Linear
workspace invite, a Slack join link, and a GitHub org invite. One trigger, every tool.

**Admin-key only (role-gated):** the authenticated key's member must have **role `admin`**
and **tier `team`**; any other key gets `403 forbidden_role`. This is the same trust level
as the dashboard's `/admin/members` invite surface. Rate limit: **10/min per key**.

**Request:**

```json
{
  "email": "riley@example.com",
  "display_name": "Riley Chen",
  "actor_handle": "riley",
  "role": "member",
  "tools": "all"
}
```

- `email`, `display_name`, `actor_handle` — required (`role` defaults to `member`;
  values `member|lead|admin`).
- `tools` — optional: an array drawn from `"linear" | "slack" | "github"`, or the strings
  `"all"` (default) / `"none"`. Unknown tool names are rejected `422 invalid_payload`
  (the tool vocabulary is versioned here; new tools are additive).

**Response `200`:**

```json
{
  "member": { "id": "uuid", "email": "riley@example.com", "status": "invited", "created": true },
  "invite": { "mode": "magic-link", "email_delivered": true },
  "provisioning": [
    { "tool": "linear", "status": "sent",          "detail": "" },
    { "tool": "slack",  "status": "link_provided", "detail": "standing workspace join link; acceptance is not verified", "invite_link": "https://join.slack.com/t/…" },
    { "tool": "github", "status": "failed",        "detail": "token needs admin:org scope" }
  ]
}
```

- `invite` is one of:
  - `{ "mode": "magic-link", "email_delivered": bool, "login_url": "…"? }` — `login_url`
    (the one-click sign-in link, 7-day TTL) is included **only when `email_delivered` is
    `false`**, so the admin can share it out-of-band; when the email went through, the
    credential stays out of the response.
  - `{ "mode": "manual", "password": "…", "invite_message": "…" }` — mail delivery isn't
    configured on this brain; `invite_message` is the complete ready-to-paste invite
    (URL + email + password). Shown once; the brain stores only the hash.
- `provisioning[]` has one entry per **requested** tool. Statuses:
  - `sent` — the external service accepted the invite (it emails the invitee itself).
  - `link_provided` — no invite API exists for this tool/plan (e.g. Slack Free/Pro); the
    brain returns the team's standing join link in `invite_link` and includes it in the
    invite email's "Your team tools" section.
  - `skipped` — nothing to do: the tool isn't configured for the team, or the person is
    already a member / already invited there. `detail` says which.
  - `failed` — the attempt errored; `detail` carries the actionable reason verbatim.

**Server semantics (normative):**

1. **Idempotent on `(team_id, email)`.** An existing member returns `created: false`,
   re-issues the sign-in link (or manual credentials), and re-runs provisioning for the
   requested tools — safe re-invite, bounded by the rate limit.
2. **Provisioning is best-effort and never blocks the brain invite.** A tool failure is
   reported in `provisioning[]`, never as a non-200 response. The brain persists the
   latest per-tool outcome (surfaced on `/admin/members` with a retry affordance).
3. Tool credentials/config come from the brain's **Admin → Integrations** settings
   (Linear API key + default team ids, Slack standing join link, GitHub org + token) and
   never appear in this response beyond the shareable `invite_link`.
4. Every invite and per-tool outcome is audit-logged.

**Client:** `aios member invite <email> --name <display name> --handle <handle>
[--role member|lead|admin] [--tools linear,slack,github|all|none]`, plus `aios member list`
over the existing `GET /api/v1/members` roster read.

**Errors:** `401`; `403 forbidden_role` (key's member isn't a team-tier admin);
`422 invalid_payload` (bad email, missing fields, unknown tool); `429`.
**Rate limit:** 10/min per key.

---

## Conversation history endpoints (extension)

> **Status:** Implemented (brain: `app/api/v1/conversations/route.ts`,
> `app/api/v1/conversations/[id]/route.ts`, `lib/chat/store.ts`). **No `aios-workspace` client
> calls either endpoint today** — server-only from this repo's point of view. These are the
> API-key-authed machine twin of the session-authed dashboard chat list: they let a CLI or a
> Telegram-via-Hermes bot list and resume the same threads a member creates via `POST
> /api/v1/query`'s optional `conversation_id`.

### `GET /api/v1/conversations` — the caller's own chat threads

Owner-scoped to the authenticated key's member — there is no cross-member listing over this
endpoint.

**Response `200`:** `{ "conversations": [ { "id": "uuid", "title": "...", "updated_at": "ISO8601", ... } ] }`

### `GET /api/v1/conversations/<id>` — one thread's full message history

Owner-only: `404 not_found` if the conversation isn't owned by the caller's member or doesn't
exist (never `403` — existence isn't distinguishable from non-ownership).

**Response `200`:** the conversation object with its full message history.

**Errors:** `401`; `404 not_found` (by-id route only). **Rate limit:** none on either route
(owner-scoped reads, no per-route `rateLimit()` call in the current implementation).

---

## Personal Slack token endpoint (extension)

> **Status:** Implemented (brain: `app/api/v1/me/slack-token/route.ts`,
> `lib/member-secrets/manage.ts`). **No `aios-workspace` client calls this today** — server-only
> from this repo's point of view; it exists for an agent runtime (e.g. Hermes) to fetch or set
> the owning member's own Slack **user** token ("act as me"), the personal counterpart to the
> team's read-only Slack ingestion (`POST /api/v1/integrations` type `slack`, config-only).

### `GET`/`POST`/`DELETE /api/v1/me/slack-token`

Owner-only **by construction**: the member id is always `auth.memberId` from the authenticated
key, never a request parameter — a key can only ever read or write its own token. The token is
stored encrypted at rest (`member_secrets`) and every response carries `Cache-Control: no-store`.

- **`GET`** → `{ connected: true, token, slack_user_id, workspace }`, or `404 { connected: false,
  error: "not_connected" }` if none is stored. The agent fetches its own token to act as the
  member.
- **`POST { token }`** → validates the token is a Slack **user** token (`xoxp-` prefix), calls
  Slack's `auth.test` to confirm it's live, stores it encrypted, and best-effort captures the
  member's Slack identity (so `slack dm --member` / `identities/resolve` work afterward). A token
  without the `xoxp-` prefix is rejected `400 bad_request`; a well-formed token that Slack's
  `auth.test` rejects is `422 invalid_token`. This is the manual-paste path; a one-click OAuth
  path also exists at `/api/auth/slack/start` (session-authed dashboard route, outside this
  API-key contract).
- **`DELETE`** → disconnects (`{ ok: true, connected: false }`); always succeeds, no rate limit.

**Errors:** `401`; `400 bad_request` (malformed body / wrong token prefix); `422 invalid_token`
(Slack rejected it); `429` (`GET`/`POST` only). **Rate limit:** `GET` 60/min per key, `POST`
20/min per key, `DELETE` none.
