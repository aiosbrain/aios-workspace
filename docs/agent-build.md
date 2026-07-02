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
  --pr                on approval, push the branch + open a GitHub PR (see `aios pr`).
                      Mutually exclusive with --merge; never removes the worktree/branch.
  --issue AIO-<n>     issue key for --pr (required unless the branch already names one)
  --model <id>        override the builder model for every build/fix step
  --bugbot            run local /review-bugbot before merge/PR (default when --merge or --pr)
  --no-bugbot         skip the local Bugbot gate even with --merge/--pr
  --no-gate           skip the pre-merge secrets gate (NOT recommended; logged loudly)
  --keep-worktree     keep the worktree after a successful merge
  --log <file>        save build rounds + reviews to a Markdown file (APPENDS across runs)
  --dry-run           run the loop but never merge / open a PR
```

> Keep `--log` **outside the worktree** (e.g. in the repo root or `.planning/`). A log written
> inside the worktree would be swept into the change set. `--log` **appends** by default, so
> re-running a standalone `aios build --log X` adds a fresh header + sections rather than
> clobbering the first run.

### Push + open a PR (`aios pr` / `aios build --pr`)

The fenced builder never pushes or opens PRs (see the fence below) — the tool owns that.
`aios pr` pushes the branch and opens a GitHub PR, **idempotently** (an already-open PR for
the head branch is reused, not duplicated), printing `PR_NUMBER=<n>`:

```bash
npm run aios -- pr --branch feat/AIO-42-x --issue AIO-42
npm run aios -- build plan.md feat/AIO-42-x --pr --issue AIO-42   # chained on approval
```

The PR title always carries the `AIO-<n>` key so the repo automations fire (`pr-in-review.yml`
→ In Review on open, `aios-work-sync.yml` → Done on merge). A **custom `--title` that omits the
issue key is prefixed** with `AIO-<n>: ` so the automations never silently break. `aios build --pr`
runs `aios pr` **inside `finish()` after the same pre-ship gates as `--merge`** (HEAD-drift,
`--verify`, fail-closed secrets, **and the local Bugbot gate** — default-on for `--pr` too), and
— unlike `--merge` — leaves the worktree and branch in place. All child calls use argv arrays (no
shell strings); `--dry-run` previews the push + `gh pr create` argv without any network call.

### The builder fence (defense-in-depth, not containment)

The builder runs with `--dangerously-skip-permissions`, so this is **not** a filesystem
sandbox — a determined builder could still reach an explicit path. The "fence" is three
overlapping layers that reduce blast radius:

1. **Policy** — every builder invocation is prefixed with hard git rules: **no `git push`,
   no PR create/edit/comment, no touching the primary checkout or other worktrees, small
   commits in the worktree only** — explicitly overriding any conflicting global instruction.
   A cooperative builder obeys these.
2. **Accidental-discovery block** — an env fence sets `GIT_CEILING_DIRECTORIES` to the
   worktree's parent dir so git cannot **walk up** into the primary checkout from outside the
   worktree. It only stops *upward discovery*: an explicit `git -C <primary-path>` still works.
   It does **not** break git inside the linked worktree (its `.git` is a gitdir-pointer file
   resolved by explicit path, not an upward walk).
3. **Detection** — the primary-checkout tripwire (status + HEAD snapshot) aborts the build if
   the primary checkout changes at all. This is the layer that actually catches a builder that
   reaches an explicit path despite layers 1–2.

Manual checks: `claude --help` confirms `--effort low|medium|high|xhigh|max`;
`test/git-ceiling.test.mjs` verifies the ceiling blocks upward discovery while leaving the
linked worktree working.

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
6. **Finish.** On `MERGE_READY`, re-capture the change set (reviewer may have committed with
   `--force`), re-run verify + secrets gate fail-closed, run **local `/review-bugbot`** when
   `--merge` is set (unless `--no-bugbot`), then merge and remove the worktree. The merge lands
   in the **primary checkout's current branch** (`--base` only seeds the worktree), and the target
   is printed before merging — so check out your intended branch first. Without `--merge`, print
   the diff + merge command for you to run.

### Local Bugbot hook (`/review-bugbot`)

When `--merge` is set, `aios build` runs a **local Cursor Bugbot review** on the real worktree
diff before merging (same skill as `/review-bugbot` in the IDE). It blocks merge on Critical/High
findings unless you pass `--no-bugbot`. Standalone:

```bash
npm run aios -- review-bugbot feat/my-branch
```

Poll remote GitHub Bugbot on a PR (no email):

```bash
scripts/bugbot-status.sh <pr-number>
```

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

> **Per-step model config + the fix-escalation ladder** (which model/effort drives each
> build/fix round, the cross-family diversity guard, and the effort split) are documented in
> [`workflows.md` → Per-step model config](./workflows.md#per-step-model-config-agent-relay).
> Tune via `.aios/loop-models.yaml` (see `docs/loop-models.example.yaml`).

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
| `scripts/pr.mjs`                           | `aios pr` — idempotent push + `gh pr create` (chained by `aios build --pr`) |
| `scripts/loop-models.mjs`                  | Per-step model/effort/timeout resolver + cross-family diversity guard |
| `scripts/relay-core.mjs`                   | Primitives shared with the plan phase (Cursor driver, git, tokens, `--log`) |
| `~/.cursor/skills/ai-code-review/SKILL.md` | Cursor's code-review persona; emits `MERGE_READY`             |
| `test/build.test.mjs`                      | Pure-function unit tests                                       |
| `test/build-loop.test.mjs`                 | End-to-end loop test using a fake `cursor` on `PATH`          |
