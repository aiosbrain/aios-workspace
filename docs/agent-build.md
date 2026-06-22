# aios build — implement an approved plan with Opus, reviewed by Cursor

`aios build` is the **build** half of the agent relay. Where [`aios relay`](./agent-relay.md)
produces an _approved plan_ (the planning half), `aios build` _implements_ it: **Opus** (via the
Claude Code CLI) writes the code on an **isolated git worktree**, the `/ai-code-review` Cursor skill
reviews the **real diff**, and the loop repeats until the reviewer emits `MERGE_READY` or the round
budget is spent. A fail-closed secrets gate runs before any merge, and merging is opt-in. This
mirrors the plan phase — **Opus produces, Cursor reviews** — keeping model diversity in the loop.

```
PLAN  (aios relay)                          BUILD  (aios build)
Opus 4.8 ⇄ Cursor /review-plan              Opus (Claude Code) ⇄ Cursor /ai-code-review
   → PLAN_READY  → approved plan  ───────▶     → MERGE_READY  → secrets gate → merge
```

It is wired into the `aios` CLI (`scripts/build.mjs`, exposed as `aios build`). Run it through the CLI:

```bash
npm run aios -- build "<plan-file>" [branch] [options]
```

---

## Prerequisites

| Requirement       | How to check       | Notes                                                       |
| ----------------- | ------------------ | ---------------------------------------------------------- |
| Node 18+          | `node --version`   |                                                            |
| `claude` CLI      | `claude --version` | Claude Code — the **builder** (Opus implements the plan)   |
| `cursor` CLI      | `cursor --version` | The **reviewer** (`/ai-code-review`)                       |
| `/ai-code-review` | skill file present | `~/.cursor/skills/ai-code-review/SKILL.md` — the reviewer  |
| a git repo        | `git status`       | build runs in a **worktree** off `origin/main`             |

`aios build` does **not** need `ANTHROPIC_API_KEY` — the builder runs through Claude Code, which uses
its own authentication.

---

## The plan → build handoff

The contract between the two phases is **a markdown plan**. Two ways it reaches the builder:

- **File** (`aios build plan.md`): point at the relay's `--log` output. If the file has an
  `## Approved plan` section, that section is used; otherwise the `## Last plan` section; otherwise
  the whole file. (If the first argument is not a readable file it is treated as an inline task and
  plan review is skipped — pass `--task` to be explicit.)
- **In-memory** (`aios relay … --build`): the relay hands the approved plan straight to the build
  phase, no file round-trip. See "Chained one-shot" below.

---

## Full usage

```
npm run aios -- build <plan-file|task> [branch] [options]

Arguments:
  <plan-file>   Approved plan (a relay --log file). If not a readable file, treated as an inline task.
  [branch]      Worktree branch to build on (optional; auto-derived: feat/aios-build-<slug>).

Options:
  --task              treat the first argument as an inline task, not a file path
  --rounds N          max build/review cycles (default: 4)
  --build-timeout N   seconds before killing a stalled builder call (default: 1800)
  --cursor-timeout N  seconds before killing a stalled review call (default: 300)
  --skill /name       Cursor review skill (default: /ai-code-review)
  --verify "<cmd>"    run this in the worktree before each review; a failure loops feedback
                      to the builder without spending a review round (e.g. "npm test")
  --base <ref>        base ref the new worktree branch is created from (default: origin/main)
  --worktree <path>   worktree directory (default: ../<repo>-<branch-slug>)
  --merge             on approval, merge into the PRIMARY checkout's current branch
                      (NOT --base). OFF by default — check out your target first, or
                      omit --merge and merge the branch yourself.
  --no-gate           skip the pre-merge secrets gate (NOT recommended; logged loudly)
  --keep-worktree     keep the worktree after a successful merge
  --log <file>        save build rounds + reviews to a Markdown file
  --dry-run           run the loop but never merge
```

> Keep `--log` **outside the worktree** (e.g. in the repo root or `.planning/`). A log written
> inside the worktree would be swept into the change set.

---

## How a build round works

For each round, the tool — not the agent — owns one authoritative change set:

1. **Build.** Opus (via Claude Code) implements the plan (round 1) or addresses the prior review (later
   rounds) in the worktree, committing as it goes.
