# Permission Rails — the `aios rails` tooling (EE7 / AIO-173)

**Status:** the bootstrapping tool for a repo's *permission rails* — the allowlist that pre-approves
safe, repeated tool calls, and the backlog of the guardrails a repo is still missing. It exists for
**clients and un-allowlisted repos**: an operator who has already hand-tuned their allowlist (or
runs in auto-mode) gets little from it. The value is standing up a **safe** allowlist for a fresh
repo without hand-auditing a thousand permission prompts, and naming the rails that aren't there yet.

Sibling contracts: [`build-paradigm.md`](./build-paradigm.md) (how a slice ships) and
[`spec-readiness.md`](./spec-readiness.md) (the spec harness). The backlog reuses
`aios assess-codebase` ([`validation/agent-readiness-lib.mjs`](../../validation/agent-readiness-lib.mjs)).

---

## The core idea: allowlists speed up SAFE repetition — guards and review still gate everything

A Claude Code allowlist (`.claude/settings.json` → `permissions.allow`, entries like
`Bash(npm test:*)` or `Read`) stops the agent asking for permission on calls you have already
decided are fine. That is a pure ergonomics win for the *safe, boring, repeated* calls — running the
tests, checking `git status`, reading files. It is **not** a security relaxation and it does **not**
replace the two things that actually keep a repo safe:

- **Guard hooks** (`PreToolUse`, e.g. [`hooks/team-ops-guard.sh`](../../hooks/team-ops-guard.sh)) —
  they fire on every matching call regardless of the allowlist, and block secrets / off-tier writes.
- **Human review** — the operator reviews what gets allowlisted *before* it is applied.

So the flow is deliberately **suggest → review → apply**, and `apply` only ever touches
`permissions.allow`. It never edits `hooks` or any other settings key. Applying an allowlist can
never disable a guard.

## The "permission-log"

Claude Code session transcripts (`~/.claude/projects/<cwd-slug>/*.jsonl`) record every tool call the
agent made — and for `Bash`, the full command string (`tool_use.input.command`). Two notes on what
is and isn't in the log:

- The `NormalizedEvent` used by `aios analyze` deliberately **drops** the command body (privacy), and
  the `mode` / `permission-mode` records are session-wide autonomy toggles, **not** per-command
  prompts. There is no "this exact command was gated" marker.
- That's fine: the set of commands that were **run** is exactly the set an allowlist would
  pre-approve. So `rails suggest` scans the raw tool-call log (the same source as the built-in
  `fewer-permission-prompts` skill), scoped to the target repo by the record's `cwd`.

## The safety denylist (why a frequent dangerous command is never proposed)

A prefix allowlist entry over-matches by design — `Bash(git status:*)` would auto-approve
`git status && rm -rf /`. So the suggester is conservative in three layers:

1. **Simple-command-only.** A command with any shell operator (`&&`, `||`, `;`, `|`, `` ` ``, `$(`,
   `<`, `>`, newline) is never turned into a proposal. Compound/piped/redirected commands are
   one-offs, and a prefix from their first segment is the classic footgun.
2. **Denied prefixes.** A hardcoded set of first-tokens is never allowlisted no matter how frequent:
   `rm`, `rmdir`, `sudo`, `su`, `chmod`, `chown`, `dd`, `mkfs`, `curl`, `wget`, `kill`/`pkill`,
   `shutdown`/`reboot`, `eval`, `exec`, `dotenvx`, `scp`/`ssh`, `nc`/`telnet`.
3. **Denied patterns.** Regexes over the whole command catch the rest: `sudo`, recursive `rm -rf`,
   `chmod 777`, any `git push` / `git reset --hard` / `git clean -fd`, `--force`, pipe-to-shell,
   network fetches, `npm publish`, fork bombs, `dd if=`, `mkfs`, and any path that looks like a
   secret (`.env`, `.env.keys`, `id_rsa`, `.ssh`, `credentials`, `secrets`, `.pem`, `.p12`,
   `aios-nda`) or a system redirect (`> /etc`, `/usr`, `/bin`, …).

Non-`Bash` tools are only proposed from a small read-only builtin set (`Read`, `Grep`, `Glob`, `LS`,
`NotebookRead`, `TodoWrite`). Everything else — `Write`/`Edit`, all MCP tools — stays gated, on
purpose. The excluded commands are surfaced in the suggest output so you can see *what* was withheld
and *why*, rather than silently dropped.

## Commands

```
aios rails suggest [--repo <path>]      propose a SAFE permissions.allow from the transcript log
  [--min-count N] [--json]              entries seen ≥N (default 3); denylist excludes dangerous cmds
  [--transcripts-dir <dir>]             NEVER writes; guards + human review still gate everything
aios rails apply [--repo <path>]        merge proposals into .claude/settings.json (allow only)
  [--dry-run] [--from <json>]           --dry-run prints the diff; hooks + other keys untouched
  [--min-count N]                       re-runs suggest unless --from feeds a saved suggest --json
aios rails missing [--repo <path>]      list absent rails; reuses assess-codebase scoring
  [--json]                              each item carries a one-line "how to add it" pointer
```

`suggest` aggregates the log by tool + command-prefix, keeps entries seen at least `--min-count`
times (default 3), and prints a human table (with counts), a JSON `permissions.allow` snippet, and
the denylist-excluded tally. `--transcripts-dir` is a test/CI escape hatch that reads an explicit
directory of `*.jsonl` instead of `~/.claude`.

`apply` reads the target `.claude/settings.json` (creating it if absent), merges the proposals into
`permissions.allow` — deduped, sorted, existing entries preserved — and writes atomically. Every
other key (`hooks`, `permissions.deny`/`ask`, `model`, …) is copied through untouched. `--dry-run`
prints the diff and writes nothing. `--from <file>` applies a previously saved `rails suggest --json`
instead of re-scanning.

`missing` is the missing-rails backlog. It reuses the `aios assess-codebase` readiness checks for the
rubric-covered rails (agent instructions, secret scanning, tests, linter, pre-commit hooks, CI) and
adds the AIOS-native rails the general rubric doesn't cover — the **allowlist**, **guard hooks**, and
**leak gate** — each with a one-line pointer to how you'd add it, in remediation-priority order.

## Typical use on a fresh client repo

```
aios rails missing --repo ../their-repo          # what rails are absent?
aios rails suggest --repo ../their-repo           # review the proposed allowlist + what was excluded
aios rails apply   --repo ../their-repo --dry-run # see the exact settings diff
aios rails apply   --repo ../their-repo           # write it (guards untouched)
```

Then add the other rails the backlog named — a CLAUDE.md, a `PreToolUse` guard, a leak gate — the
allowlist alone is only one rail of several.
