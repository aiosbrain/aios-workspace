# Rule: Git & Workflow (personal workspace)

Every scaffolded AIOS workspace is a **personal operating environment** — one person's
notes, deliverables, decisions, and client work. It is **not** the AIOS product repo and
**not** a collaborative dev environment.

## Default (almost always)

- Work on **`master` only.**
- **Commit and push after each deliverable draft and each major change — without being asked.**
  A scaffolded workspace is one person's private repo. Finished work sitting uncommitted on a
  laptop is the risk this rule exists to prevent; a commit the owner did not ask for is not.
  Do not batch a session's work into one end-of-day commit, and do not hold a finished draft
  back pending approval.
- Prefer staging the paths your change touched over `git add -A`, so an unrelated in-flight
  edit doesn't ride along in your commit. That is tidiness, not a reason to delay.
- **Ask first** for these, every time — this is the one approval list, and `AGENTS.md` and
  `RESOLVER.md` state it identically: creating feature/topic branches or git worktrees here,
  switching branches, merging, rewriting history (`rebase`, `reset --hard`, force-push), and
  opening PRs. Committing and pushing `master` to this workspace's own remote is **not** on
  the list and needs no permission.
- Research, onboarding notes, `2-work/` drafts, and dogfood observations are **content**,
  not release trains — they do not need branches.

> `git push` and `aios push` are different operations. This section is about `git push`
> — moving your own commits to this workspace's own private remote. `aios push` is the
> outward sync to the Team Brain and is governed by `publishing.md`; nothing in this rule
> makes that automatic.

### What must be true before an automatic `git push`

Pushing without being asked does not mean pushing without checks. Both of these are
mandatory, and a failure **stops the push** — it is not a judgement call:

1. **The repository's own pre-push and pre-commit gates run and pass** — the secret scan,
   the leak gate, and the team-ops guard. Never bypass them (`--no-verify` is not an option
   here). If a gate fails, stop, report exactly what it flagged, and leave the commit
   unpushed.
2. **The remote is a verified private remote for this workspace.** Check it rather than
   assume it (`gh repo view --json isPrivate`, or the equivalent for the host). If the
   remote is public, points somewhere unexpected, or its visibility cannot be determined,
   **do not auto-push**: commit locally, say which check was inconclusive, and let the owner
   decide. Unknown is treated as unsafe, not as private.

When both hold, everything ships — and a workspace that pushes on a normal cadence is also
how the owner gets an off-machine backup of their own context, so silence has a cost too.

## Dogfood here, ship there

| Kind of work | Where it lives |
|--------------|----------------|
| Notes, friction logs, decisions, deliverables | This workspace (`0-context/` … `5-personal/`, `2-work/`, `3-log/`) on `master` |
| Toolkit fixes (scaffold, onboarding, GUI, validators, shared `.claude/` contracts) | **`aios-workspace`** — the product repo you ran `scaffold-project.sh` from |

**This workspace is not a staging area for toolkit PRs.** When dogfooding surfaces a product
bug, write the finding here; implement and PR the fix in **`aios-workspace`**.

## When toolkit architecture must change

Only when changing **workspace architecture** that should ship to everyone (spine layout,
scaffold scripts, validators, onboarding flow, shared agent contracts):

1. Branch or worktree in **`aios-workspace`**, not in this personal workspace.
2. Land the change upstream (PR/merge in the toolkit repo).
3. **Refresh this instance** from upstream (re-scaffold, `aios pull`, or manual sync) — stay on `master` here.

Never maintain a long-lived fork branch in a personal workspace to “port later.” That creates
needless merge pain.

## Agents

If you are an agent: when in doubt, edit markdown in this repo and edit code in
`aios-workspace`. Do not conflate the two.
