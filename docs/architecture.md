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
