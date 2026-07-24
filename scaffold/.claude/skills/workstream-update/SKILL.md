---
name: workstream-update
description: Propose 3–5 non-overlapping agent workstreams from the AIO Linear board. Use before starting parallel agent batches, when planning a factory work session, or when the user asks for a workstream update / batch plan. Triggers on "workstream update", "batch agents", "parallel workstreams", "/workstream-update".
version: 1.0.0
access: team
triggers:
  - workstream update
  - batch agents
  - parallel workstreams
  - /workstream-update
---

# Workstream update

Produces a **workstream update** document: 3–5 agent prompts from the current AIO Linear board, aligned with the [Linear factory rule](../../rules/linear-factory.md).

## Run

```bash
WS="dotenvx run --quiet -f .env -- node .claude/skills/workstream-update/workstream-update.mjs"

$WS              # markdown batch plan to stdout
$WS --json       # machine-readable workstream list
```

Requires `LINEAR_API_KEY` and the `aios-linear` skill's `linear.mjs` on the path above.

## What it does

1. Lists AIO-team issues via `linear.mjs list AIO`
2. Prioritizes **In Progress** → **Triage** → **Backlog**
3. Emits up to 5 workstream prompts (minimum 3 when enough candidates exist)
4. Each prompt references the AIO ID, spec-eval gate, PR title convention, and closeout checklist

## Operator workflow

1. Run `$WS` and review proposed workstreams
2. Manually de-conflict if two issues touch the same code surface (script does not read file paths yet)
3. Paste each prompt into a separate harness (Codex, Claude Code, Cursor, etc.)
4. After batch: `aios time capture`

## When to use

- Starting a parallel agent session
- Sunday/weekly batch planning
- After triage intake moved issues to Backlog

## Limitations (v1)

- Does not call an LLM for code-area deconfliction — operator reviews overlap
- AIO team only (not PIKL)
- Does not auto-start agents
