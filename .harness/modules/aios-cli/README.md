# Module — AIOS CLI (loop engineering + Team Brain)

**Coupling:** this module ties the harness into the AIOS ecosystem —
[`aiosbrain/aios-workspace`](https://github.com/aiosbrain/aios-workspace) (MIT) and,
for the team surfaces, a deployed [Team Brain](https://github.com/aiosbrain/aios-team-brain).
That coupling is the point: the portable core harnesses *a repo*; this module harnesses
*a team*. Skip it if you only want the repo-level pack.

## What it adds, in three layers

### 1. Loop engineering (`aios loop`)

Named, scheduled operator loops with verification built in: a **collector** gathers
signals, an **evidence ledger** records them, a **verifier** checks every shareable
claim against evidence before a human approves, and a scheduler (`aios loop install`,
launchd/cron) runs the cadence — a light daily orientation loop and a heavier,
approval-gated weekly closeout. This is the "loops, not sessions" upgrade: the harness
stops being something you invoke and becomes something that runs.

```bash
aios loop collect        # gather signals into the manifest
aios loop daily          # the daily orientation pass
aios loop verify         # evidence-check claims before anything ships outward
aios loop install        # schedule the cadence (launchd/cron)
```

### 2. Team Brain connection

Tier-tagged sharing between individual workspaces and a shared team brain —
default-deny (`private` never syncs; only `team`/`external`-tagged content pushes):

```bash
aios status              # what would sync
aios push | aios pull    # share / receive tier-tagged work
aios query "…"           # ask questions across the team's shared context
```

For an engineering team this is where harness telemetry becomes shared: maturity
placements, spend, decisions, and shipped-work summaries land on one surface instead
of in each engineer's terminal. (`modules/agentic-maturity` and `modules/cost-monitor`
both gain their team-level rollups through this.)

### 3. The gated ship pipeline (preview of the V1 extraction)

The AIOS CLI already ships the automated version of this pack's methodology — the
pipeline [docs/thin-spots.md](../../docs/thin-spots.md) lists as the headline V1 item:

| Command | The pack skill/rubric it automates |
|---|---|
| `aios spec eval\|fix` | `rubrics/spec-readiness.md` (deterministic + adversarial layers) |
| `aios build` | plan-first → implement on an isolated worktree, review loop to `MERGE_READY` |
| `aios consolidate-findings` | `rubrics/code-review.md` multi-reviewer fusion (fail-closed) |
| `aios simplify` | `skills/simplify-pass` (verify-gated, revert-on-failure) |
| `aios council` | cross-lab model panel — `models/routing.yaml`'s diversity idea, executable |
| `aios rails` | permission-allowlist bootstrapping from real transcripts |

Today these carry some AIOS-workspace conventions (issue tracker, workspace spine);
they work best inside a scaffolded AIOS workspace. The tracker-agnostic extraction is
tracked upstream.

## Install

```bash
git clone https://github.com/aiosbrain/aios-workspace && cd aios-workspace
npm install && npm run build:loop
npm link                       # puts `aios` on PATH  (or call scripts/aios.mjs directly)
aios onboard                   # guided setup; Team Brain URL/key optional
```

Pin the version (tag/commit) when rolling out to a team; upgrade deliberately via
`aios update`, which 3-way-merges toolkit changes without clobbering local edits.

## When to adopt

Rung 2–3 on the [autonomy ladder](../../docs/autonomy-ladder.md), when three things are
true: the review gate is habitual, more than ~2 engineers run agents daily, and someone
wants the team-level view. Before that, the portable core is enough — don't take on an
ecosystem to harness one repo.
