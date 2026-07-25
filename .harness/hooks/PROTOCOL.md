# Portable hook event protocol

The protocol is the boundary between runtime adapters and portable policy. Runtime
adapters normalize their native payloads to one JSON object on stdin; scripts in
`hooks/` must not parse Claude Code, Codex, or OpenCode payloads directly.

Protocol `1.1` adds three input events (`session_start`, `subagent_start`,
`user_prompt_submit`) and a policy **output action envelope**. `1.0` events remain
valid unchanged; all three new events require `protocol_version: "1.1"`.

Common fields are `protocol_version`, `event`, `runtime.name`, `cwd`, and optional
`session_id`, `tool_name`, and `tool_id`. Event fields are:

| Event | Required fields |
|---|---|
| `pre_edit` | `paths[]`, `added_content[]` (content introduced by the edit only) |
| `pre_command` | `command` |
| `post_edit` | `paths[]` |
| `stop` | `stop.verification_loop_active`; optional normalized `stop.stop_status` (`ok`, `failed`, `aborted`, `error` — aborted/error stops are never continued) and `stop.loop_count` (EXACT continuations already taken — only runtimes with a real counter send it; the gate stops at `HARNESS_STOP_CAP`, default 1, and always re-verifies the check before claiming it is still red). A runtime that can only signal a binary continuation flag omits `loop_count` and is bounded at one continuation regardless of cap |
| `session_start` | `session_start.phase` (`startup`, `resume`, or `compact`) |
| `subagent_start` | `subagent_start` (optional `agent_type`, `agent_id` — no runtime exposes the child's task text, so the protocol does not carry it) |
| `user_prompt_submit` | `prompt` (the user's submitted text, verbatim) |

Each path has an `action` (`add`, `update`, `delete`, `rename`, or `unknown`). A rename
uses the destination as `path` and the source as `from`. The normative machine shape
is [`protocol.schema.json`](protocol.schema.json).

Portable scripts have three outcomes: `0` allows, `2` is a policy block, and `3`
means the event or local configuration could not be evaluated. Safety adapters map
`3` to a native block. Post-edit formatting always maps failures to allow.

## Output action envelope (1.1)

Guard policies communicate by exit code only and print diagnostics to stderr.
**Context policies** (`inject-context.sh`, `route-skills.sh`) additionally print at
most one JSON action envelope on stdout — empty stdout with exit `0` is a deliberate
no-action (e.g. no trigger matched) and adapters emit nothing native for it:

```json
{"protocol": "1.1", "action": "context", "text": "…injected context…"}
```

`action: "continue"` (with `reason`) is reserved for the stop-continuation policy.
`text`/`reason` are capped at 8,000 bytes (below the strictest model-visible runtime
allowance — Codex's ~2,500-token hook-output limit). Adapters MUST validate the
envelope with [`validate-action.sh`](validate-action.sh) (machine shape:
`$defs.action` in the schema) **before** translating it to a runtime-native shape,
and must emit nothing native when validation fails. Policy stdout (the action
channel) and stderr (diagnostics) are never mixed. Portable policies never print
runtime-native JSON — translation lives in the adapter layer only.

Direct Claude-shaped input to the top-level hook scripts remains supported for the
v0 migration window. New installations must invoke the Claude adapter. Direct
runtime-shaped parsing inside policy is deprecated and Codex/OpenCode payloads are
accepted only by their adapters.

Set `HARNESS_TRACE_FILE` to capture normalized JSONL evidence. The file must be under
a directory named `scratch` or `results`; tracing is off by default. Trace records may
contain command or added-content evidence, so they are evaluation artifacts and must
not be committed.
