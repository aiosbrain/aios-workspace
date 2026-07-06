# Rule: Git & Workflow (personal workspace)

Every scaffolded AIOS workspace is a **personal operating environment** — one person's
notes, deliverables, decisions, and client work. It is **not** the AIOS product repo and
**not** a collaborative dev environment.

## Default (almost always)

- Work on **`master` only.** Commit when the owner asks — snapshots of *their* context.
- **Do not** create feature branches, topic branches, or git worktrees in this workspace.
- **Do not** switch branches, merge branches, push branches, or open PRs here unless the
  owner **explicitly** asks.
- Research, onboarding notes, `2-work/` drafts, and dogfood observations are **content**,
  not release trains — they do not need branches.

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
