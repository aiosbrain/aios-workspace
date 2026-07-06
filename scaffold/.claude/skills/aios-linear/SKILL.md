---
name: aios-linear
description: Manage the AIOS Linear board (the ONLY PM tool — Plane is retired). Use whenever updating, reading, or commenting on AIOS Linear issues (identifiers like AIO-72, AIO-75), the brain→PM projection-tracking epic, or the backlog. Triggers on "update AIO-NN", "the Linear board", "the AIOS board", "projection tracking issue", "/aios-linear". Provides a terse `linear.mjs` CLI so issue edits are one fast command instead of ad-hoc GraphQL one-liners. DO NOT use the Plane MCP for AIOS work — it is retired and its tools return huge irrelevant payloads.
version: 1.0.0
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
$LIN get AIO-75 --full         # + url + full description
$LIN set-desc AIO-75 spec.md   # replace description from a file
$LIN set-state AIO-75 "In Progress"  # move to a workflow state (name match)
$LIN set-priority AIO-75 high  # priority: none, urgent, high, medium, low
$LIN relations AIO-75          # show blocks / blocked-by issue relationships
$LIN blocks AIO-73 AIO-75      # mark AIO-73 as blocking AIO-75
$LIN comment AIO-75 "done"     # add a comment
$LIN list AIO                  # all AIO-team issues, id-sorted
```

For a long description, write it to a temp file first, then `set-desc <IDENT> <file>` — avoids quoting hell and keeps it out of the transcript.

## PR lifecycle is automated — don't move issues by hand for it

Two GitHub workflows in `aios-workspace` keep the board honest deterministically, so an agent
should **not** manually set state for these transitions:

- **PR opened / reopened / ready** → `.github/workflows/pr-in-review.yml` moves the referenced
  `AIO-<n>` issue (from the PR title/body/branch) to **In Review** and comments the PR link. It
  soft-skips if `LINEAR_API_KEY` (repo secret) is unset and never blocks the PR. Put the
  identifier (e.g. `(AIO-130)`) in the PR title.
- **PR merged** → `.github/workflows/aios-work-sync.yml` posts a brain work-event → task `done`
  → pm-sync projects **Done** to Linear.

So: reference the issue in the PR and the board moves itself. Only use `set-state` manually for
transitions these don't cover (e.g. Backlog → In Progress when you pick work up).

## Key facts

- Workspace `je4light`, team **AIO** (key `AIO`, name "AIOS"), team uuid `7beef22a-34c2-426a-9b0c-db584870a098`.
- Projection-tracking epic **AIO-72**; phase issues **AIO-73..78** (Phase 0=73 … Phase 5=78). These are meta-tracking, separate from the projected backlog tasks — safe to edit directly.
- The backlog issues (AIO-1..71) are brain-projected; editing them directly is inbound drift — prefer editing the brain.

## AIOS ops cheatsheet (extend when you hit a new gotcha)

- **dotenvx noise:** always `dotenvx run --quiet` — without `--quiet` its banner pollutes stdout and breaks JSON capture.
- **Node one-offs:** use `node --input-type=module -e '...'` (ESM) — mixing `require()` with top-level `await` errors; prefer a small script file.
- **The Plane MCP `list_projects`/`update_work_item` return multi-thousand-token blobs**. Linear-only via this script avoids it.

## When this skill is wrong or incomplete

If a command fails or you discover a new gotcha, **update `linear.mjs` and/or this SKILL.md in the same session** — that's the point of the skill.
