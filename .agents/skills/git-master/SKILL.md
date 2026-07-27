---
name: git-master
description: "Use whenever a task needs a commit or a git-history investigation. Covers atomic commits, staging by hunk, detecting commit-message style, rebase/squash/fixup/autosquash, blame, bisect, reflog, git log -S/-G, and questions like who wrote this or when was this added. Do NOT use for ordinary code edits unless the user asks for git work. Complements branch-reconciliation (which only classifies branches)."
source: oh-my-opencode `git-master` (de-omo'd — dropped the PostHog/attachment-upload specifics); pairs with AIOS branch-reconciliation
am_pattern: C4
triggers:
  - rebase
  - cherry-pick
  - merge conflict
  - squash commits
  - git history
  - atomic commits
  - stage by hunk
  - bisect
---

# Git Master

Use this skill when asked to operate on git history or answer a git-history question. Be exact, conservative, and evidence-led. Read the repository state before you infer anything.

## Mode gate

Classify the request first:

- `COMMIT`: stage and commit local changes.
- `REBASE`: rebase, squash, fixup, autosquash, reorder, split, or otherwise rewrite branch history.
- `HISTORY`: answer when, where, who, why, or which commit changed something.
- `STATUS`: inspect branch, diff, or working-tree state without changing it.

Do not commit, rebase, push, force-push, reset, stash-pop, bisect, or delete anything unless the user explicitly asked for that operation. If the request is only investigative, report findings and stop.

## Ground truth

Gather independent facts first (in parallel when the tools allow):

```bash
git status --short
git diff --stat
git diff --staged --stat
git branch --show-current
git log -30 --oneline
git rev-parse --abbrev-ref @{upstream}
git merge-base HEAD origin/main
git merge-base HEAD origin/master
```

Missing upstream or missing `main`/`master` is normal. Fall back to the best available branch or report the missing fact. Never treat a failed lookup as proof.

> Worktree rule: this repo blocks feature commits in the primary checkout (see the
> worktree guard). Do commit work in a linked worktree, not on a branch checked out in
> the primary. If the guard blocks you, that is the answer — do not search for or use
> a bypass; report the block and let a human decide the exception.

## Commit mode

Commit only the user's requested changes. Preserve unrelated dirty work.

1. Detect message style from recent history. Use the dominant local pattern, language, and casing. Do not default to Conventional Commits unless the repo uses them.
2. Inspect the full diff, not only filenames. Separate unrelated user edits from the requested commit.
3. Build atomic groups by behavior, module, and revertability. Keep implementation and its direct tests together.
4. Prefer multiple commits for unrelated concerns. A single commit is acceptable only when the changed files form one indivisible behavior or the user explicitly asks for one commit.
5. Stage by path or hunk so each commit contains only its atomic group.
6. Before each commit, verify `git diff --staged --stat` and enough of the staged diff to prove the group is right.
7. Commit in the detected style. After each commit, verify `git log -1 --oneline`.

Grouping rules: split different features, modules, generated artifacts, config, docs, and test-only changes unless they are inseparable; keep generated files with the source change that produced them when omitting them would leave the repo inconsistent; never hide failing or unrelated changes inside a broad commit.

Final report: list commit hashes, messages, and any remaining uncommitted files.

## Rebase mode

History rewriting is a shared-impact operation.

- Never rebase or rewrite `main`, `master`, `dev`, release branches, or any protected branch unless the user explicitly named that exact operation.
- Force-pushing rewrites remote history — never do it on your own judgment. Immediately
  before the push, state the exact remote and branch and get explicit confirmation for
  that specific push (a prior blanket approval does not count); otherwise report the
  command you would run and stop. Use `--force-with-lease`, never plain `--force`.
- If the worktree is dirty, preserve it intentionally before rebasing. Do not stash-pop over conflicts without checking what changed.
- For fixups, prefer `git commit --fixup=<hash>` then `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`.
- For conflicts, read the conflicting files and resolve by intent. Do not choose ours/theirs blindly.
- If a rebase goes wrong, `git rebase --abort` first. Use reflog only after explaining the recovery path.

After rewriting, run the relevant tests (or at least the project's cheapest smoke check), then show the new branch log from base to HEAD.

## History mode

Choose the tool by the question:

- `git log -S "text"` — when the count of an exact string changed.
- `git log -G "regex"` — when diffs touched lines matching a pattern.
- `git blame -L start,end -- file` — who last changed specific lines.
- `git log --follow -- file` — history across renames for one file.
- `git show <hash>` — inspect the commit that appears relevant.
- `git bisect` — find the first bad commit when there is a deterministic pass/fail command and known good/bad bounds. **State-changing**: it moves the checkout and can execute a supplied command, so gate it like a write — explicit user request, clean or deliberately preserved worktree, a user-approved test command, and `git bisect reset` as the recovery path.
- `git reflog` — recover or explain recent local history movement.

Always cite the exact evidence: commit hash, subject, file path, and line/diff context. If the evidence is ambiguous, say what remains unproven.

## Safety checks

Before any write to git history: the current branch is known; dirty work is accounted for; upstream/pushed status is known or explicitly unknown; the operation matches the user's request; the recovery path is known (`rebase --abort`, a reflog hash, or an untouched worktree).

Before finishing: run the most relevant verification available for the changed behavior or history operation; report commands that passed and any you could not run; leave the worktree state explicit.
