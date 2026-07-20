# AIOS Workspace — agent guide

The operating manual for this repo lives in **[CLAUDE.md](CLAUDE.md)** — read it first.
It covers what the toolkit is, the repo map, the workspace spine + access-tier safety
boundary, the pinned `docs/brain-api.md` sync contract, and the do-not list.

## Required local Bugbot gate

Any task that changes this repository must pass the local Bugbot review before an agent
declares completion or merges. Its code and security passes both block on Medium-or-higher
findings. The shared gate
is `hooks/local-bugbot-gate.mjs`; project lifecycle adapters run it for Claude Code, Codex,
Cursor, and OpenCode; blocked evidence is cached only for the exact current diff, while a clear
verdict must come from a real review and is never trusted from disk. Never bypass
or disable the gate. If a runtime reports that its project hook is untrusted or unavailable,
trust/enable the checked-in hook and rerun it rather than treating the check as optional.
OpenCode currently provides only a post-idle event, so its plugin re-prompts on failure and the
aligned `aios build`/`aios ship` gate remains the hard pre-merge boundary for that runtime.
