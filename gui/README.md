# gui/ — local web cockpit

Chat with a team-ops repo in the browser instead of the terminal. One WebSocket
session = one **runtime adapter** driving the repo as `cwd`. The default runtime is
`claude-code` — an Agent SDK `query()` with the claude-code system-prompt preset, so
`.claude/CLAUDE.md`, rules, skills, and the PreToolUse guard hook fire exactly as they
do in Claude Code. Other runtimes (`opencode`, `codex`, `hermes`, `openclaw`) are
selectable and bring their own model catalogs and their own capabilities.

```bash
npm install            # once, at the toolkit root
npm run gui -- --repo ~/Projects/acme-team-ops
# open the printed http://127.0.0.1:8790/?token=… URL
```

The default `claude-code` runtime requires `ANTHROPIC_API_KEY` in the environment (or
a Claude subscription login already configured for the SDK). Other runtimes use their
own auth — the workspace never stores provider keys.

## Runtime & model

Set both from **Settings → Agent** (they persist to `agent_runtime` / `agent_model` in
`aios.yaml`). A **runtime** change applies to the **next chat** — a live session pinned
its runtime at connect. A **model** change applies immediately, mid-session.

| Runtime | Models offered | Providers |
|---------|----------------|-----------|
| `claude-code` *(default)* | Sonnet 4.6 / Opus 4.8 | Anthropic |
| `opencode` | the live provider catalog, grouped by provider (seeded fallback + any well-formed `provider/model` id) | whatever OpenCode's own auth reaches — OpenRouter, OpenAI, Anthropic, … |
| `codex`, `hermes`, `openclaw` | no picker (the runtime's own config) | the runtime's own |

**Capability downgrades on non-Claude runtimes are real and disclosed**, not hidden:

- **Writes are not pre-gated.** Native runtimes (`opencode`, `codex`) execute file
  writes in-process, so the host can't intercept a tool call. A **post-turn sweep**
  re-runs the same guard over every file the turn changed and blocks on a violation,
  and the chat shows a safety banner saying so.
- **The background memory reviewer is off.** It would mean a silent Anthropic call
  from a runtime you chose precisely to avoid that (BYOA), so it is disabled and the
  Settings toggle is greyed out.
- **Token usage / the context meter** are only reported by `claude-code`. Per-turn
  cost under `opencode` comes from the OpenCode session API and is blank rather than
  estimated when that read fails.

Full detail, the OpenRouter/Qwen recipe, and where keys live: `docs/byoa.md`.

## What you get

- Streaming chat with tool-call cards (collapsible input/result)
- **Interactive tool approvals** — the SDK's `canUseTool` round-trips to the
  browser; unanswered approvals auto-deny after 5 minutes
- Session transcripts as JSONL under the workspace’s `.aios/sessions/` (created lazily on the first user message)

## Security posture

Binds **127.0.0.1 only**; a random per-launch token is required on the
WebSocket upgrade. This is a single-user local cockpit — do not reverse-proxy
it onto a network. The repo's guard hook still blocks secrets/admin-tier
writes inside GUI sessions, same as in the terminal.

## Known limitation

The **Workflow tool** (which runs the `.workflow.js` harnesses) is not
confirmed available inside Agent SDK sessions (docs are ambiguous as of
June 2026). If a harness won't launch from the GUI, run it from Claude Code
CLI — everything else (skills, sync, rules) works in both.
