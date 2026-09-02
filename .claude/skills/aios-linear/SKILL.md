---
name: aios-linear
description: Manage the AIOS Linear board (the ONLY PM tool — Plane is retired). Use whenever updating, reading, or commenting on AIOS Linear issues (identifiers like AIO-72, AIO-75), the brain→PM projection-tracking epic, or the backlog. Triggers on "update AIO-NN", "the Linear board", "the AIOS board", "projection tracking issue", "/aios-linear". Routes every operation through the canonical `aios linear <verb>` CLI so issue edits are one fast command instead of ad-hoc GraphQL one-liners. DO NOT use the Plane MCP for AIOS work — it is retired and its tools return huge irrelevant payloads.
version: 2.0.0
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

## This skill is ROUTING DOCUMENTATION (AIO-1067)

The Linear implementation lives in the **aios CLI's built-in adapter**
(`aios-workspace/scripts/connectors/linear/`), not in this skill. There is exactly ONE
provider client; this directory carries routing instructions only (AIO-1072 removed the
last executable delegate). Never add executable client code here.

**The canonical route — from any repo, any directory:**

```bash
LIN="aios linear"               # the one canonical invocation (AIO-1067)

aios connect linear             # one-time setup (see below)
$LIN status                     # report the resolved credential source — never values
$LIN get AIO-75                 # one line: identifier, title, state, id
```

One compatibility route delegates to the SAME adapter (identical stdout + exit status,
plus a deprecation warning on stderr; removal no earlier than v3.0.0): the published
compat bin `linear <verb> …` (`scripts/linear.mjs`). It is deprecated — prefer
`aios linear` everywhere. The skill-vendored `linear.mjs` delegate is gone (AIO-1072).

## Credentials: `aios connect linear` (never export-and-hope)

The adapter resolves ONE complete credential source, in order: the `LINEAR_API_KEY`
environment variable → the workspace `.env` vault (scoped dotenvx decryption of that single
key, AIO-790) → the user-level config reference written by `aios connect linear`
(`env:VARIABLE` or `keychain:service` — a REFERENCE, never a stored plaintext secret).

- Missing everywhere → stable error `AIOS_E_CREDENTIAL_MISSING` (exit class 3) whose
  remediation is exactly the command that fixes it: `aios connect linear`.
- Inside a workspace, `aios connect linear` runs the guided descriptor flow (dotenvx vault).
- Anywhere else: `aios connect linear --reference env:LINEAR_API_KEY`,
  `--reference keychain:aios-linear`, or `--token <api-key>` (macOS keychain-backed).
- `aios disconnect linear` removes the user-level reference.
- Do not `dotenvx run -f .env` to call Linear — that decrypts every secret in the file and
  prints `[WRONG_PRIVATE_KEY]` / `[DECRYPTION_FAILED]` noise for unrelated keys (AIO-790).

## Use the CLI, not ad-hoc GraphQL

