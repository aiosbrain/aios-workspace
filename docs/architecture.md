# Architecture

Agentic Team Ops is built around three ideas: a **hub-and-spoke** layout, a
**numbered spine** per engagement, and **access tiers** that travel with the content.

## Hub and spokes

A consulting practice runs one private **hub** and many **spokes**.

- **Hub** — the practice's private admin repo: every engagement's sensitive material
  (pricing, legal, strategy), plus the shared infrastructure that spawns and governs
  spokes. The hub is not part of this open-source project; this project is the
  *toolkit* a hub is built from.
- **Spoke** — one **team-ops repo per engagement**, shared with the delivery team (and,
  at the right tier, the client). A spoke is scaffolded from this project's
  `scaffold/` template and governed by the same rules and validators.

```
            this toolkit (open source)
                     │ scaffold-engagement.sh
        ┌────────────┼────────────┐
   acme-team-ops  globex-team-ops  …      ← spokes (one per client)
```

Cross-engagement isolation is enforced by repository boundaries: a collaborator on
one spoke cannot see another. The hub is the only place that sees across engagements.

## The numbered spine

Every engagement — and every person's private workspace inside it — uses the same
six-folder pipeline. Numbers encode maturity: content flows from raw capture (low
numbers) to refined, client-facing output (high numbers).

| # | Folder | Holds | Default audience |
|---|--------|-------|------------------|
| 00 | engagement | charter, scope baseline + ledger, roles | team |
| 01 | intake | raw inputs: transcripts, notes, reference | admin |
| 02 | deliverables | sprint-scoped team outputs | team |
| 03 | status | decision log, hours, tasks, ledgers | admin |
| 04 | client-surface | captain-approved, client-facing artifacts | client |
| 05 | personal | per-member private workspace (mirrors 00–04) | individual |

Promotion through the spine is deliberate (see `scaffold/.claude/rules/publishing.md`):
personal draft → team deliverable → client-surface, with a review or approval at each
step. Nothing is auto-promoted.

## Access tiers

Each file carries an audience tier in frontmatter (`access: admin | team | client`).
The tiers are a contract:

- **admin** — internal only (pricing, strategy, raw analysis).
- **team** — the delivery team.
- **client** — appropriate to share with the client; recorded in the client-surface
  log when it is.

Tiers are enforced in two places: the **guard hook** (`hooks/team-ops-guard.sh`) blocks
admin-only content from being written into team/client directories, and the
**validators** check that frontmatter is present and well-formed. A knowledge-base
layer (on the roadmap) filters retrieval by tier so an agent answering a question
never returns content above the caller's ceiling.

## Why agent-native

The structure is plain folders of Markdown and YAML — readable by humans, diff-able in
git, and legible to an agent without any database. On top of that substrate, the
**dynamic-workflow harnesses** in `scaffold/.claude/skills/` do the operational heavy
lifting, spawning focused sub-agents with adversarial verification rather than asking
one context to do everything. See `docs/workflows.md`.
