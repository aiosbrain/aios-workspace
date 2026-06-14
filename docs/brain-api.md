# AIOS Team Brain — API Contract

**Version: 1** (`/api/v1`). This document is the single pinned contract between the
contributor repo (this toolkit's `aios` CLI) and the `aios-team-brain` service. Both
sides build against this file; changes require a version bump and a matching change in
both repos. Treat any drift between this doc and either implementation as a bug.

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
- `POST /query`: 10/min per member; daily budgets enforced server-side

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

**Task rows** (parsed from `tasks.md` `| ID | Task | Assignee | Status | Sprint | Due |`):

```json
{ "row_key": "T-01", "title": "...", "assignee": "alex",
  "status": "in_progress", "sprint": "sprint-1", "due": "2026-03-27" }
```

Status values the client sends verbatim; the server normalizes to
`backlog|ready|in_progress|blocked|done` (unknown → `backlog`, raw value preserved).

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
                  "status": "ready", "sprint": "sprint-2", "due": null } ] }
  ],
  "next_cursor": null
}
```

Merge semantics on the client: match by `row_key`; update existing rows in place;
append unknown rows to the table; never delete local rows.

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

## Out of scope for v1

Hours sync; binary artifact upload (storage bucket); webhooks; bulk endpoints;
embedding-based retrieval (server may add it transparently — contract unchanged).

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
