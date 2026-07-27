---
name: change-installer-safely
description: Change install, onboarding, workspace hydration, config merge, skill installation, or uninstall behavior. Use to preserve user-authored state while testing idempotency, collisions, symlink or path escape, modes, dependencies, partial failure, rollback, and supported runtimes and platforms.
---

# Change an installer safely

1. Define source ownership and destination policy for managed, seed-if-absent, personal, generated,
   and unmanaged files.
2. Test clean install, rerun, upgrade, downgrade or recovery, collision, locally committed edit,
   uncommitted edit, missing dependency, and partial failure.
3. Reject symlink or path escape and destination ambiguity before writes. Preserve executable modes
   and platform-correct path behavior.
4. Merge or sidecar conflicts according to the canonical ownership policy; never silently replace
   user-authored config or dirty state.
5. Make every mutation recoverable with a pre-write snapshot or deterministic rollback artifact.
6. Run scratch install matrices across supported runtimes, contexts, and platforms, including
   actual packaged output.
7. Return the ownership matrix, failure or rollback behavior, and exact smoke evidence.

Do not cover self-update pull or re-exec semantics or replace install smoke tests with prose.
