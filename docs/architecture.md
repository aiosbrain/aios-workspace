# Architecture

AIOS is built around four ideas: a **two-repo model** (individual workspace ↔
Team Brain), a **context-driven numbered spine**, **access tiers** that travel
with the content, and **default-deny sync**.

## Two repositories

AIOS has exactly two kinds of repository, and conflating them is the most common
mistake:

- **The individual workspace** (this toolkit's output) — **one per person**. You
  work here. It holds your intake, your work, your logs, and your private notes.
  Nothing in it is shared until you deliberately push it.
- **The Team Brain** — the *one* shared service (its own repo: `aios-team-brain`)
  that receives everyone's pushes, stores tier-filtered content, and answers
  questions across the team. It is the only "team" layer.

```
        this toolkit (open source)
                 │ scaffold-project.sh --context …
   ┌─────────────┼─────────────┐
 alex-workspace  sam-workspace  …      ← individual workspaces (one per person)
   └──────┬──────┴──────┬──────┘
          │  aios push   │               (only tagged team/outward content)
          ▼              ▼
            AIOS Team Brain               ← the one shared hub
            (aios-team-brain)
```

The brain is the hub; each person's workspace is a spoke. A spoke only ever sends
content the person has explicitly tagged and pushed; the brain re-applies tier
filtering on retrieval so a query never returns content above the caller's ceiling.

## Access surfaces — how callers reach the brain

The brain has **one contract** ([`brain-api.md`](brain-api.md) v1) and **two ways to
reach it**, chosen by a single question: *does the calling agent have a shell?*

| Caller | Surface | Why |
|--------|---------|-----|
| Shell-capable agents (Claude Code, Codex, OpenCode, cron, CI) | the **`aios` CLI** — *primary, canonical* | faster, cheaper, no per-turn tool-schema cost; it owns the contract and the tier default-deny |
| Shell-less agents (Claude Desktop, Claude Cowork, Claude.ai, Conductor) | **`aios mcp`** — a stdio MCP server bridge | MCP is the only way an agent without a shell can call out; same contract, schema-described tools |

The MCP bridge (`scripts/brain-mcp.mjs`) is intentionally **thin and read-only**: it
wraps the v1 read endpoints (`query`, `projects`, `tasks`, `decisions`, `items`) and
re-uses the brain's server-side tier filtering as its safety boundary. It requires no
workspace — config is resolved env-first — so a Claude Desktop user with no scaffolded
repo can still query the team's shared memory. It never drives the contract: capability
lands in `brain-api.md` for product reasons, and both the CLI and the MCP bridge follow.

> Don't confuse this with BYOA. The **MCP bridge** decides which *AI surfaces* can reach
> the **brain**; the **runtime adapters** (`gui/server/runtime-adapters/`, `aios skills
> export`) decide which *agent runtimes* can run the **local harness**. Different lever,
> different layer. See the [MCP connector PRD](prd-team-brain-mcp-connector.md). <!-- maintainer-only:
> the deeper rationale lives in strategy/team-brain-access-strategy.md, which is removed at public
> release; this section is the release-safe summary, so don't add a hard link to it here. -->

> **This section is the public, release-safe summary of the access doctrine.** The full strategy
> brief (`strategy/team-brain-access-strategy.md`) is maintainer-only and is removed before public
> release — link *here*, not there, from public docs.

## Context-driven spine

At onboarding the individual answers one question — *consultant working in a team
for a client*, or *employee working inside a company* — and that selects the spine
skin. Both skins share one skeleton so the harnesses and validators stay generic;
only `0-context` and `4-shared` (and the tier labels) differ.

| # | Folder | Consultant skin | Employee skin | Default audience |
|---|--------|-----------------|---------------|------------------|
| 0 | context | charter, scope baseline + ledger | role, OKRs | team |
| 1 | inbox | raw inputs: transcripts, notes, from-brain | (same) | private |
| 2 | work | your deliverables and working docs | (same) | team |
| 3 | log | decision log, tasks, hours | (same) | private |
| 4 | shared | client-facing artifacts | company-wide artifacts | external |
| 5 | personal | your private workspace | (same) | private |

Numbers encode maturity: content flows from raw capture (low numbers) to refined,
outward-facing output (high numbers). Promotion is deliberate (see
`scaffold/.claude/rules/publishing.md`): personal draft → team work → shared, with
a review or approval at each step. Nothing is auto-promoted.

## Access tiers

Each file carries an audience tier in frontmatter. Friendly labels map to the
engine's canonical tiers (the brain and sync engine only ever see canonical):

| Friendly (consultant) | Friendly (employee) | Canonical | Behavior |
|---|---|---|---|
| `private` | `private` | `admin` | internal only — **never syncs**, never leaves the machine |
| `team` | `team` | `team` | the delivery team / department, via the brain |
| `client` | `company` | `external` | appropriate to share outward; recorded in `4-shared/` |

(`client`, `company`, and `external` are interchangeable on input — all normalize
to canonical `external`. See [`brain-api.md`](brain-api.md).)

Tiers are enforced in three places: the **guard hook** (`hooks/team-ops-guard.sh`)
blocks private/admin content from being written into team/shared directories, the
**validators** check that frontmatter is present and well-formed, and the **sync
client** (`scripts/aios.mjs`) default-denies anything not explicitly tiered within
`aios.yaml: sync_tiers` before a single byte goes over the network. On the Team
Brain side, retrieval is tier-filtered in SQL so a query never returns content
above the caller's ceiling.

## Why agent-native

The structure is plain folders of Markdown and YAML — readable by humans, diff-able in
git, and legible to an agent without any database. On top of that substrate, the
**dynamic-workflow harnesses** in `scaffold/.claude/skills/` do the operational heavy
lifting, spawning focused sub-agents with adversarial verification rather than asking
one context to do everything. See `docs/workflows.md`.

## Toolkit internals — module boundaries

How the `scripts/` and `gui/` code is layered. These boundaries hold today; keep them.

- **One brain HTTP front door.** All traffic to the Team Brain v1 API goes through
  `scripts/brain-client.mjs` (`createBrainClient` → `fetchJson`/`query`/`streamQuery`). Both the
  CLI (`scripts/aios.mjs`) and the MCP bridge (`scripts/brain-mcp.mjs`) use it; config resolution
  intentionally stays in each caller (the CLI walks the workspace, the bridge is env-first). Don't
  add ad-hoc `fetch()` to the brain elsewhere.
- **The sync gate is the safety boundary.** `buildPlan` in `scripts/aios.mjs` classifies every
  candidate file into push / blocked / clean and is the single place the tier rules
  (default-deny, admin-never-syncs, `sync_tiers`) are enforced before any network call. It is
  guarded by `test/sync-plan.test.mjs` (drives the real `aios status --json` and asserts the
  blocked outcomes). Tier normalization is single-sourced (`normalizeTier`).
- **The GUI server is a thin local gateway.** `gui/server/` binds `127.0.0.1` only, gates on a
  per-session token, and imports just catalog/connector/skill helpers from `scripts/`
  (`runtimes.mjs`, `gen-catalog.mjs`, `connector.mjs`, the `lock-*` helpers). It holds no sync
  logic and never calls `brain-client` — it stays a presentation/orchestration shell.
- **Validators + hooks are fail-closed.** `validation/validate-all.sh` (`set -euo pipefail`) and
  the PreToolUse `hooks/` exit non-zero on any violation; never weaken them to make a change pass.

### Known debt (deferred, post-release)

Recorded so it isn't mistaken for intent:

- `scripts/aios.mjs` is a ~2.3k-line monolith (CLI routing + push/pull domain logic + state). A
  later pass can extract `scripts/sync/` command modules without changing behavior.
- Small helpers (`sha256`, `die`, color output, git wrappers) are duplicated across several
  scripts; there is no shared `scripts/lib/` kernel yet (`relay-core.mjs` is the only current
  consolidation point). Extracting a thin kernel is deferred to avoid pre-release churn.
