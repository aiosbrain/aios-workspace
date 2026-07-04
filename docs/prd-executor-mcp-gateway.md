# PRD — Executor MCP Gateway

**Status:** Proposed — no code in tree yet (confirmed: zero references to `executor.sh` /
`RhysSullivan/executor` anywhere in this repo today).
**Last updated:** 2026-07-04 · **Owner:** John
**Research:** john-workspace
`research/competitive-landscapes/2026-07-03-in-house-agent-harness-landscape.md` — the
"Executor.sh" + "Adjacent players" sections. This PRD turns that research into a build plan.
**Related:** [`prd-team-brain-mcp-connector.md`](./prd-team-brain-mcp-connector.md) §11
already names the exact gap this PRD closes ("`tools/list` fixed per-turn tax").
**Linear:** [AIO-242](https://linear.app/je4light/issue/AIO-242/executor-mcp-gateway-token-efficient-tool-aggregation-native-at)

---

## 1. Summary

Every MCP server an AIOS workspace connects (GitHub, Jira/Atlassian, Notion, Slack,
Linear, ...) registers directly in `.mcp.json` today, and its full tool schema loads into
context on every turn. Stripe hit this exact wall at scale and built a ~400–500-tool
internal gateway ("Toolshed") to solve it; four VC-backed companies (Executor, Composio,
Arcade, Klavis) have since productized the same fix. This PRD wires **Executor** (MIT,
self-hostable, `github.com/RhysSullivan/executor`) in as AIOS's default tool-aggregation
layer — one `execute` tool replacing N raw tool-schema loads, installed automatically at
`scaffold-project.sh` time so a new workspace gets token-efficient MCP by default, not as a
manual per-connector opt-in.

## 2. Goals / Non-goals

**Goals**
- G1. A newly scaffolded AIOS workspace gets Executor wired in by default — zero extra
  steps beyond what `aios connect <id>` already asks for.
- G2. Connecting a high-tool-count service (GitHub: 720 tools, Jira: 240, per Executor's
  own published numbers) costs a small, roughly fixed context tax per turn, not a per-tool
  one.
- G3. `aios connect`'s existing live-validation UX (`connector.mjs`'s
  `validateConnector()`, dotenvx-encrypted secret storage) is preserved — Executor sits
  underneath the connector engine, it doesn't replace it or introduce a second secret
  store.
- G4. Self-hosted only. No client/workspace data or credentials ever transit Executor
  Cloud (the hosted offering) — a hard requirement given AIOS's private/team/company tier
  model (see Risks).
- G5. Existing direct-registration connectors keep working unmodified during the
  transition (no forced migration).

**Non-goals (v1)**
- N1. Not replacing Team Brain's own first-party MCP server (`brain-mcp.mjs`) — it's
  already a lean, 7-tool, purpose-built server; gatewaying it adds a hop for no benefit.
- N2. Not building AIOS's own tool-aggregation layer from scratch. The research found four
  credible players solving this same problem; wrapping one is materially cheaper than
  reimplementing Anthropic's own code-execution-with-MCP pattern in-house.
- N3. Not a secrets-management rewrite. Executor's "host-side secret injection, never
  enters the sandbox heap" model must be *fed from* the existing dotenvx vault, not stand
  up a second, parallel secret store.
- N4. Not committing to Executor specifically forever — the integration is scoped behind
  one config surface (§4) so the gateway implementation is swappable if Executor stalls
  (see Risks).

## 3. Users & motivating scenarios

| Persona | Today | With the gateway |
|---|---|---|
| New AIOS workspace owner connecting GitHub + Jira + Notion | Each connector's full tool schema (hundreds of tools) loads raw into every Claude Code turn | One `execute` tool; Claude Code searches/describes/calls tools on demand, ~1,000 tokens instead of hundreds of thousands (Executor's own published comparison) |
| Consultant running several concurrent client engagements, each with its own `.mcp.json` | Context budget shrinks fastest exactly when the most tools are connected | Context cost stays flat regardless of how many services are connected |
| AIOS maintainer adding a new MCP-authoring skill | `mcp-builder` skill (vendored in `gui/server/skill-library/`) authors direct per-service servers | Same skill, one more step: register the new server as an Executor backend instead of (or in addition to) a direct `.mcp.json` entry |

## 4. Architecture

Confirmed today, per direct codebase inspection: `.mcp.json` → Claude Code loads each
configured server's full tool schema directly; no aggregation, proxy, or context-budget
layer exists anywhere in this repo. Executor's plugin system (`packages/plugins`)
explicitly includes an **MCP plugin type** — it can wrap an existing MCP server as one of
its aggregated backends, not just OpenAPI/GraphQL specs, which is what makes this a wrap,
not a rebuild.

```
Claude Code (.mcp.json)
   │  one server entry:  "executor"
   ▼
executor (local daemon, self-hosted — NOT Executor Cloud)
   │  packages/kernel  — sandboxed JS runtime (QuickJS / Deno subprocess / dynamic worker)
   │  packages/plugins — MCP · OpenAPI · GraphQL · Google · Microsoft · 1Password · secrets
   ▼
existing MCP servers, registered as Executor backends instead of direct .mcp.json entries:
   github · atlassian (jira) · notion · slack · linear · (aios-team-brain stays direct, N1)
```

**Secret flow (closes N3).** Executor's model is "secrets injected host-side at call
time, never enter the sandbox heap." AIOS already has a host-side secret store — the
dotenvx-encrypted `.env` per workspace, populated by `connector.mjs`'s live-validated
`aios connect` flow. Executor's config must read from that same vault (env-var
passthrough, not a duplicated credential file) so there is exactly one place a secret
lives per workspace, matching the existing model exactly.

