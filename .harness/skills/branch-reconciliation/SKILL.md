---
name: branch-reconciliation
description: Classify every unmerged remote branch as truly-unmerged, already-shipped-under-a-different-hash (squash-merge duplicate), or genuinely stale — with evidence, not guesswork. Use when asked "are these branches actually stale", "check unmerged branches", "clean up feature branches". Classification only — never deletes or merges.
source: AIOS toolkit skill, born from a 2026 audit where ~31 of 54 "unmerged" branches were byte-identical duplicates of already-merged work
am_pattern: B5
triggers:
  - unmerged branch
  - diverged branch
  - reconcile branches
  - stale branches
  - which branches are merged
---

You are reconciling unmerged remote branches against the default branch so stale-branch
cleanup is evidence-based, not vibes-based. Naive "looks ready" bucketing by
`git log`/diffstat alone is wrong most of the time in squash-merge workflows: merged
work looks unmerged because it landed under a different commit hash, and renames on the
default branch make identical content diff dirty.

**This skill classifies only. It never deletes, merges, or force-pushes anything.**
Deletion is a separate, human-approved cleanup acting on the table this skill produces.

Let `MAIN` be the default branch (`git symbolic-ref refs/remotes/origin/HEAD` or ask).

## Step 1 — enumerate

```bash
git fetch --prune
git branch -r --no-merged origin/MAIN
```

## Step 2 — cheap first pass: patch-equivalence

For each unmerged branch:

```bash
git cherry origin/MAIN origin/<branch>
```

Every `-` line means that commit's patch already exists on MAIN (under a different hash
— squash-merge or cherry-pick). **If every line is `-`, bucket immediately as
(b) shipped-duplicate**, with the matching MAIN commit as evidence:

```bash
git log origin/MAIN --grep="<commit subject from the branch>" --oneline
```

## Step 3 — for branches with `+` commits, content-compare against CURRENT MAIN

A `+` does not mean the work is missing — often the diff just no longer applies because
MAIN moved (rename/refactor). Check per file:

```bash
git diff origin/MAIN...origin/<branch> --name-only
git diff origin/MAIN:<file> origin/<branch>:<file>   # against CURRENT MAIN, not merge-base
```

Also check whether the work landed under different terms:

```bash
gh pr list --state merged --head <branch>        # if the repo uses GitHub
git log origin/MAIN --grep "<branch-derived-keywords>" --oneline
```

Functionally identical content → reclassify (b) with evidence. Genuinely absent → stays
a candidate for (a) or (c).

## Step 4 — real judgment, only for survivors

For branches not proven duplicate: what does it contain, is it shippable, what's the
merge risk (conflicts, stale base, is the feature still wanted). This is the only step
needing real reasoning — steps 1–3 are mechanical.

## Step 5 — one classification table

```
BRANCH               CLASS                      EVIDENCE                              ACTION
feat/foo-old         (b) shipped-duplicate      merged in PR #142 (abc1234)           delete-with-evidence
feat/bar-experiment  (c) stale/abandoned        last commit 8mo ago, no PR, no ref    needs-owner-decision
feat/baz-in-flight   (a) truly unmerged         content diff vs MAIN confirmed        needs-owner-decision (merge candidate)
```

Actions are recommendations only (`merge` · `delete-with-evidence` ·
`needs-owner-decision`). Hand the table back; execute nothing.
