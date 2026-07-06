---
name: cost-monitor
description: >
  Collect and push AI provider spend (Cursor + Claude) to the Team Brain.
  Use when the user asks about token usage, AI costs, billing, overages,
  or at end-of-day during heavy build sprints. Run before sync to update
  the team-visible spend ledger.
version: 1.0.0
access: team
triggers:
  - token usage
  - ai costs
  - cost monitor
  - billing overage
  - push spend to brain
---

# Cost Monitor

Track external AI spend for AIOS contribution visibility. Uses the existing **`aios analyze --push`** pipeline — not a separate costs command.

## Quick run

From this workspace root (requires the AIOS toolkit CLI on PATH or via `scripts/aios.mjs` shim):

```bash
aios analyze --repo . --since billing --push
```

Each teammate runs the same from their own workspace with their own team-tier API key (`AIOS_MEMBER` set in `.env`).

## What it does

1. **Session logs** (Claude · Codex · Cursor bubbles) → AEM maturity metrics + token/cost totals → `POST /api/v1/metrics` → Maturity → People
2. **Cursor billing dashboard** (authoritative USD, Bugbot overage) → `POST /api/v1/costs` → Admin → Usage
3. Claude spend in metrics is **API-equivalent** from session logs — not your Max/Pro subscription invoice

## Flags

| Flag | Purpose |
|------|---------|
| `--since billing` | Current Cursor billing cycle |
| `--since 7d` | Rolling window (default) |
| `--push` | Push metrics + Cursor billing to brain |
| `--report` | Deep-dive terminal report |
| `--json` | Machine-readable output |
| `--tool claude\|codex\|cursor` | Limit sources |

Set `AIOS_COST_PROJECT=aios` in `.env` to tag Cursor billing rows as AIOS contribution.

## After collecting

```bash
aios status
aios push   # sync team-tier markdown (optional)
```

## Prerequisites

- Signed into Cursor app (web session token for dashboard API)
- `AIOS_BRAIN_URL` + `AIOS_API_KEY` + `AIOS_MEMBER` in `.env` for `--push`
- Brain deployed with `usage_costs` table and maturity cost columns

## Daily habit

Run at start and end of heavy build days:

```bash
aios analyze --repo . --since billing --push
```

Watch **Maturity → People** for per-person tokens/est. spend and **Admin → Usage** for Cursor billing.
