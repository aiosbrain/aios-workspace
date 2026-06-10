# gui/ — local web cockpit

Chat with a team-ops repo in the browser instead of the terminal. One
WebSocket session = one Claude Agent SDK `query()` with the repo as `cwd` and
the claude-code system-prompt preset — so `.claude/CLAUDE.md`, rules, skills,
and the PreToolUse guard hook fire exactly as they do in Claude Code.

```bash
npm install            # once, at the toolkit root
npm run gui -- --repo ~/Projects/acme-team-ops
# open the printed http://127.0.0.1:8790/?token=… URL
```

Requires `ANTHROPIC_API_KEY` in the environment (or a Claude subscription
login already configured for the SDK).

## What you get

- Streaming chat with tool-call cards (collapsible input/result)
- **Interactive tool approvals** — the SDK's `canUseTool` round-trips to the
  browser; unanswered approvals auto-deny after 5 minutes
- Session transcripts as JSONL under `gui/.sessions/` (gitignored)

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
