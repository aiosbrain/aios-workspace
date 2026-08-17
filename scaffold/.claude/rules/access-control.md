# Rule: Access Control & the `6-business/` sibling (business-owner context)

This rule extends `.claude/rules/frontmatter.md`'s tier model with a second,
structural layer of defense: some directories sit **outside** `aios.yaml`'s
`sync_include` entirely, regardless of any individual file's `access:` tag.

## The two layers

1. **Tag-level (per file):** `access:` frontmatter — `private`/`admin` (never
   syncs), `team` (syncs to the brain), `client`/`company`/`external` (syncs
   outward). Default-deny: untagged content never syncs. Full vocabulary:
   `.claude/rules/frontmatter.md`.
2. **Path-level (per directory):** `aios.yaml`'s `sync_include` lists which
   parts of the spine are even *considered* for sync. It is a whitelist of
   **paths**, not of whole folders — read your own `aios.yaml` literally rather
   than assuming a numbered folder is excluded because it sounds private. In
   the default scaffold:
   - **`5-personal/`** is outside it entirely, and named in `sync_exclude` too.
   - **`1-inbox/` is only PARTLY outside it: `1-inbox/transcripts` IS
     whitelisted.** A meeting transcript filed there is considered for sync, and
     once it carries a `team`-or-wider `access:` tag it leaves your machine.
     Raw inbox material you do not want pushed must stay out of
     `1-inbox/transcripts/`, or stay untagged / `private`.
   - **`3-log/` is partial**, not excluded: only `3-log/decision-log.md`,
     `3-log/tasks-team.md` and `3-log/ai-spend.md` are listed. The rest of
     `3-log/` — including `tasks-private.md`, `hours-log.md` and `time-log.md` —
     is outside the whitelist.

   **`6-business/`** (present only in **business-owner**-context workspaces) is
   the whole-root kind of exclusion — a sanctioned sibling root for running the
   business itself (bookkeeping, entities, engagements, insurance,
   administration, partnerships, portfolio), never client delivery.

## Rule: `6-business/` never syncs — never add it to `sync_include`

If your workspace was scaffolded with `--context business-owner`, it has a
`6-business/` directory alongside the 0-5 spine. It is deliberately kept
outside `sync_include` — a second layer beyond tags, per the reference
implementation this scaffold follows. **Never add `6-business` to
`sync_include`**, no matter what `access:` tag an individual file inside it
carries. Files there should default to `access: private` for clarity, but the
path-level exclusion is what actually protects them — don't rely on tagging
alone.

## What stays private, always

Bookkeeping/financials, contracts & legal, stakeholder profiles, cost models,
margins/P&L, and raw client intake belong in `6-business/` (or tagged
`private` if they must live elsewhere in the spine) — never in `team`- or
outward-tier content.

## Before generating non-private output

- Pull only from files tagged at or below the recipient's tier.
- Never surface financials, margins, cost models, or stakeholder profiles in
  `team`/outward-tier (`client`/`company`) content — check `6-business/` isn't
  the source of a fact before citing it outward.
