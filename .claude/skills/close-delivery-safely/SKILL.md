---
name: close-delivery-safely
description: Close or abandon a delivery worktree after merge or blockage. Verify remote state, ancestry, post-merge behavior, and protected primary state before classifying cleanup as safe, blocked, or owner-decision; never delete dirty or unproven work.
---

# Close delivery safely

1. Fetch the target and record remote PR, merge, and head state.
2. Prove ancestry or content equivalence. For ambiguous squash history, invoke
   `branch-reconciliation`; do not infer from branch names.
3. Run the required post-merge verification against the fetched target SHA.
4. Compare protected primary state with the snapshot captured at worktree start.
5. Inspect worktree dirtiness, unpushed commits, branch containment, and unique content.
6. Classify cleanup as `SAFE`, `BLOCKED`, or `OWNER_DECISION` and state the exact evidence needed
   to proceed. Do not delete anything as part of this judgment step.
7. Return issue or epic handoff facts and distinguish merged code, verified behavior, cleanup, and
   external state.

Never delete a dirty worktree or unproven branch, change Linear state owned by automation, or claim
full completion after partial success.
