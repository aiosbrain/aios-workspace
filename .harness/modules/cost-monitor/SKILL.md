---
name: cost-monitor
description: Token/cost visibility for agentic engineering — per session, per day, per model lane. Use when someone asks about token usage, AI spend, "which lane is the money going to", or as a weekly habit once multi-model routing is live. Read-only reporting; changes nothing.
source: ccusage (the de-facto local usage analyzer); aios-workspace cost-monitor skill (team-level rollup variant)
am_pattern: E1 (cost axis), B6
---

You are producing a cost picture of the engineer's agent usage. Cost discipline is an
AM axis for a reason: lanes and loops multiply spend quietly, and the routing table's
economics (`models/routing.yaml`) are claims until someone measures them.

## Step 1 — local usage (Claude Code)

[`ccusage`](https://github.com/ryoppippi/ccusage) reads the local session logs; no
account access needed:

```bash
npx ccusage@latest            # daily table: tokens, cost (API-equivalent), models
npx ccusage@latest --json     # machine-readable, for trend tracking
npx ccusage@latest session    # per-session breakdown — find the expensive ones
```

Notes to carry into the report: figures are **API-equivalent** estimates from logs (a
subscription user's invoice differs); other runtimes (opencode, Codex) have their own
usage surfaces — include them if the team runs lanes through them.

## Step 2 — read it against the routing table

Answer four questions, with numbers:

1. **Lane mix** — what share of tokens ran on the frontier lane vs bulk/utility? If
   ~everything is frontier, the routing table isn't being used (or isn't needed yet —
   say which).
2. **Expensive sessions** — the top 3 sessions by cost: were they expensive because the
   task was big, or because of thrash (retries, context bloat, a loop that should have
   been stopped)? Thrash findings go to `modules/context-monitor` territory.
3. **Trend** — spend per week over the last month; flag a >50% jump with its cause.
4. **Unit economics** — rough cost per merged change this period. This is the number
   that makes lane routing worth it (or not) — and remember E1: a frontier model you
   don't babysit is often cheaper end-to-end than a cheap model you correct twice.

## Step 3 — report

One short table (day/week totals, lane mix, top sessions) + 2–3 sentences of "so
what": the one behavior change that would save the most money without dropping a rung
on the verification ladder. Never recommend saving money by weakening a review gate —
MG6 exists precisely because cheap-lane output without frontier review is the most
expensive thing in this whole system.

## Team rollup (optional)

With `modules/aios-cli` + a Team Brain, each engineer pushes their metrics
(`aios analyze --since billing --push`) and spend lands on one shared surface instead
of in N terminals. Same habit, team-visible.
