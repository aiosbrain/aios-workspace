# Runtime capability and conformance matrix

> Verified locally on 2026-07-17 with Claude Code 2.1.212, Codex CLI 0.144.5,
> OpenCode 1.18.2, Bash 3.2, jq 1.7.1, and Bun 1.2.23.

The portable unit is the versioned [hook event protocol](../hooks/PROTOCOL.md), not
one runtime's payload. Claude Code, Codex, and OpenCode are first-class adapters with
different lifecycle strengths. “Conformant” means an adapter normalizes its available
events and maps policy outcomes correctly; it does not mean the runtimes expose
identical interception points.

## Capability matrix

| Capability | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Pre-edit interception | Native `PreToolUse`; exit 2 blocks | Native `PreToolUse`; `apply_patch` plus `Edit`/`Write` matcher aliases | Plugin `tool.execute.before`; throwing blocks the tool |
| Pre-command interception | Native `PreToolUse(Bash)` | Native `PreToolUse(Bash)` | Plugin `tool.execute.before` for `bash` |
| Post-edit formatting | Native `PostToolUse` | Native `PostToolUse` | Plugin `tool.execute.after` |
| Stop verification | Native `Stop`; exit 2 continues the turn | Native `Stop`; exit 2 continues the turn | No equivalent blocking stop hook documented; plugin reacts to `session.idle` and injects one continuation prompt |
| Recursion signal | Native `stop_hook_active` | Compatibility-shaped `stop_hook_active` in the current hook surface | Adapter-maintained per-session one-shot state |
| Native payload adapter | POSIX shell + jq | POSIX shell + jq; parses multi-file patches, rename destinations, and added lines | TypeScript plugin; normalizes tool arguments before invoking POSIX policies |
| Policy failure behavior | Safety normalization/evaluation failure maps to block | Safety normalization/evaluation failure maps to block | Pre-tool failures throw; idle failures request diagnosis; formatter failures are ignored |
| Enforcement caveat | Hooks run inside the runtime and are not a substitute for permissions/CI | Hooks require project and hook trust; sandbox/managed policy remains the outer boundary | The idle continuation is cooperative prompt injection, weaker than a native stop block |

Primary contracts: [Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://developers.openai.com/codex/hooks),
[OpenCode plugins](https://opencode.ai/docs/plugins/), and
[OpenCode permissions](https://opencode.ai/docs/permissions/).

## Normalized evidence

Every adapter emits protocol `1.0` objects with common runtime, working-directory,
session, and tool metadata when available. `pre_edit` carries all changed paths and
only introduced content; this is what allows secret removal while rejecting secret
addition. Renames include both source and destination. `stop` carries the adapter's
one-shot loop state.

`HARNESS_TRACE_FILE` optionally adds each evaluated event and outcome to JSONL. It is
disabled by default, accepts only paths under `scratch/` or `results/`, and exists for
the eval lab—not general telemetry. Raw traces can contain command or edit evidence
and remain gitignored.

Behavioral runs keep that raw data in `hook-events.jsonl`. The ordered grading stream
in `events.jsonl` comes from the runtime transcript, with matching check statuses
replaced by fixture-emitted numeric exit codes. Native status is used only when a check
has no fixture record; output strings such as `FAILED` are never treated as exit status.

## What the conformance tests prove

`bash evals/guards.test.sh` preserves the original 49 policy cases and adds conservative
plain-force-push regressions. `python3 evals/evidence.test.py` replays sanitized Claude,
Codex, and OpenCode transcript shapes, and `bash evals/graders.test.sh` exercises diff,
ordering, scope, and restored Variant B behavior.
`bash evals/conformance.test.sh` adds native fixtures for all three runtimes, malformed
and missing-dependency behavior, nested repository roots, multi-file formatting,
renames, trace capture, and OpenCode loop protection. Runtime smoke tests validate
that installed CLIs load the shipped configuration. Live adversarial checks are
recorded as eval artifacts, not promoted into a claim of permanent lifecycle parity.

## Zed and ACP

Zed/ACP is a client surface, not a fourth hook implementation. When Zed hosts Claude
Code, Codex, or OpenCode through ACP, enforcement strength is inherited from that
backing runtime and its loaded configuration. Zed's own agent does not become
conformant merely because it reads `AGENTS.md`.

## Known gaps

- OpenCode's stop gate is prompt-based and cannot claim the same blocking semantics
  as Claude Code or Codex.
- Hook coverage is defense in depth. Filesystem sandboxing, managed policy, review,
  and CI are still needed for organization-critical controls.
- The destructive guard deliberately blocks every plain `git push --force` and
  `git push -f`, even for explicit feature branches. Use `--force-with-lease` or set
  `HARNESS_ALLOW_DESTRUCTIVE=1` only after explicit approval.
- Native payload schemas and tool names change. A new edit path is unsupported until
  it has a fixture and an adversarial smoke test.
- Local smoke results show configuration compatibility at the pinned versions, not
  cross-version or cross-surface guarantees.
