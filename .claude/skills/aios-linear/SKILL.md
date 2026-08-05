---
name: aios-linear
description: Manage the AIOS Linear board (the ONLY PM tool — Plane is retired). Use whenever updating, reading, or commenting on AIOS Linear issues (identifiers like AIO-72, AIO-75), the brain→PM projection-tracking epic, or the backlog. Triggers on "update AIO-NN", "the Linear board", "the AIOS board", "projection tracking issue", "/aios-linear". Provides a terse `linear.mjs` CLI so issue edits are one fast command instead of ad-hoc GraphQL one-liners. DO NOT use the Plane MCP for AIOS work — it is retired and its tools return huge irrelevant payloads.
version: 1.2.0
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

## Canonical source — read this if you're in a sibling repo

This skill's canonical, maintained copy lives in **`aios-workspace`** at
`.claude/skills/aios-linear/` (and is vendored into every scaffolded AIOS *workspace* —
e.g. an individual's `john-workspace`-style checkout — via `aios update`, from
`scaffold/.claude/skills/aios-linear/` in the same repo). If you're working inside a
sibling AIOS *product* repo that doesn't carry its own copy (`aios-team-brain`,
`aios-marketing`, `aios-website`, `aios-design`, `aios-engineering-harness`), reach across
to the aios-workspace checkout rather than improvising GraphQL calls or reaching for the
Plane MCP:

```bash
AIOS_WS=../aios-workspace   # adjust to this repo's actual relative/absolute path to aios-workspace
LIN="dotenvx run --quiet -f $AIOS_WS/.env -- node $AIOS_WS/.claude/skills/aios-linear/linear.mjs"
```

**Never hand-maintain a second divergent copy of `linear.mjs`.** If a fix or a new command
belongs here, make it in the aios-workspace canonical copy and let it propagate (via `aios
update` to scaffolded workspaces, or a direct pull for other repos) — don't patch a local
fork in place. That's exactly the failure mode that let three independently-drifted copies
accumulate here in 2026-08 (an untracked loose copy in `~/.claude/skills`, a stale
project-committed copy, and the canonical scaffold copy — all with different command sets).

## Use the script, not ad-hoc GraphQL

The CLI ships with this skill at `.claude/skills/aios-linear/linear.mjs`. Run it from the workspace root with `LINEAR_API_KEY` in `.env` (dotenvx-encrypted):

```bash
LIN="dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs"

$LIN get AIO-75                 # one line: identifier, title, state, id
$LIN get AIO-75 --full         # + url + full metadata + description + comments
$LIN export-desc AIO-75 spec.md # exact UTF-8 description + SHA-256
$LIN verify-desc AIO-75 spec.md # refetch + byte-compare description, print UTF-8 SHA-256
$LIN template aios              # print issue scaffold
$LIN create "My slice" --template aios --state Triage
$LIN set-desc AIO-75 spec.md   # replace description from a file
$LIN patch-desc AIO-75 patch.md  # SEARCH/REPLACE blocks — partial update
$LIN set-title AIO-75 "New title"
$LIN set-state AIO-75 "In Progress"
$LIN set-priority AIO-75 high  # priority: none, urgent, high, medium, low
$LIN relations AIO-75          # show blocks / blocked-by / related
$LIN blocks AIO-73 AIO-75      # mark AIO-73 as blocking AIO-75
$LIN related AIO-73 AIO-75     # mark AIO-73/AIO-75 as related (non-blocking cross-ref)
$LIN set-project AIO-75 "V1.0 — Verified Operator Loop"  # move issue to a project (substring match)
$LIN set-parent AIO-647 AIO-776 # re-parent an issue under another
$LIN add-label AIO-75 unified-inbox   # add a team label without removing existing ones
$LIN comments AIO-75           # read existing comments
$LIN comment AIO-75 "done"     # add a comment
$LIN users AIO                 # list assignable users
$LIN assign AIO-75 "chetan"    # assign by name/email substring
$LIN list AIO                  # all AIO-team issues, id-sorted
```

For a long description, write it to a temp file first, then `set-desc <IDENT> <file>` — avoids quoting hell and keeps it out of the transcript.

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

Two GitHub workflows keep the board honest deterministically, so an agent should **not**
manually set state for these transitions:

- **PR opened / reopened / ready** → `.github/workflows/pr-in-review.yml` moves the referenced
  `AIO-<n>` issue (from the PR title/body/branch) to **In Review** and comments the PR link.
  Just put the identifier (e.g. `(AIO-130)`) in the PR title.
- **PR merged** → `.github/workflows/aios-work-sync.yml` posts a brain work-event → task `done`
  → pm-sync projects **Done** to Linear.

Only use `set-state` manually for transitions these don't cover (e.g. Backlog → In Progress,
Triage → Backlog).

### Gotcha: a green `aios-work-sync` run does not mean the board moved

`.github/workflows/aios-work-sync.yml` fails **only on a non-2xx HTTP status**. It can return
success while transitioning nothing — the brain can reply `200` with `applied: []` and
`pm_sync: []` even after resolving issues from the PR body. So: **after a merge, verify the
issue actually moved**, don't assume the automation did it because the check is green.

It also links EVERY `AIO-nnn` it finds in the title, branch and body — a PR that merely
mentions other issues gets them linked too. When opening a PR that discusses other issues,
reference only the one it should close.

## Key facts

- Workspace `je4light`, team **AIO** (key `AIO`, name "AIOS"), team uuid `7beef22a-34c2-426a-9b0c-db584870a098`.
- Projection-tracking epic **AIO-72**; phase issues **AIO-73..78** (Phase 0=73 … Phase 5=78) — safe to edit directly.
- Backlog issues **AIO-1..71** are brain-projected; editing them directly is inbound drift — prefer editing the brain.

## AIOS ops cheatsheet

- **dotenvx noise:** always `dotenvx run --quiet` — without it, its banner pollutes stdout and can break JSON capture.
- **Plane MCP** returns huge, mostly-irrelevant blobs for AIOS-internal work — use this script instead. Plane remains a supported *customer* integration; that's a different boundary.

## When this skill is wrong or incomplete

If a command fails or you discover a new gotcha, fix it in the **canonical aios-workspace
copy** (`.claude/skills/aios-linear/linear.mjs` + this file) in the same session — not in a
local fork. See "Canonical source" above.
