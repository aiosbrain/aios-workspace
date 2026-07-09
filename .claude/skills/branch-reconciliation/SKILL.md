---
name: branch-reconciliation
description: Classify every unmerged remote branch as truly-unmerged, already-shipped-under-a-different-hash (squash-merge duplicate), or genuinely stale — with evidence, not guesswork. Use when the user asks "are these branches actually stale", "check unmerged branches", "clean up feature branches", or invokes /branch-reconcile. Classification only — never deletes or merges.
---

You are reconciling unmerged remote branches against `origin/main` so stale-branch cleanup is evidence-based, not vibes-based. The 2026-07-09 audit found ~31 of 54 team-brain branches were byte-identical duplicates of already-merged work under a different commit hash — naive "looks-ready" bucketing by `git log`/diffstat alone was wrong about 80% of the time, because squash-merges and renames (e.g. a `supabase`→`db` rename on main) make merged work look unmerged.

**This skill classifies only. It never deletes, merges, or force-pushes anything.** Deletion happens as separate post-merge cleanup once a human or a later step acts on the table this skill produces.

## Step 1 — enumerate unmerged branches

```bash
git fetch --prune
git branch -r --no-merged origin/main
```

## Step 2 — cheap first pass: patch-equivalence via cherry

For each unmerged branch:

```bash
git cherry origin/main origin/<branch>
```

Every line prefixed `-` means that commit's patch is already present on `origin/main` (possibly under a different hash — squash-merge or cherry-pick). **If every line is `-`, bucket immediately as (b) already-shipped-duplicate** — find the matching main commit as evidence:

```bash
git log origin/main --grep="<commit subject from the branch>" --oneline
```

Branches fully resolved here need no further investigation.

## Step 3 — for branches with `+` (non-patch-equivalent) commits, content-compare against CURRENT main

A `+` from `git cherry` does not mean the work is missing — it can mean the diff no longer applies cleanly because main moved (a rename/refactor), not that the content itself is absent. Check per file:

```bash
git diff origin/main...origin/<branch> --name-only
```

For each changed file, compare content directly against current main (not against the merge-base):

```bash
git diff origin/main:<file> origin/<branch>:<file>
```

Also check whether a PR/commit for this branch already landed under different terms:

```bash
gh pr list --state merged --head <branch>
git log origin/main --grep "<branch-name-derived-keywords>" --oneline
```

If content is functionally identical to current main (accounting for the rename/refactor), reclassify to (b) with the matching evidence. If content is genuinely absent from main, it stays a candidate for (a) or (c).

## Step 4 — real read only for branches surviving steps 2–3

For whatever remains (not proven duplicate), do the actual judgment work: what does the branch contain, is it shippable as-is, what's the risk of merging it now (conflicts, staleness of its base, whether the feature is still wanted). This is the only step that needs sonnet-tier reasoning — steps 1–3 are mechanical.

## Step 5 — output one classification table

```
BRANCH                          CLASS                        EVIDENCE                          ACTION
feat/foo-old                    (b) shipped-duplicate         merged in PR #142 (abc1234)       delete-with-evidence
feat/bar-experiment              (c) stale/abandoned           last commit 2025-11, no PR, no ref  needs-owner-decision
feat/baz-in-flight               (a) truly unmerged            content diff vs main confirmed    needs-owner-decision (merge candidate)
```

Classes:
- **(a) truly-unmerged-with-live-content** — content genuinely absent from main.
- **(b) already-shipped-under-a-different-hash** — squash-merge/cherry-pick duplicate; safe to delete, evidence attached.
- **(c) genuinely stale/abandoned** — no matching main commit, no open PR, no recent activity.

Recommended action is one of: `merge`, `delete-with-evidence`, `needs-owner-decision`. Do not execute any of these — hand the table back to the user or a separate cleanup step.
