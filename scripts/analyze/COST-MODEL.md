# AIOS cost model — what the numbers mean

`aios analyze` reports AI cost across providers. The single most important thing to
understand: **a token estimate is not your bill.** Subscription tools (Claude Code,
Cursor-on-a-plan) are billed a flat monthly fee plus metered overage — never per token.
So we split every figure into what it actually represents.

## Three kinds of number

| Kind | What it is | Providers | Source |
|------|-----------|-----------|--------|
| **Flat subscription** | The monthly fee you pay regardless of usage | Claude Max/Pro | login token → plan → list price (overridable) |
| **Real metered spend** | Actual USD billed per use | Anthropic API keys, Cursor overage, Opencode Zen | provider billing APIs |
| **API-equivalent value** | "What this *would* cost on the API" — an efficiency/value signal, **not** money you owe | Claude, Codex (from local session logs) | token counts × current API list prices |

The terminal block, `3-log/ai-spend.md`, and `--json` `costs` all group by these.

## Why we can't just show real Claude subscription $ + overage

We looked hard. There is **no** programmatic path:

- Claude Code `/usage` and `/cost` are **local estimates** — no API behind them.
- OTEL metrics (`claude_code.cost.usage`) are API-price estimates, no plan/limit/credit data.
- The Agent SDK exposes no usage/cost/limits accessor.
- OAuth tokens are **server-restricted to Claude Code + Claude.ai** — you can't reuse the
  keychain token from another tool (and it'd be against ToS).
- The Admin cost API covers **API-key** spend only and, today, omits subscription users
  (anthropics/claude-code#27780).

So the flat fee is detected + overridable, and the *real* dollars we surface are the ones
that genuinely are metered.

## Claude plan detection + override (`claude-plan.mjs`)

Precedence: **config/env override → Claude Code login token → unknown**.

The login token (macOS keychain `Claude Code-credentials`, or `~/.claude/.credentials.json`)
carries `subscriptionType` + `rateLimitTier`. We map that to a plan and Anthropic's list price:

| Plan | `$/mo` |
|------|-------|
| Pro | 20 |
| Max 5× | 100 |
| Max 20× | 200 |

> ⚠️ **The token's tier can lag your real plan** — it doesn't re-fetch on upgrade (a Max-20×
> account can still read as `max_5x`). If the detected plan is wrong, override it. That's the
> honest fallback: the default is right for many people, and a one-line config fixes the rest.

**Override** in `<repo>/.aios/cost-config.json` (per-machine, not synced):

```json
{ "claude": { "plan": "max_20x", "monthly_usd": 200 } }
```

or via env: `AIOS_CLAUDE_MONTHLY_USD=200` (and optionally `AIOS_CLAUDE_PLAN=max_20x`).

## Real Anthropic API-key spend (`anthropic-admin.mjs`)

Set `ANTHROPIC_ADMIN_KEY` (an org Admin key, `sk-ant-admin01-…`, scope `org:admin`) and
analyze pulls **real billed USD** from `GET /v1/organizations/cost_report`, bucketed per day,
and pushes it to the brain as provider `anthropic` (source `admin-cost`, `meta.real: true`).

- Covers your **API-key** usage (Hermes services, scripts) — the actual "API credits".
- Not available for individual (non-org) accounts (401/403, surfaced as a note).
- **Forward-compatible**: when #27780 is fixed, subscription rows appear here automatically —
  no code change. That's why it's built now.
- Absent key → skipped silently; nothing breaks.

## Provider coverage recap

| Provider | Real $ | Estimate | Notes |
|----------|:------:|:--------:|-------|
| Anthropic API keys | ✅ admin cost API | — | needs `ANTHROPIC_ADMIN_KEY` |
| Claude Code | flat subscription | ✅ API-equivalent | subscription, not per-token |
| Cursor | ✅ billing API (incl/overage) | — | authoritative |
| Opencode | ✅ session API | — | Zen per-message cost |
| Codex | — | ✅ API-equivalent | token estimate |

## Pricing note

The token-estimate prices in `metrics.mjs` are **current** Anthropic list prices (Opus 4.x
= $5/$25 per M, cache-read 0.1×, cache-create at the 1h rate). They were previously the old
Opus-3 $15/$75 numbers, which overstated the API-equivalent figure ~3× since Opus dominates
usage. Even corrected, this figure is a *value* signal — read it as "if this ran on the API",
not as spend.
