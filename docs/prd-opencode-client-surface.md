# PRD — OpenCode as a Client Surface for the Claude Code Runtime

**Status:** Proposed — spike complete (see §5), architecture recommendation below.
**Last updated:** 2026-07-04 · **Owner:** John
**Research:** john-workspace
`research/competitive-landscapes/2026-07-03-in-house-agent-harness-landscape.md` —
"OpenCode fork/adopt feasibility" section + the "Spike result (2026-07-03)" appended to it.
**Related:** [`docs/byoa.md`](./byoa.md) — this PRD proposes a **new axis**, not a change
to BYOA's existing Axis A `agent_runtime: opencode` value. Read §1 carefully before
assuming these are the same thing.
**Linear:** [AIO-243](https://linear.app/je4light/issue/AIO-243/opencode-as-a-client-surface-over-the-claude-code-runtime-new-agent)

---

## 1. Summary

BYOA's `agent_runtime: opencode` already exists and has a working GUI adapter
(`gui/server/runtime-adapters/opencode.mjs`) — but it runs **OpenCode's own agent loop**,
and per `docs/byoa.md`'s own Phase-2 export table, skills degrade to plain instruction
files on it, with no native multi-agent harness. That is a materially different thing from
what John and Chetan actually want to try: using **OpenCode's client UI** (its TUI/web/
desktop) while **Claude Code's own engine** — full native skills, hooks, and subagent
orchestration — keeps running underneath, unmodified. This PRD proposes that second thing
as a **new, distinct client-surface option**, validated by a hands-on spike (research doc,
"Spike result" section) that confirmed skills/hooks/subagents survive this specific
integration path byte-identical to native Claude Code, with no material latency cost.

**These two must not be conflated.** `agent_runtime: opencode` (existing) = OpenCode's own
loop drives everything, skills degrade. This PRD's proposal (new) = Claude Code's loop
drives everything, unchanged; OpenCode is only ever the window you're looking through.

## 2. Goals / Non-goals

**Goals**
- G1. John and Chetan can set one config value (or pass one CLI flag) and get a
  full-fidelity AIOS session — real skills, real hooks, real subagent orchestration —
  rendered through OpenCode's client instead of AIOS's own React GUI or the raw Claude
  Code CLI.
