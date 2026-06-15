# Bring Your Own Agent (BYOA)

> Status: **Phase 1 done** (config + docs). **Phase 2 first cut shipped** —
> `aios skills export --runtime <name>` is implemented (see below). Phase 3
> (GUI multi-backend) is designed but not yet built. This document is both the
> design/roadmap and the user-facing reference for choosing an agent runtime.

The workspace should not assume one agent. A contributor should be able to
**choose the agent runtime** that drives their workspace — Claude Code, Hermes
Agent, OpenClaw, Codex, OpenCode, or a plain Claude-API loop — and swap it via
config, with the same skills, harnesses, governance, and `aios` sync working
underneath. That is BYOA.

## Two independent axes

Keep these separate — they compose freely:

| Axis | Picks | Where it's configured |
|------|-------|-----------------------|
| **A — Agent runtime** (this doc) | *Which client executes your skills/harnesses*: claude-code · hermes · openclaw · codex · opencode · claude-api | `agent_runtime` in `aios.yaml` |
| **B — Inference provider** | *Which model answers*: cloud (Anthropic/OpenAI) or local (Ollama/llama.cpp) | per-runtime, and — for the Team Brain query path — `LLM_BASE_URL` (see aios-team-brain `docs/PROVIDERS.md`) |

Example compositions: *Hermes runtime + local Ollama* (fully private), *Claude
Code + cloud Anthropic* (today's default), *Codex runtime + cloud OpenAI + local
Team Brain*. The runtime and the provider are orthogonal.

## What's already runtime-agnostic (the durable contracts)

Most of the workspace does **not** care which agent runs it. These are the
stable contracts every runtime builds against:

1. **The filesystem spine** (`0-context/ … 5-personal/`, frontmatter, `index.md`
   navigation). Any runtime with file read/write can operate it.
2. **The `aios` CLI** (`scripts/aios.mjs`, zero-dependency Node). Any runtime
   shells out to `aios push|pull|query|status`. Sync is already agent-neutral.
3. **`SKILL.md` frontmatter** (`name`, `description`, `version`, `kind`,
   `triggers`). This is the portable *description* of a skill/harness — what it
   does and when to use it — independent of how it executes.

## What's runtime-specific today (the gaps BYOA closes)

1. **Skill execution artifact.** Harnesses ship as `*.workflow.js` (Claude
   Code's multi-agent Workflow tool). Other runtimes have their own skill
   systems (e.g. Hermes `hermes skills install`; Codex/OpenCode instruction
   files). The SKILL.md is portable; the executable is not yet. → **Phase 2.**
2. **The local GUI driver.** `gui/server/index.mjs` hardwires
   `query()` from `@anthropic-ai/claude-agent-sdk` (one WebSocket session = one
   SDK query). → **Phase 3.**
3. **No runtime selector.** Nothing tells the workspace which runtime is active.
   → **Phase 1 (this).**

---

## Supported runtimes

| `agent_runtime` | What it is | Skills today | Local model? | Status |
|-----------------|-----------|--------------|--------------|--------|
| `claude-code` *(default)* | Claude Code / Agent SDK | native (`.claude/skills` + `.workflow.js`) | via provider config | ✅ works today |
| `hermes` | Nous Hermes Agent (local-first) | `hermes skills install` (SKILL.md portable) | yes (Ollama/llama.cpp) | 🔶 runtime works standalone; workspace adapter = Phase 2/3 |
| `openclaw` | OpenClaw agent | OpenClaw skill format | yes | 🔶 Phase 2/3 |
| `codex` | OpenAI Codex | Codex plugin/instructions | no (OpenAI) | 🔶 Phase 2/3 |
| `opencode` | OpenCode (multi-provider, Go) | `opencode.json` instructions | yes | 🔶 Phase 2/3 |
| `claude-api` | Plain Anthropic API loop (no harness tool) | SKILL.md instructions only (no multi-agent) | no | 🔶 Phase 2 |

---

## Phase 1 — docs + config *(this phase)*

Add a runtime selector to the workspace config. Because `aios.yaml` is a
restricted flat YAML (scalars + one-level lists, no deep nesting — see the file
header), the selector is **flat scalar fields**, not a nested block:

```yaml
# Agent runtime that drives this workspace (BYOA — see docs/byoa.md).
#   claude-code (default) | hermes | openclaw | codex | opencode | claude-api
agent_runtime: claude-code
# Optional hints the runtime adapter may use (leave blank for the runtime's own
# defaults). Endpoint/model live with the runtime, not here, when possible.
agent_model: ""
agent_base_url: ""
```

Phase-1 scope:
- `agent_runtime` (+ optional `agent_model`, `agent_base_url`) added to
  `scaffold/aios.yaml.tmpl` with documentation. Default `claude-code` ⇒ **zero
  behavior change** for existing workspaces.
- This document (`docs/byoa.md`) as the architecture + per-runtime setup ref.
- Lightweight CLI surface (follow-up within Phase 1): `aios agent status`
  (print the resolved runtime + connectivity) and validation that
  `agent_runtime` is a known value. No execution routing yet.

Per-runtime setup (Phase 1 = documentation; full integration in 2–3):
- **claude-code** — nothing to do; the default. `.claude/` drives everything.
- **hermes** — install Hermes, point it at the workspace dir, load the
  workspace skills via `hermes skills install` (the SKILL.md is accepted; see
  the aios-team-brain `docs/LOCAL_AI_WORKSTATION.md` for a working Hermes+Ollama
  setup). Query the Team Brain with the same `aios query`.
- **codex / opencode / openclaw** — install the runtime; load skills via its
  instruction-file / plugin mechanism (Phase 2 exporter automates this).
- **claude-api** — a minimal loop that reads SKILL.md instructions; no
  multi-agent harness (degraded; for environments without a full runtime).

## Phase 2 — portable skill & harness format

Goal: one skill authored once, runnable by any runtime. **First cut shipped.**

`SKILL.md` is the canonical, runtime-neutral manifest (`name`, `description`,
`version`, `kind`, `triggers`, optional `workflow:` for the Claude-Code
executable). The exporter adapts it per runtime:

```bash
aios skills export --runtime <name> [--skill <name>] [--out <dir>]
#   runtimes: claude-code | hermes | openclaw | codex | opencode | claude-api
#   default out: .aios/export/<runtime>/
```

| Runtime | Output | Notes |
|---------|--------|-------|
| `claude-code` | identity copy (`SKILL.md` + `.workflow.js` + refs) | the source format |
| `hermes` / `openclaw` | Hermes-flavored `SKILL.md` (frontmatter + tags) | install via `hermes skills install` (proven path — llm-wiki) |
| `codex` / `opencode` / `claude-api` | plain instruction `*.md` | for instruction-file / bare-loop runtimes |

**Harness degrade is explicit, never silent.** `*.workflow.js` is multi-agent
(sub-agents + adversarial verification); only `claude-code` runs it. Exporting a
`workflow-harness` to any other runtime emits the `SKILL.md` body as
single-agent instructions with a visible degrade banner, and the CLI prints a
`harness→single-agent` warning per skill.

Implemented in `scripts/aios.mjs` (`cmdSkills` + the `SKILL_RUNTIMES` registry);
reads `.claude/skills/*/SKILL.md`, handles `|`/`>` block-scalar descriptions, and
emits exactly one H1 per skill.

**Still open in Phase 2:**
- True multi-agent harness equivalents on runtimes that support them (rather than
  always degrading to single-agent off Claude Code).
- A round-trip test in `tests/` asserting every shipped skill exports cleanly for
  each runtime, keeping `SKILL.md` the single source of truth.
- An optional `--install` that drives `hermes skills install` directly.

## Phase 3 — GUI multi-backend

Goal: the local cockpit (`npm run gui`) drives any runtime, not just the SDK.

1. **Extract a runtime-adapter interface** behind the one seam in
   `gui/server/index.mjs` (the `query()` call):
   ```
   createSession(runtime, { cwd, systemPrompt, skills }) -> {
     send(message), onDelta(cb), onToolUse(cb), onDone(cb), interrupt()
   }
   ```
2. **Implement adapters:**
   - `claude-agent-sdk` (refactor of today's code — no behavior change).
   - `hermes` (drive the Hermes dashboard/ACP API or its MCP surface).
   - `openclaw`, `codex`, `opencode`, `claude-api`.
3. **Normalize the event stream** (delta / tool-use / done) so the React client
   is runtime-agnostic; the session announces its active runtime in the UI.
4. **Select the adapter from `agent_runtime`** (Phase-1 config), with per-session
   override. Falls back to `claude-code` if a runtime is unreachable.

---

## Design principles

- **Default to no change.** `agent_runtime: claude-code` keeps every existing
  workspace identical. BYOA is opt-in.
- **SKILL.md is the contract.** Author once; runtimes are adapters around it.
- **The CLI and spine never fork.** Sync, governance, and file layout stay
  runtime-neutral — that's what makes runtimes swappable.
- **Runtime ≠ provider.** Don't couple "which agent" to "which model." Keep the
  two axes independent so they compose.
- **Honest degradation.** Where a runtime can't run a multi-agent harness, fall
  back to single-agent instructions and say so — never silently drop rigor.
