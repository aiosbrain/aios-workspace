# AIOS Workspace — agent guide

The operating manual for this repo lives in **[CLAUDE.md](CLAUDE.md)** — read it first.
It covers what the toolkit is, the repo map, the workspace spine + access-tier safety
boundary, the pinned `docs/brain-api.md` sync contract, and the do-not list.

## Review evidence

Local Bugbot is optional and is not a repository-wide completion or merge prerequisite. For a
pushed PR, green required CI plus at least one substantive current-head cloud Bugbot or CodeRabbit
review with no unresolved findings is sufficient review evidence. The lifecycle adapters may still
run `hooks/local-bugbot-gate.mjs` as an advisory local check, and `aios build` / `aios ship` may run
local review as part of their own operator workflow; neither makes Local Bugbot mandatory for a PR
that already has qualifying cloud review. Address every substantive Medium-or-higher finding from
any reviewer, but do not block an otherwise clear PR solely because Local Bugbot is unavailable,
returns a protocol error, or cannot review an unrelated worktree.
