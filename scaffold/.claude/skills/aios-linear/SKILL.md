---
name: aios-linear
description: Manage the AIOS Linear board (the ONLY PM tool — Plane is retired). Use whenever updating, reading, or commenting on AIOS Linear issues (identifiers like AIO-72, AIO-75), the brain→PM projection-tracking epic, or the backlog. Triggers on "update AIO-NN", "the Linear board", "the AIOS board", "projection tracking issue", "/aios-linear". Provides a terse `linear.mjs` CLI so issue edits are one fast command instead of ad-hoc GraphQL one-liners. DO NOT use the Plane MCP for AIOS work — it is retired and its tools return huge irrelevant payloads.
version: 1.1.0
access: team
triggers:
  - update AIO-
  - Linear board
  - AIOS board
  - projection tracking
  - /aios-linear
---

# AIOS Linear board

**Linear is the single source of PM truth for AIOS (Plane retired 2026-06-22).** Do not touch Plane (no `mcp__plane__*`, no dual-board updates). The brain `tasks` table projects one-way into Linear.

## Use the script, not ad-hoc GraphQL

The CLI ships with this skill at `.claude/skills/aios-linear/linear.mjs`. Run it from the workspace root with `LINEAR_API_KEY` in `.env` (dotenvx-encrypted):

```bash
LIN="dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs"

$LIN get AIO-75                 # one line: identifier, title, state, id
$LIN get AIO-75 --full         # + url + description + comments (ship parity)
$LIN template aios              # print issue scaffold
$LIN create "My slice" --template aios --state Triage
$LIN set-desc AIO-75 spec.md   # replace description from a file
$LIN patch-desc AIO-75 patch.md  # SEARCH/REPLACE blocks — partial update
$LIN set-state AIO-75 "In Progress"
$LIN set-priority AIO-75 high
$LIN relations AIO-75
$LIN blocks AIO-73 AIO-75
$LIN comment AIO-75 "done"
$LIN list AIO
```

For a long description, write it to a temp file first, then `set-desc <IDENT> <file>` — avoids quoting hell.

### Pick-up-able issue template

Author specs with the canonical template in `docs/agentic-ergonomics/aios-issue-template.md`:

1. `aios spec init draft.md --title "…"` or `$LIN template aios > draft.md`
2. Fill sections → `aios spec eval draft.md` until `SPEC_READY`
3. `$LIN set-desc AIO-n draft.md` or `$LIN create "title" --template aios`

Use `patch-desc` when an agent must update part of a description without wiping verification checklists:

```markdown
<<<<<<< SEARCH
(old exact text)
=======
(new text)
>>>>>>> REPLACE
```

## Agentic Linear factory (triage → batches → closeout)

See also: `workstream-update` skill and `.claude/rules/linear-factory.md`.

| Stage | Action |
|-------|--------|
| **Capture** | Raw notes/screenshots → `$LIN create "…" --template aios --state Triage` |
| **Intake** | Flesh template sections; `aios spec eval`; move to Backlog |
| **Batch** | Run `workstream-update` → paste 3–5 non-overlapping agent prompts |
| **Build** | PR titled `(AIO-n) …`; board moves to In Review / Done via CI |
| **Closeout** | Tick acceptance subsections; copy transcript to `.aios/loop/AIO-n/`; `aios time capture` |

**Outcome hierarchy:** parent = epic/outcome; children = slices. Titles describe outcomes, not cryptic handler names. Use `$LIN blocks` for deps.

**Agent identity:** use a dedicated Linear API key (service/bot member) for agent writes — personal OAuth hides notifications when agents assign or close as you.

**Brain-projected backlog (AIO-1..71):** prefer brain → projection for product tasks; factory ops target hand-authored meta issues and new specs.

## PR lifecycle is automated — don't move issues by hand for it

- **PR opened** → `.github/workflows/pr-in-review.yml` → **In Review**
- **PR merged** → `.github/workflows/aios-work-sync.yml` → brain work-event → **Done**

Only use `set-state` manually for transitions CI doesn't cover (e.g. Backlog → In Progress, Triage → Backlog).

## Key facts

- Workspace `je4light`, team **AIO** (key `AIO`), team uuid `7beef22a-34c2-426a-9b0c-db584870a098`.
- Projection-tracking epic **AIO-72**; phase issues **AIO-73..78** — safe to edit directly.
- Backlog issues **AIO-1..71** are brain-projected; direct edits = inbound drift.

## AIOS ops cheatsheet

- **dotenvx noise:** always `dotenvx run --quiet`
- **Plane MCP** returns huge blobs — use this script instead.

## When this skill is wrong or incomplete

Update `linear.mjs` and/or this SKILL.md in the same session.