```bash
$LIN get AIO-75 --full         # + url + full metadata (incl. assignee) + description + comments
$LIN export-desc AIO-75 spec.md # exact UTF-8 description + SHA-256
$LIN verify-desc AIO-75 spec.md # refetch + compare description (content, not bytes)
$LIN template aios              # print issue scaffold
$LIN template finding           # print the post-merge finding scaffold (AIO-999)
$LIN create "My slice" --template aios --state Triage
$LIN create "My slice" --project Ultraharden --priority high  # set both at creation, no follow-up calls
$LIN set-desc AIO-75 spec.md [--force]  # replace description; force bypasses the table lint
$LIN patch-desc AIO-75 patch.md [--force]  # SEARCH/REPLACE; force bypasses the table lint
$LIN set-title AIO-75 "New title"
$LIN set-state AIO-75 "In Progress"
$LIN set-priority AIO-75 high  # priority: none, urgent, high, medium, low
$LIN relations AIO-75          # show blocks / blocked-by / related
$LIN blocks AIO-73 AIO-75      # mark AIO-73 as blocking AIO-75
$LIN related AIO-73 AIO-75     # mark AIO-73/AIO-75 as related (non-blocking cross-ref)
$LIN remove-relation TEAM-123 TEAM-456 blocks  # remove only the directional TEAM-123 → TEAM-456 blocker
$LIN remove-relation TEAM-123 TEAM-456 related # remove the pair's related relation (either direction)
$LIN projects                  # list every project (name, state, url) — set-project is no longer a guess
$LIN projects ultra            # filter that list by case-insensitive substring
$LIN create-project "Ultraharden" [--desc file.md] [--team AIO]  # refuses an existing exact name
$LIN set-project AIO-75 "V1.0 — Verified Operator Loop"  # move issue to a project (substring match)
$LIN set-parent AIO-647 AIO-776 # re-parent an issue under another
$LIN add-label AIO-75 unified-inbox   # add a team label without removing existing ones
$LIN comments AIO-75           # read existing comments
$LIN comment AIO-75 "done"     # add a comment
$LIN users AIO                 # list assignable users
$LIN assign AIO-75 "alex@example.com" # assign by one exact name/display-name/email match
$LIN list AIO                  # all AIO-team issues, id-sorted
$LIN list AIO --open --label finding --label repo:workspace,repo:devtools \
  --missing-label sev:         # filtered: --open drops Done/Canceled; repeated --label
                               # ANDs, comma inside one flag ORs; --missing-label keeps
                               # issues lacking a label with that prefix. Rows keep the
                               # ident/state/title columns and append a TRAILING {labels}
                               # column; `count: N` goes to stderr (stdout stays parseable).
$LIN query                     # your open assigned issues (paginated), as raw JSON
$LIN query '{ teams { nodes { name key } } }'  # any GraphQL query/mutation; --vars '<json>'
$LIN activity pull --repo "$PWD"  # assigned open issues → 1-inbox/comms/activity.jsonl
                               # (operator-loop visibility records; [--tier admin|team|external]
                               # [--activity-path PATH] [--dry-run])
```

For a long description, write it to a temp file first, then `set-desc <IDENT> <file>` — avoids quoting hell and keeps it out of the transcript.

### Descriptions do not round-trip byte-for-byte (AIO-942)

