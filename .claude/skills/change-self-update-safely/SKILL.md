---
name: change-self-update-safely
description: Change `aios update`, toolkit pull, re-exec, contribution worktrees, scheduler refresh, or version handoff behavior. Use to preserve preview and mutation boundaries, dirty state, source proof, runtime environment, recovery, and fail-closed semantics.
---

# Change self-update safely

1. Separate `--check` or preview from mutation and ensure preview performs no writes, stash, reset,
   checkout, clean, re-exec, scheduler, or network mutation.
2. Prove toolkit root, remote, source envelope, branch, and fetched base before mutation.
3. Record dirty state and ownership. Never silently stash, reset, or clean; preserve user-authored
   config through the repository's merge or sidecar policy.
4. Define pull, generated rebuild, version stamp, re-exec, and scheduler handoff as explicit stages
   with recoverable artifacts.
5. Preserve Node or runtime, environment, cwd, arguments, and exit status across child and
   scheduled processes.
6. Test interrupted pull, stale base, missing remote or root, dirty checkout, conflict, re-exec
   failure, ABI mismatch, and rollback.
7. Fail closed when identity or recovery cannot be proven and return an actionable state report.

Do not cover ordinary dependency bumps or introduce implicit destructive cleanup.
