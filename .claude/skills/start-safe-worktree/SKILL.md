---
name: start-safe-worktree
description: Begin implementation safely in an AIOs repository when a task names or needs a branch or worktree. Resolve the repository, issue, owner, base, and branch; snapshot primary dirty state; and hand off a hydrated worktree without stashing, resetting, cleaning, or implementing.
---

# Start a safe worktree

1. Resolve the intended repository, issue, owner, merge target, target branch, and fetched base.
   Do not guess an ambiguous target.
2. Record the primary checkout path, branch, HEAD, porcelain status, and hashes of dirty protected
   files without modifying them.
3. Fetch the intended base and verify the base SHA is the expected remote ref.
4. Use `aios worktree add <branch> --base <ref>` for mechanics and hydration.
5. Confirm the resulting checkout is a linked worktree at the verified base and that one
   editor/owner controls it.
6. Return worktree path, branch, base SHA, primary snapshot, and any hydration warning.

Never stash, reset, clean, fast-forward the primary, create a second writable owner, or implement
the task.
