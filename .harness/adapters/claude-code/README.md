# Adapter — Claude Code

The reference runtime for this pack. Installation from your repo root:

```bash
# 1. Vendor the pack (or add it as a plain directory — no submodules needed)
git clone https://github.com/aiosbrain/aios-engineering-harness .harness && rm -rf .harness/.git

# 2. Skills + agents into Claude Code's native locations
mkdir -p .claude/skills .claude/agents
cp -r .harness/skills/* .claude/skills/
cp .harness/agents/*.md .claude/agents/

# 3. Hooks: make executable, then merge settings.json
chmod +x .harness/hooks/*.sh .harness/adapters/run-hook.sh \
  .harness/adapters/claude-code/normalize.sh
# merge adapters/claude-code/settings.json into .claude/settings.json
# (keys: permissions.allow/deny, hooks.PreToolUse/PostToolUse/Stop)

# 4. Contracts
cp .harness/AGENTS.md ./AGENTS.md            # fill the TODOs for your stack
cp .harness/CONSTITUTION.md ./CONSTITUTION.md

# 5. (Optional) the stop-gate check — the leash-lengthener
printf 'make lint && make test\n' > .harness/check   # your repo's real check command
```

Requirements: POSIX shell and `jq`. Safety adapter/configuration failures map to a
block; post-edit formatting remains non-blocking.

## Context injection (SessionStart / SubagentStart)

`settings.json` wires `SessionStart` (matcher `startup|resume|compact`) and
`SubagentStart` to `inject-context.sh`, which emits the CONSTITUTION agent-digest +
a skill index (protocol `1.1` `context` action; see `hooks/PROTOCOL.md`). Translation
quirks, live-verified on Claude Code 2.1.220 (2026-07-25):

- **SessionStart consumes plain stdout.** A top-level `{"additionalContext": ...}`
  JSON body is silently ignored for this event, so the adapter prints the raw text.
- **SubagentStart** uses the documented nested
  `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":...}}`.
  The event does **not** expose the child's task text — the injected digest/index lets
  the child self-route; nothing stronger is claimed.
- Injection failures never block the session (nonzero exit, empty stdout, context lost).
- Headless caveat: project-level `.claude/settings.json` hooks only run after the
  workspace has been trusted **interactively** once; a fresh directory driven purely by
  `claude -p` will not run them (verified 2.1.220 — user-level hooks are unaffected).

## Skill routing (UserPromptSubmit)

`UserPromptSubmit` runs `route-skills.sh`: deterministic, literal, case-insensitive
substring matching of each skill's frontmatter `triggers:` list against the prompt —
regex is never evaluated. Longest matched literal wins (ties: skill name ascending);
at most one pointer is injected per prompt via the REQUIRED nested
`hookSpecificOutput.additionalContext` form (top-level is ignored for this event).
The pointer carries `<!-- aios-skill-route:<skill> -->`; a prompt already containing
that marker for the winning skill injects nothing (marker dedupe — transcript parsing
is banned by design). No match = no output = no action.

The adapter accepts Claude Code's native `PreToolUse`, `PostToolUse`, and `Stop`
payloads and emits protocol `1.0` events. Direct Claude-shaped input to the old hook
paths remains available for the v0 migration window, but new installs use the adapter.
See the [runtime matrix](../../docs/runtime-conformance.md) and Claude Code's primary
[hooks reference](https://code.claude.com/docs/en/hooks).

## Constitution digest injection

Claude Code reads `CLAUDE.md`/`AGENTS.md` automatically. To guarantee the constitution's
agent digest is in every session, add one line to your `AGENTS.md`:

```markdown
Read CONSTITUTION.md's agent-digest block before starting any task; it overrides ad-hoc judgment.
```

or inject it mechanically with a `SessionStart` hook:

```json
{ "SessionStart": [ { "hooks": [ { "type": "command",
  "command": "awk '/agent-digest:start/,/agent-digest:end/' CONSTITUTION.md" } ] } ] }
```

(A `SessionStart` hook's stdout is added to the session context.)

## Multi-model lanes (models/routing.yaml)

Claude Code talks to any Anthropic-compatible endpoint. To run a **bulk-lane** session
(e.g. GLM) per `models/routing.yaml`:

```bash
# a dedicated shell profile/alias, NOT your default:
export ANTHROPIC_BASE_URL="$GLM_BASE_URL"        # provider's Anthropic-compatible URL
export ANTHROPIC_AUTH_TOKEN="$GLM_AUTH_TOKEN"
claude                                            # this session now runs the bulk lane
```

Keep your default shell on the frontier lane. The non-negotiable rule (rubric MG6):
bulk-lane output merges only after a frontier-lane or human review — run
`/code-review` from a frontier session before merging bulk work, and label bulk-lane
PRs (`lane:bulk`) so the gate is auditable.

## Permission rails

`settings.json` ships a conservative read-only allowlist so common non-mutating
commands don't prompt. Extend it from observed usage (approve → add pattern), never
preemptively for mutating commands. `deny` rules on `.env`/keys are the floor — keep
them even if you loosen everything else.