- G2. Zero loss of governance: the existing `team-ops-guard.sh` PreToolUse hook must fire
  exactly as it does under native Claude Code (verify, don't assume — see §6 P0.5).
- G3. The config-scope-bleed gotcha found in the spike (OpenCode's config discovery
  walking up to the operator's real global `~/.claude`/`~/.config/opencode`) is closed
  before this leaves "1-to-tweak" internal use — a client-scoped session must never
  silently see the operator's global MCP servers/skills, given AIOS's multi-tenant/
  per-engagement access-tier model.
- G4. This ships first as an explicitly experimental, opt-in option for the two people who
  asked for it (John, Chetan) — not a default, not advertised in onboarding, until Phase 3.

**Non-goals (v1)**
- N1. Not deprecating or changing the existing `agent_runtime: opencode` (own-loop) mode —
  it remains valid for anyone who actually wants OpenCode's own multi-provider flexibility
  instead of Claude Code.
- N2. Not migrating the Tauri desktop shell to Electron. The research flagged this as a
  real cost of adopting OpenCode's *own* desktop client; this PRD only proposes using
  OpenCode's TUI/web session layer (via its HTTP+SSE API, which the existing
  `opencode.mjs` adapter already speaks), not its Electron desktop app.
- N3. Not building multi-agent parity inside OpenCode's UI. Claude Code's subagent/Task
  orchestration will keep running as one opaque turn from OpenCode's point of view
  (confirmed in the spike) — that's an accepted characteristic of this mode, not a defect
  to fix.

## 3. Users & motivating scenarios

| Persona | Today | With this mode |
|---|---|---|
| John/Chetan, curious about OpenCode's UI (multiplayer sessions, TUI, alternate clients) | Would have to give up AIOS's actual skill/hook/subagent depth to try OpenCode (via existing `agent_runtime: opencode`) | Try OpenCode's UI with zero fidelity loss — same skills, same hooks, same governance |
| A future AIOS user who prefers a terminal-first or Electron-based client over the Tauri cockpit | No alternative client exists | OpenCode's TUI/web client becomes a legitimate second front door onto the same Claude-Code-driven workspace |

## 4. Architecture

**What already exists and is reused as-is:** `gui/server/runtime-adapters/opencode.mjs`
already spawns a headless `opencode serve`, talks to it over `POST /session` + the global
`GET /event` SSE stream, and runs writes through the shared post-turn `sweep.mjs` guard.
This PRD reuses that plumbing — the new work is entirely in *what OpenCode calls as its
model provider*, not in how the AIOS GUI talks to OpenCode.

**What's new:** configure OpenCode's `provider.<name>.npm` (per the spike) to register
`@khalilgharbaoui/opencode-claude-code-plugin` as its provider, which spawns
`claude --print --output-format stream-json` per session and translates the stream into
what OpenCode expects. Confirmed in the spike: Claude Code's own tool execution, hooks,
and permission model stay intact end-to-end (`providerExecuted: true`); OpenCode only does
session bookkeeping and UI rendering.

```
OpenCode client (TUI / web / opencode.mjs adapter's existing HTTP+SSE bridge)
   ▼
opencode serve  (existing adapter, unchanged)
   │  provider.claude-code.npm → @khalilgharbaoui/opencode-claude-code-plugin
   ▼
claude --print --output-format stream-json   (spawned per session)
   │  Claude Code's OWN loop: skills, hooks (team-ops-guard.sh fires normally),
   │  subagent/Task orchestration — all native, unmodified
   ▼
same governance sweep.mjs safety net as every other native-write runtime
```

**Config surface — this is the key design decision.** Do not overload
`agent_runtime: opencode` (that value is already taken by the own-loop mode). Add a new,
orthogonal field: `agent_client` (default: unset → AIOS's own React GUI), value
`opencode` selects this mode when `agent_runtime` is `claude-code` (the default). This
keeps BYOA's existing two axes (runtime, provider) clean and adds what is really a third,
independent axis — which *client/UI* renders the session, decoupled from which engine
executes it. Reflect this addition back into `docs/byoa.md` once implemented, since it
directly extends that document's model, not just this PRD.

**The config-scope-bleed fix (closes G3).** Set `OPENCODE_CONFIG_DIR` (per the plugin's
documented discovery order) to a workspace-local path at spawn time, so a client-scoped
session cannot walk up to the operator's real `~/.claude`/`~/.config/opencode`. This is a
required part of the adapter change, not a follow-up.

## 5. Phase 0 result (already done)

Confirmed via a hands-on spike in an isolated sandbox (john-workspace research doc,
"Spike result" section, 2026-07-03): skills, hooks, and subagent orchestration all
survived the OpenCode round-trip with byte-identical output to a direct-Claude-Code
control, no material latency penalty. One real gap found (config-scope-bleed, §4) with a
known, non-architectural fix. This de-risks the rest of the phasing below — the spike
answers "does this work at all," the remaining phases are pure engineering.

## 6. Phasing & deliverables

| Phase | Deliverable | State |
|---|---|---|
| **P0 — Scratch spike** | Skills/hooks/subagents survive OpenCode + Claude-Code-provider round-trip | **Done** (2026-07-03, in isolated scratch dir, not yet inside a real AIOS workspace) |
| **P0.5 — In-workspace repro** | Repeat the spike inside an actual scaffolded AIOS workspace (not a bare scratch dir), specifically verifying `team-ops-guard.sh` (G2) fires identically and `OPENCODE_CONFIG_DIR` scoping (G3) actually blocks global config bleed | Proposed — do before any adapter code lands |
| **P1 — Adapter + config field** | `agent_client: opencode` in `aios.yaml`; adapter change to configure the Claude-Code-provider plugin + `OPENCODE_CONFIG_DIR`; reuses existing `opencode.mjs` HTTP+SSE plumbing | Proposed |
| **P2 — CLI flag + status** | `--client opencode` one-invocation override, following the existing `--repo` flag precedent in `aios.mjs`, plus `aios agent status` (documented in `docs/byoa.md` Phase 1 as a follow-up, never shipped — confirmed via grep) surfacing which runtime/client combination is active | Proposed |
| **P3 — Promote out of "1-to-tweak"** | `docs/byoa.md` updated with the new axis; GUI cockpit exposes it as a real option, not an internal flag | Proposed, gated on P0.5 + real usage by John/Chetan |

## 7. Open questions

1. Should `agent_client` live in `aios.yaml` as shown, or is it purely a session-launch
   flag (never persisted)? Lean: persisted default + per-invocation override, mirroring
   how `agent_model` already works.
2. OpenCode ships ~34 commits/day (per the research). What's the pin/upgrade policy for
   the community Claude-Code-provider plugin specifically, given it's a
   single-external-maintainer package, not first-party AIOS code?
3. Does Team Brain sync need to know a session ran through this client, or is it invisible
   at that layer (likely: invisible, since the CLI/spine contracts are runtime-neutral per
   `docs/byoa.md`'s design principles)?

## 8. Acceptance criteria

- AC1. With `agent_client: opencode` set, a real multi-skill AIOS workspace session run
  through OpenCode's client fires the same skills, the same `team-ops-guard.sh` hook, and
  the same subagent orchestration as a native Claude Code session in the same workspace —
  verified by an automated test mirroring the existing `opencode.test.mjs` pattern.
- AC2. A session launched this way cannot see or use the operator's global `~/.claude`
  skills/MCP servers when run against a different workspace's config (G3, adversarially
  tested).
- AC3. `aios agent status` reports the active runtime/client combination correctly for all
  four states (native GUI, opencode-own-loop, opencode-as-client-over-claude-code,
  CLI-only).

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Confusing this mode with the existing `agent_runtime: opencode` (own-loop, degraded skills) | New, separate `agent_client` field name; explicit contrast documented in §1 and in the `byoa.md` update (P3) |
| Single-external-maintainer plugin breaks on an OpenCode upstream change | Pin the plugin version; treat as experimental/opt-in (G4) until proven stable over real use by John/Chetan |
| Config-scope-bleed reappears in a future OpenCode release (discovery order changes) | P0.5 explicitly adversarially tests this before shipping; re-verify on any OpenCode version bump |
| Governance hook silently doesn't fire in some edge case (e.g. a Claude Code CLI flag this integration needs that suppresses hooks) | G2 + AC1 require this be *verified*, not assumed, in P0.5 |

## 10. References

- Research: john-workspace
  `research/competitive-landscapes/2026-07-03-in-house-agent-harness-landscape.md` —
  "OpenCode fork/adopt feasibility" + "Spike result (2026-07-03)"
- `docs/byoa.md` — existing BYOA architecture; this PRD extends it with a new axis, does
  not modify Axis A/B
- `gui/server/runtime-adapters/opencode.mjs`, `gui/server/runtime-adapters/sweep.mjs`,
  `hooks/team-ops-guard.sh`
- `github.com/khalilgharbaoui/opencode-claude-code-plugin`
