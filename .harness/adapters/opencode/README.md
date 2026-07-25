# Adapter — OpenCode

OpenCode uses the same portable policies through a TypeScript plugin. Install from an
adopting repository:

```bash
git clone https://github.com/aiosbrain/aios-engineering-harness .harness && rm -rf .harness/.git
mkdir -p .opencode/plugins .opencode/skills
cp .harness/adapters/opencode/plugin/harness.ts .opencode/plugins/harness.ts
cp .harness/adapters/opencode/normalize.ts .opencode/normalize.ts
cp -R .harness/skills/. .opencode/skills/
cp .harness/AGENTS.md ./AGENTS.md
cp .harness/CONSTITUTION.md ./CONSTITUTION.md
# merge adapters/opencode/opencode.json into the project config
printf 'make lint && make test\n' > .harness/check   # your repo's real check command
```

Requirements: OpenCode, POSIX shell, and `jq`. Pin the OpenCode version during team
rollout; plugin types and event payloads evolve with the runtime.

The plugin normalizes `write`, `edit`, and `apply_patch`/`patch` calls before invoking
the secret and protected-path policies; normalizes `bash` before the destructive
command policy; and formats every edited path after a successful tool call. Safety
normalization or policy failure throws and prevents the pre-tool call. Formatting is
always non-blocking.

OpenCode documents `session.idle`, not a blocking Stop event. On idle the plugin runs
the portable verification gate. A red check injects one skill-anchored continuation
(naming `verify-change` + `systematic-debugging` by absolute path, with the agent
digest and the failed command's capped output tail) through
`client.session.promptAsync`, tracked by a bounded per-session counter that is
cleared on success, on error, and on `session.deleted`; the portable gate enforces
the cap via `stop.loop_count` (`HARNESS_STOP_CAP`, default 1) and at the cap allows
the stop with an honest still-red note. Aborted/errored stops are never continued.
This is intentionally documented as weaker than Claude Code/Codex native Stop hooks.

Skill routing: the `chat.message` hook inspects the incoming user message's text
parts and appends at most one binding skill pointer (from `route-skills.sh`) before
the model call; child sessions run the same hook, so subagents self-route. No match
or any failure appends nothing.

Context injection: the plugin also implements `experimental.chat.system.transform`
(appends the CONSTITUTION agent-digest + skill index from `inject-context.sh` to the
system prompt — live-verified on 1.18.4, 2026-07-25) and
`experimental.session.compacting` (re-injects the same digest into the compaction
context so it survives compaction). The action envelope is validated with
`hooks/validate-action.sh` before use; any injection failure is silent context loss,
never a blocked session. Both hooks exist in the installed plugin types (1.4.8).

The starter config uses current `permission` entries for read-only reviewers. The
legacy per-agent `tools` booleans were deprecated in OpenCode 1.1.1.

Primary sources: [plugins](https://opencode.ai/docs/plugins/),
[permissions](https://opencode.ai/docs/permissions/), and
[agents](https://opencode.ai/docs/agents/).