Linear parses a description into its own document model and re-serialises it, so what comes
back is never quite what you sent. Most of that is cosmetic — YAML frontmatter becomes a
```yaml fence, emphasis is re-bracketed around inline code (`**not `x` icon**` →
`**not** `x` **icon**`), table delimiter rows are restyled.

**One case is not cosmetic. A markdown table indented under a list item is corrupted:** Linear
strips leading characters from every cell after the first column. Observed on VIB-348,
2026-08-19 — `| I2 (#8) | `components/…` | `CircleX` |` came back as
`| (#8) | mponents/…` | rcleX` |`. That is stored text, not a rendering artifact, and it is
silent.

So:

* `set-desc` and `patch-desc` **lint before sending** and block any indented table, with line
  numbers. `--force` after the filename is the explicit escape hatch. They **re-read after
  writing** and exit non-zero on real content drift; at that point the write already happened,
  so repair the description immediately, rerun the write, and then run `verify-desc`.
* `create` runs the same two guards on its description (`--desc` or `--template`, AIO-1026):
  the lint fires **before any mutation** — a rejected description means no issue was created —
  and `--force` downgrades it to a warning. After a successful create it re-reads the stored
  description of the returned identifier. Both failure paths exit non-zero, **name the created
  issue**, and save the exact body that was sent to a recovery file — the origin block or a
  stamped template is part of what was sent, so the original `--desc` file may not match it:
  * a **failed readback** (the check itself errored — nothing is known about what Linear
    stored) prints `verify-desc <IDENT> <recovery-file>` to inspect without writing;
  * **confirmed drift** (Linear stored something else) prints `set-desc <IDENT>
    <recovery-file>` to rewrite the description from the sent body.
  The create mutation is sent exactly once and never retried — a lost response is reported
  as "the issue may already exist", with the list command to check before re-running.
* `verify-desc` compares on a normalised form. A byte difference caused only by Linear's
  re-serialisation now **passes**; genuine content loss **fails**. Before this, it failed on
  essentially every write, which made it noise nobody could act on — and that is how the
  VIB-348 corruption nearly shipped unnoticed.

**Keep tables at column 0.** If a table belongs to a numbered step, put it in a section below
rather than indenting it under the list item.

`create` defaults to team key `AIO`; override it with `AIOS_LINEAR_TEAM_KEY`. Optional
origin attribution is configuration, not public toolkit data: set both
`AIOS_LINEAR_ORIGIN_LABEL` and `AIOS_LINEAR_ORIGIN_TEXT` to prepend an `**Origin:**` block
when that label is used.

### Pick-up-able issue template

Author specs with the canonical template in `docs/agentic-ergonomics/aios-issue-template.md`:

1. `aios spec init draft.md --title "…"` or `$LIN template aios > draft.md`
2. Fill sections → `aios spec eval draft.md` until `SPEC_READY`
3. `$LIN set-desc AIO-n draft.md` or `$LIN create "title" --template aios`

### Post-merge finding template (AIO-999)

Post-merge findings (consolidate-findings output, `code-review-<slug>.md` artifacts) are
filed with the finding-shaped template and **classified at file time** via labels — one per
dimension (`repo:` / `defect:` / `sev:` / `det:` / `fence:`) plus the `finding` marker:

```bash
$LIN create "<one-line finding>" --template finding \
  --label finding --label repo:workspace --label defect:logic \
  --label sev:high --label det:deterministic --label fence:none
```

Canonical label vocabulary, severity mapping (anchored to aios-devtools
`scripts/severity.mjs`), and the needs-triage / drain-queue queries live in the aios
monorepo's `docs/finding-taxonomy.md` — do not restate them here. `add-label` and
`create --label` cannot *create* labels; the taxonomy set already exists on team AIO.

Use `patch-desc` when an agent must update part of a description without wiping verification checklists:

A patch block contains, in order: the marker `<<<<<<< SEARCH`, the exact old text, the
separator `=======`, the replacement text, and the closing marker `>>>>>>> REPLACE`, each on
its own line.

## Agentic Linear factory (triage → batches → closeout)

See also: `workstream-update` skill and `.claude/rules/linear-factory.md`.

| Stage        | Action                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------- |
| **Capture**  | Raw notes/screenshots → `$LIN create "…" --template aios --state Triage`                 |
| **Intake**   | Flesh template sections; `aios spec eval`; move to Backlog                               |
| **Batch**    | Run `workstream-update` → paste 3–5 non-overlapping agent prompts                        |
| **Build**    | PR titled `(AIO-n) …`; board moves to In Review / Done via CI                            |
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

- Team **AIO** (key `AIO`, name "AIOS"); the CLI resolves its runtime UUID instead of embedding it.
- Projection-tracking epic **AIO-72**; phase issues **AIO-73..78** (Phase 0=73 … Phase 5=78) — safe to edit directly.
- Backlog issues **AIO-1..71** are brain-projected; editing them directly is inbound drift — prefer editing the brain.

## AIOS ops cheatsheet

- **dotenvx noise (AIO-790):** do not `dotenvx run -f .env` to call Linear. That decrypts every
  secret and emits key-mismatch warnings for unrelated keys. Use `aios linear` — the adapter
  scopes decryption to `LINEAR_API_KEY`. `--quiet` only hides the dotenvx banner, not those warnings.
- **Plane MCP** returns huge, mostly-irrelevant blobs for AIOS-internal work — use the CLI instead. Plane remains a supported _customer_ integration; that's a different boundary.

## When this skill is wrong or incomplete

If a verb fails or you discover a new gotcha, fix it in the **canonical implementation**
(`aios-workspace/scripts/connectors/linear/` + this routing doc, both skill copies) in the
same session — not in a local fork. The two skill copies
(`.claude/skills/aios-linear/` and `scaffold/.claude/skills/aios-linear/`) must stay
byte-identical (`npm run check:linear-skill-parity`, AIO-927).