2. **Capture.** Any stragglers are auto-committed so `baseSha..HEAD` is the exact set that will be
   reviewed, scanned, and merged (`baseSha` is the base ref resolved once, so it can't drift mid-run).
3. **Tripwire.** If the primary checkout changed, abort hard — the agent must only touch the worktree.
4. **Gates (before review).** An optional `--verify` command and the secrets scan run first; a failure
   loops feedback to the builder _without_ spending a review round. The secrets scan result is also fed
   to the reviewer as evidence.
5. **Review.** `/ai-code-review` inspects the real diff + the original plan and emits `MERGE_READY`
   only when the code is genuinely ready.
6. **Finish.** On `MERGE_READY`, re-run the secrets gate fail-closed, then (with `--merge`) merge and
   remove the worktree. The merge lands in the **primary checkout's current branch** (`--base` only
   seeds the worktree), and the target is printed before merging — so check out your intended branch
   first. Without `--merge`, print the diff + merge command for you to run.

> The straggler auto-commit in step 2 uses `git commit --no-verify`, so repo commit hooks (format,
> custom validators) are skipped for it. The fail-closed secrets gate and the reviewer (which runs
> lint/tests) compensate, but hook-only checks are not enforced on auto-committed changes.

### The secrets gate

Runs `scripts/leak-gate.sh` + `validation/validate-all.sh --critical` over **exactly the changed
files** (copied to a throwaway dir — never the whole worktree, whose `.git` pointer and `examples/`
would false-fail). A failure blocks the merge; the branch is preserved. `--no-gate` is an explicit,
loudly-warned escape hatch and never weakens the gate scripts themselves.

---

## Exit codes

| Code | Meaning                                                                 |
| ---- | ---------------------------------------------------------------------- |
| 0    | converged on `MERGE_READY` (merged if `--merge`)                       |
| 1    | fatal — prereqs, bad args, unreadable plan, or the primary-checkout tripwire |
| 2    | round budget spent without approval — worktree preserved, resumable    |
| 3    | the builder produced no commits at all                                 |
| 4    | the secrets/verify gate blocked the build — fix and re-run             |
| 124  | the builder timed out (raise `--build-timeout`)                        |

Plans can be force-finalized on the final planning round; **code is never force-merged** on a round
limit — the branch is left for a human.

## Resumability

State lives in git. Re-running `aios build <plan> <branch>` on an existing branch reuses the worktree,
feeds the existing commits to the builder as "already done — continue, don't redo," and lets the
reviewer judge cumulative progress. No sidecar state file.

---

## Chained one-shot (`aios relay … --build`)

Plan, build, and merge in a single watchable run:

```bash
# plan with /review-plan → on PLAN_READY, build with /ai-code-review → on MERGE_READY, gate → merge
npm run aios -- relay "Add a --version flag to aios.mjs" feat/aios-version --build --merge --log run.md
```

- `--rounds` governs the **plan** loop; `--build-rounds N` governs the **build** loop (default 4).
- The approved plan is passed in-memory; the shared `--log` gets both the plan and build sections.
- Omit `--merge` to stop at a reviewed branch you merge yourself.

---

## Examples

```bash
# Build a relay-produced plan; review the diff yourself before merging
npm run aios -- relay "Add rate-limit headers" feat/rl --rounds 3 --log rl.md --dry-run
npm run aios -- build rl.md feat/rl --log rl.build.md

# Build + auto-merge, running the test suite before each review
npm run aios -- build rl.md feat/rl --merge --verify "npm test"

# Build a quick inline task (no plan review)
npm run aios -- build "Add a --version flag to aios.mjs" feat/version --task
```

---

## Files

| File                                       | Purpose                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| `scripts/build.mjs`                        | The build loop (`cmdBuild` / `runBuild`), exposed as `aios build` |
| `scripts/relay-core.mjs`                   | Primitives shared with the plan phase (Cursor driver, git, tokens, `--log`) |
| `~/.cursor/skills/ai-code-review/SKILL.md` | Cursor's code-review persona; emits `MERGE_READY`             |
| `test/build.test.mjs`                      | Pure-function unit tests                                       |
| `test/build-loop.test.mjs`                 | End-to-end loop test using a fake `cursor` on `PATH`          |