**Deploy target (closes G4).** Executor supports four deploy targets (local CLI daemon,
native desktop app, Cloudflare Worker adapter, hosted "Executor Cloud"). Only the **local
CLI daemon** (or a self-hosted Worker, if that ever suits the desktop app's sidecar model)
is in scope. Executor Cloud is explicitly out — see Risks.

## 5. Install-time wiring

The exact splice point already exists and is unchanged by this PRD —
`scripts/scaffold-project.sh:369-383` is where `.mcp.json`/`.mcp.example.json`/
`integrations.json` get copied into a fresh workspace today. This PRD adds one more copy
step at the same point (mirroring the `team-ops-guard.sh` hook-copy pattern immediately
below it): a scaffolded `executor` local-daemon config, plus an updated
`.mcp.example.json` where the high-tool-count connectors (GitHub, Jira/Atlassian, Notion)
are registered as Executor backends by default, with Team Brain and any future low-tool-
count servers left direct per N1's logic.

`scripts/connector.mjs`'s `mcp` transport currently writes straight into `.mcp.json`.
Extend it so a connector definition in `integrations.json` can declare
`"gateway": "executor"` instead of / alongside `"transport": "mcp"`, routing
`aios connect <id>` to register the backend inside Executor's config rather than a new
top-level `.mcp.json` entry — so the existing guided UX (`aios connect`, `aios onboard`,
the desktop app's `ConnectWizard`) is completely unchanged from a user's point of view.

## 6. Phasing & deliverables

| Phase | Deliverable | State |
|---|---|---|
| **P0 — Spike** | Confirm Executor's MCP-plugin backend actually wraps a real existing server (e.g. GitHub) cleanly, self-hosted, headless (no browser needed) — assumed from research but not yet hands-on verified against AIOS's actual GitHub/Jira connectors. Measure real token footprint before/after on this repo's actual `.mcp.json`. | Proposed |
| **P1 — Connector engine wiring** | `connector.mjs` gains the `gateway: executor` path; `integrations.json` schema gains the field; dotenvx secret passthrough into Executor's config | Proposed |
| **P2 — Scaffold default** | `scaffold-project.sh` ships Executor wired by default for GitHub/Jira/Notion in new workspaces; `.mcp.example.json` updated | Proposed |
| **P3 — Existing workspace migration** | `aios connect --migrate-gateway` (or similar) to move an already-connected high-tool-count service behind Executor without re-entering credentials | Proposed |

## 7. Open questions

1. **Headless/CLI-embeddable?** Executor's primary UX shown in research was homepage/
   dashboard-oriented. Confirm the local daemon runs unattended (no browser, no interactive
   setup) suitable for `scaffold-project.sh` to provision non-interactively. **Blocks P0.**
2. **Free-tier execution cap (10K/mo) vs. real usage.** A busy multi-engagement consultant
   workspace may exceed the free tier quickly. Model expected executions/month against the
   $150/org Team tier before committing this as the *default*, not opt-in.
3. **Does gatewaying change tool-call latency or error surfaces Claude Code needs to
   reason about** (e.g. two-hop errors: Executor daemon down vs. backend service down)?
   Needs a failure-mode pass in P0.
4. **License/bus-factor.** Executor is a single-dominant-committer OSS project on a YC
   S26 timeline (per the research). If it stalls, is the fallback "fork it" (MIT allows)
   or "swap to Composio/Arcade"? Decide before defaulting new workspaces onto it (P2).

## 8. Acceptance criteria

- AC1. A fresh `scaffold-project.sh` run produces a workspace where connecting GitHub via
  `aios connect github` results in one `executor` entry in `.mcp.json`, not a direct
  `github` entry.
- AC2. Measured token footprint for `tools/list` across GitHub + Jira + Notion, gatewayed,
  is materially smaller than the same three connected directly (target: same order of
  magnitude as Executor's and Cloudflare's own published reductions, ~90%+).
- AC3. `aios connect`'s existing validation/error UX (bad key → clear rejection, offline →
  timeout message) is unchanged from a user's perspective.
- AC4. No secret is ever stored outside the existing dotenvx-encrypted `.env`.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Executor is young, single-dominant-committer, VC-timeline (YC S26) — could stall or pivot | MIT + self-hosted means AIOS can fork; integration is scoped behind one config surface (connector.mjs's `gateway` field) so swapping to Composio/Arcade/Klavis later is a config change, not a rearchitecture |
| Executor Cloud accidentally used instead of self-hosted, leaking client data through a third party | G4 as a hard non-goal; scaffold only ever configures the local daemon/self-hosted target, never the hosted one |
| Two-hop failure modes confuse users/agents (gateway down vs. backend down) | P0 spike explicitly tests failure surfaces before this ships as a default |
| Free-tier execution caps hit in real usage | Open question §7.2 — model usage before defaulting new workspaces onto it |

## 10. References

- Research: john-workspace
  `research/competitive-landscapes/2026-07-03-in-house-agent-harness-landscape.md`
  (Executor.sh + Adjacent players sections)
- `github.com/RhysSullivan/executor` (MIT, self-hostable)
- Anthropic, "Code execution with MCP" (Nov 2025) — the pattern Executor productizes
- `docs/prd-team-brain-mcp-connector.md` §11 — names the `tools/list` fixed-tax risk this
  PRD resolves
- `scripts/connector.mjs`, `scripts/scaffold-project.sh:369-383`,
  `scaffold/.mcp.example.json`, `.claude/integrations.json`
