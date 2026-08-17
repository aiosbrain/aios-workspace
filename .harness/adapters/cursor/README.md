# Cursor adapter

Wires the portable `hooks/` policies into [Cursor Agent hooks](https://cursor.com/docs/agent/hooks)
(`.cursor/hooks.json`, `version: 1`). Cursor is a first-class runtime: its native
payloads are normalized to protocol `1.0` by `normalize.sh`, exactly like Codex/Claude.

## Why Cursor is a clean fit

Cursor honors **exit code `2` = deny** (equivalent to returning `permission: "deny"`),
so the policies' native exit codes flow straight through `run-hook.sh` — no
permission-JSON translation is needed for edits or commands. `failClosed: true` on the
safety hooks makes an unexpected hook failure block rather than fall open.

## Which repo a hook applies to (payload-cwd dispatch)

This is the one place Cursor differs structurally from the other runtimes, and getting
it wrong produced both of the failure modes people actually hit.

`.codex/hooks.json` resolves `git rev-parse --show-toplevel` **per invocation**. Claude
Code uses `${CLAUDE_PROJECT_DIR}`, which is correct because a Claude session is
single-root by construction. Cursor's `${CURSOR_PROJECT_DIR}` is **one root, chosen when
the window opened** — in a multi-root window it may name a repo the agent is not
touching, and one that vendors no harness at all. Keying the dispatch on it meant:

- anchored on a repo without the harness → the marker test found nothing → **exit 0, the
  guards never ran**, silently, for the whole session; and
- an unwrapped `/bin/sh <path that does not exist>` → exit 127 → `failClosed` → **every
  edit and shell call in the session denied**.

Cursor does send a real `.cwd` for `beforeShellExecution` and `preToolUse` — `normalize.sh`
already prefers it (`cwd: (.cwd // $cwd)`); only the dispatch decision ignored it. So each
entry in `hooks.json` is now a **locator**: read stdin once, resolve the repo root from the
payload, check the marker there, re-emit the captured payload into `cursor/dispatch.sh`.
Everything past that decision is in `dispatch.sh`, which is tracked and testable rather
than nine copies of a one-liner. `dispatch.sh` re-exports `CURSOR_PROJECT_DIR` as the
resolved root so `normalize.sh`'s own fallback agrees with the dispatch decision.

`${CURSOR_PROJECT_DIR}` survives as the **second** candidate, never a replacement:

| Event | Location signal used |
|---|---|
| `beforeShellExecution`, `preToolUse` | payload `.cwd` (the fix) |
| `afterFileEdit` | payload `.file_path`'s directory — the only location it carries |
| `stop`, `sessionStart` | the window anchor: these are session-scoped and no per-repo answer exists |

Keeping the anchor in the list is also what makes the payload safe to trust: a
payload-supplied cwd can only ever **add** a candidate root, so agent-authored text (a
file whose *content* contains `"cwd": …`) cannot remove the anchor and switch enforcement
off. Marker absent at every candidate → exit 0. Marker present but the dispatcher missing
→ exit 3, so a deleted guard is loud rather than silently unenforced.

## Missing `jq` is an environment failure, not a policy violation

Every portable policy parses its event with `jq` and answered a missing `jq` with exit 3,
which the adapter maps to a native block. On Claude Code and Codex that costs one tool
call. On Cursor, `failClosed: true` turns it into a deny for **every** edit and shell call
in the session — including `brew install jq`, so the deadlock cannot be cleared from
inside the session that hit it.

`adapters/jq-preflight.sh` holds the decision: name the missing tool, say how to install
it, say plainly that the guards are not enforcing, then **allow**. Loudly unenforced,
never silently unenforced, never bricked — and the commit-time backstop
(`hooks/git/pre-commit-primary-guard`) does not depend on `jq`. Set `HARNESS_REQUIRE_JQ=1`
to fail closed on a missing interpreter instead.

## Event mapping

| Harness event | Cursor hook | Policies | Blocks? |
|---|---|---|---|
| `pre_command` | `beforeShellExecution` | guard-destructive, guard-worktree | yes (exit 2) |
| `pre_edit` | `preToolUse` (matcher `Write\|Edit\|MultiEdit`) | guard-secrets, guard-protected-paths, guard-worktree | yes (exit 2) |
| `post_edit` | `afterFileEdit` | post-edit-format | no (formatting only) |
| `stop` | `stop` → `cursor/stop-gate.sh` | stop-verify-gate | continues via `followup_message` |

Unlike the review's initial assumption, Cursor **can** block an edit *before* it lands:
`preToolUse` fires before the `Write`/`Edit` tool and supports `permission: deny`. So
secrets/protected-paths/worktree are enforced pre-write, not just detected after.

`stop` is the one event that doesn't use an exit code — Cursor continues the agent when
the hook prints `{"followup_message": "..."}`. `cursor/stop-gate.sh` runs the portable
verify-gate and emits that message on a red `.harness/check`.

## Context injection

Cursor's **guaranteed** context path is the generated always-apply rule
`.cursor/rules/harness-context.mdc` (agent-digest + skill index), written by
`install.sh` from `inject-context.sh` output and regenerated on every install — never
hand-edit it. The native `sessionStart` hook in `hooks.json` is an **additive,
smoke-gated enhancement** (marker smoke passed on cursor-agent 2026.07.23,
2026-07-25): it injects the same content via `{"additional_context": ...}` but never
replaces the rule. `beforeSubmitPrompt` remains validation-only and is not used for
injection. Injection failures never block a session.

Skill routing on Cursor is **static-rule routing**: the generated rule also carries
the literal trigger→skill map (`route-skills.sh --emit-map`), so the model matches
triggers itself from the always-applied rule text. This is honestly weaker than the
dynamic per-prompt injection Claude/Codex/OpenCode get and is never claimed as
native dynamic injection.

## Install

```sh
.harness/install.sh --runtime cursor
```

The installer never overwrites an existing `.cursor/hooks.json`: it writes
`.cursor/hooks.json.harness-incoming` for an explicit manual merge. It also refuses to
overwrite a pre-existing merge artifact.

## Honest limitations / thin spots

- **`afterFileEdit` carries no `cwd`** and cannot block (the edit already landed); it is
  used only for non-blocking formatting. Dispatch locates it by its `file_path`, and the
  normalized event's `cwd` falls back to the dispatch-resolved root.
- **`preToolUse` `tool_input` shape** for the built-in edit tools is normalized
  defensively (`file_path` / `filePath` / `path` / `target_file`, plus `content`,
  `new_string`, `newString`, and edit-array aliases). If a future Cursor build renames
  those fields, protocol validation fails closed instead of allowing an unscanned edit.
  Confirmed against the documented payloads as of 2026-07.
- **`stop` recursion**: `verification_loop_active` is derived from `loop_count > 0`;
  pair with Cursor's own `loop_limit` in `hooks.json` for a hard ceiling.
