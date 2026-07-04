# Domain spec — Meetings (Granola ingestion, decisions, stakeholder map)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
Meetings are where decisions get made and where "who owns what" lives. The weekly closeout (C5) must catch unlogged decisions and surface a stakeholder picture; the loop relies on meeting-derived decisions as first-class signals.

## Reuse (shipped, KEEP)
- Granola source connector (sibling **aios-team-brain** repo: ingestion/aios_ingest/sources/granola.py, 319 LOC) — OAuth, auto transcript pull, webhook/scheduler triggers (brain PR #34).
- `transcript-decisions` harness — multi-agent extraction → decision-log rows with rubric-gated grounding.
- `granola-digest` skill (per-meeting + daily digest).

## Build (net-new clean TS)
- **Stakeholder map surface (AIO-141)**: surface the team-brain Company-Graph — **people, roles, and ownership** ("who owns domain X"), plus **meeting attendance derived from meeting items** ("who attended meeting Y"). Pairwise **who-met-whom graph edges are explicitly deferred** (the structured graph has no meeting entity / attendance edge — see the scoped subsection below).
- **Governance-nudge harness**: flag transcripts touching governance/compliance topics and draft a brief — rebuild the prior-build nudge *concept* clean (keyword/topic detection → drafted brief), not the legacy code. *(Separate build item; its own future issue.)*
- Normalize meeting decisions into tier-tagged signals for C1. *(Separate build item; its own future issue.)*

### Stakeholder map surface (AIO-141)

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
> Per-item acceptance is stated in each Build subsection. AIO-141's observable acceptance is in **[Stakeholder map surface (AIO-141) → Acceptance](#acceptance-aio-141--observable)**. The two items below are the *domain-level* acceptance for the still-deferred build items.
- Weekly closeout catches an unlogged decision from the week's transcripts (a `3-log/decision-log.md` row the transcripts imply but that is absent). *(Deferred build item.)*
- Governance-flagged meeting produces a drafted brief; decisions carry the correct tier (consented/sanitized) before any sync. *(Deferred build item.)*
