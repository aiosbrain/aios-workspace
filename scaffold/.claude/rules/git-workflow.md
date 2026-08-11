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
- **Do not** create feature branches, topic branches, or git worktrees in this workspace.
- **Do not** switch branches, merge branches, rewrite history (`rebase`, `reset --hard`,
  force-push), or open PRs here unless the owner **explicitly** asks. Pushing `master` to the
  workspace's own remote is routine and needs no permission; everything else in this list is
  not routine and does.
- Research, onboarding notes, `2-work/` drafts, and dogfood observations are **content**,
  not release trains — they do not need branches.

### The only two things that stop a push

1. A **secret** in the diff — a real credential, token, or key.
2. **NDA or client material** heading somewhere it should not go.

Surface either instead of pushing, and say plainly what you found. Everything else ships. A
workspace that pushes on a normal cadence is also how the owner gets an off-machine backup of
their own context, so silence here has a cost.

> If a workspace's remote is not private, the owner should say so in their own `AGENTS.md` —
> this default assumes the private, single-owner repo that `scaffold-project.sh` creates.

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
