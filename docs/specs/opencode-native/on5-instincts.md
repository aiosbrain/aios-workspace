---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON5, plugin, instincts]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON5: Instincts Plugin

## Why

In Claude Code, 10 automatic instincts fire via `settings.json` hooks (PreToolUse,
Stop, PostToolUse, Notification) and `.claude/instincts.md` definitions. These cover
session-start drift checks, decision capture, access gating, email safety, document
tracking, confluence sync, bookkeeping sync, weekly summary, M365 email routing, and
date verification. OpenCode sessions have no equivalent — these behaviors are silent.

OpenCode has a plugin system with ~20 lifecycle hooks (`tool.execute.before`,
`session.created`, `session.status`, etc.). This spec ports as many instincts as feasible
to OpenCode hooks via a TypeScript plugin.

## What

Two files:

1. **`.opencode/plugins/aios-instincts.ts`** — a TypeScript plugin exporting hooks mapped
   from Claude Code instincts. Registered via `opencode.json` plugin array.

2. **`.opencode/package.json`** — npm package manifest with `@opencode-ai/plugin`
   dependency and `type: "module"`.

### Instinct mapping (feasibility assessed)

| # | Claude Instinct | OpenCode Hook | Feasible | Implementation |
|---|----------------|---------------|----------|----------------|
| 1 | Session start drift check | `session.created` | Yes | Read `0-context/index.md`, check for stale integrations |
| 2 | Decision capture | `session.status` | Yes | Detect meeting files in context, prompt extraction |
| 3 | Document tracker | `tool.execute.after` | Yes | Track write ops, flag versioned doc changes |
| 4 | Access gate | `tool.execute.before` | Yes | Block secrets, admin-tier content in team dirs (team-ops-guard equivalent) |
| 5 | Email safety | `tool.execute.before` | Yes | Verify recipient against `entities/` files |
| 6 | Inside-out workflow | `command.execute.before` | Yes | Detect multi-layer requests, flag ordering |
| 7 | Confluence sync | `tool.execute.after` | Partial | Flag when hours/scope/tasks change; can't auto-push without CLI |
| 8 | Bookkeeping sync | `tool.execute.after` | Partial | Flag payment/invoice changes; can't auto-update without full context |
| 9 | Weekly summary | Time-based (not directly available) | Partial | Prompt when session opens on Friday; can't schedule |
| 10 | M365 email routing | N/A | No | OpenCode has no M365 integration. Document as Claude-only |

**Goal:** At least 5 fully functional instincts. Partial instincts flag conditions
but require manual action. One instinct documented as unavailable with rationale.

## Acceptance criteria

- `.opencode/plugins/aios-instincts.ts` exists and exports a function
- `.opencode/package.json` exists with `@opencode-ai/plugin` dependency
- TypeScript compiles without errors (baseline: `npx tsc --noEmit` on the plugin file)
- Plugin loads in OpenCode without errors (no crash on session start, no console spam)
- Access gate instinct (equivalent to `team-ops-guard.sh`) fires on `tool.execute.before`
  and blocks writes containing secret patterns or admin-tier content in team directories
- Session start drift check fires on `session.created` and reads `0-context/index.md`
- At least 3 additional instincts fire via their mapped hooks with observable behavior
  (log output, user prompt, or blocked operation)
- Plugin source includes a comment block at the top documenting the mapping table above
- The instincts that are partial or unavailable have clear "why not" comments

## Integration points

- `.claude/settings.json` — read reference for Claude hook mapping
- `.claude/instincts.md` — read reference for 10 instinct definitions
- `hooks/team-ops-guard.sh` — read reference for access gate logic
- `validation/secret-patterns.txt` — read reference for secret detection patterns
- `0-context/index.md` — read on session start for drift check
- `entities/*.md` — read for email safety verification
- `3-log/decision-log.md` — read for decision capture context
- `opencode.json` — plugin loaded via `plugin` array

## Deps

- ON2: opencode.json must exist with plugin array loading `aios-instincts`
- `@opencode-ai/plugin` npm package — installed in `.opencode/node_modules/`
- `hooks/team-ops-guard.sh` — must exist and be readable (referenced for access gate logic)

## Scope

In scope: instincts plugin covering 5+ fully functional instincts, 4+ partial instincts
with documented rationale, 1 documented-as-unavailable.

Deferred: Full parity for all 10 instincts (requires M365 integration, scheduling hooks);
instinct effectiveness tracking/signals (AM loop); plugin unit tests; cross-runtime
instinct sharing (instincts as portable skill artifacts).

## Build-with

sonnet / high

## Tier-safety

The plugin runs locally in the OpenCode process. It never transmits data — it reads local
files and blocks/permits tool operations. Access gate logic mirrors `team-ops-guard.sh`
fail-closed behavior (block on detection, not permit on non-detection). Secret patterns
are detected using the same regex list as the Claude Code hook. No admin data is included
in the plugin source — paths are referenced, not embedded.

## Testability

Demonstrated by plugin file existence, TypeScript compilation, OpenCode session load
test (manually verified in ON8 smoke test), access gate blocking test (attempt to write
a secret pattern to a team-tier file), and observable log output from triggered instincts.
