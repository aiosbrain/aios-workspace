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
  --findings <file>   seed round 1 from a consolidated findings file (the must-fix subset:
                      all Critical/High + plan-conformance Medium) — see aios consolidate-findings
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

## Review resilience

Long-running unattended builds (see the [Hermes runbook](./hermes-runbook.md)) fail on two
things a fixed timeout can't handle: a big diff that legitimately needs longer to review, and
a transient review timeout. Two mechanisms fix this:

- **Auto-retry once on timeout.** If the review call times out, it retries **exactly once with
  a doubled timeout**. A non-timeout error (`agent exited N`) is not retried, and a second
  timeout fails the round. Transient backend drops (`ECONNRESET` etc.) still retry inside each
  attempt. The decision (original/doubled timeout, attempt) lands in the console and `--log`.
- **Adaptive default review timeout.** When no explicit timeout is set, the per-round review
  timeout scales with the **real review payload size**: `base (300s) + 60s per 10k chars`,
  capped at `2× base = 600s`. The payload size is the pre-truncation diff length clamped to
  `DIFF_CAP` (50000) — so the timeout scales off the true size even when the diff is collapsed
  to a short truncation message. Each round logs `[cursor] review timeout Ns — adaptive (N chars)`.

**Explicit wins, never scale.** Setting `--cursor-timeout N` (or `code_review_timeout_s` in
`.aios/loop-models.yaml`) pins the review timeout to that value and bypasses adaptation entirely.

## The full ship pipeline

For a PR-based flow (as opposed to `--merge`), the resilient pipeline is:

```
aios build … --pr   →   wait-for-bots   →   GPT-5.5 PR review   →   aios consolidate-findings   →   aios build --findings <file>
```

1. **`aios build … --pr`** opens the PR after the local gates (including local Bugbot).
2. **`scripts/wait-for-bots.mjs`** blocks until Bugbot + CodeRabbit post substantive feedback.
3. An optional **GPT-5.5 PR review** writes a markdown findings file.
4. **`aios consolidate-findings --pr <n> --issue AIO-<n>`** merges CI checks, the PR diff, the
   bot comments/reviews, and the GPT review into **one severity-ranked finding list** at
   `.aios/loop/<issue>/findings-r<N>.md`, printing `VERDICT=CLEAR|BLOCKED`.
5. On `BLOCKED`, feed it back with **`aios build --findings <file>`** — round 1 becomes a fix
   round seeded from the **must-fix subset** (all Critical/High + `(plan-conformance)` Medium).

### `aios consolidate-findings`

```
aios consolidate-findings --pr <n> --issue AIO-<n> [--round N] [--repo owner/repo]
                          [--gpt-review <path>] [--out <path>]
```

- Reads its prompt from `.claude/agents/code-reviewer.md` at runtime (frontmatter stripped —
  never forked) and **supplies the PR diff** so its AIOS-rule / plan-conformance instructions
  stay grounded.
- **Inputs** (per `code-reviewer.md` "How to gather inputs"): CI checks (`gh pr checks --json`,
  tolerant of a red/pending board), the PR diff (capped at `DIFF_CAP` = 50000 chars), Bugbot +
  CodeRabbit issue/inline comments + submitted reviews, and an optional GPT-5.5 review markdown
  (`--gpt-review`, capped at `GPT_REVIEW_CAP` = 20000 chars). Truncations carry an explicit marker.
- **Fail-closed max-severity inheritance.** After the model consolidates, a deterministic pass
  forces `BLOCKED` when **CI is red** (a red board is ≥ High and can never be CLEAR), when **CI is
  still pending** (the consolidator runs after `wait-for-bots`, so an unsettled board means
  merge-readiness is unknown — it fails closed rather than pass through), or when a source reported
  Critical/High that the consolidated output dropped — rewriting the verdict and appending an
  `## AIOS Rule Violations` note. The model is never trusted to silently downgrade.
- The `consolidate` step runs on a **Claude-family** model (config surface: `consolidate_model`
  / `consolidate_effort` / `consolidate_timeout_s`); a `gpt-*` override fails loud.
- **Exit codes:** `0` = CLEAR, `3` = BLOCKED, `1` = error (bad args, missing reviewer prompt,
  or a gh error other than a tolerated CI red/pending board). A **red OR still-pending CI board
  returns 3, not 1** — it's data, and pending fails closed.
- The findings file lives under `.aios/` (gitignored) and is **never committed**.

---

## `aios ship` — the whole gated loop for one issue

`aios ship AIO-<n>` wraps the entire pipeline behind two operator gates:

```
aios ship AIO-<n>
  │
  ├─ 1. recon        Linear issue + git-tracked referenced files → context pack
  ├─ 2. plan         Opus plan ↔ Cursor /review-plan loop  ──▶ [PLAN GATE]
  ├─ 3. follow-up    file `## Deferred (out of scope)` items as Linear children
  ├─ 4. build        runBuild on an isolated worktree (secrets gate inside)
  ├─ 5. PR           cmdPr push + open PR (title carries AIO-<n>)
  ├─ 6. review       wait-for-bots (Bugbot) + GPT-5.5 review + consolidate-findings
  ├─ 7. fix loop     re-build from the must-fix subset until CLEAR or --max-fix-rounds
  ├─ 8. merge gate   CI green + consolidator CLEAR + path-gated safety review  ──▶ [MERGE GATE]
  └─ 9. cleanup      ff-only main → worktree remove → prune → branch delete
```

```
aios ship AIO-<n> [--auto] [--auto-merge] [--max-fix-rounds N]
                  [--reviewers b,g] [--plan-runner cli] [--dry-run]
```

- **Gates default ON.** `--auto` skips the plan gate; `--auto-merge` skips the merge gate. In a
  **non-TTY** context with a gate still active (no matching auto flag), ship exits with a
  `*_GATE_BLOCKED` code **rather than hanging** — cron safety.
- **`--dry-run`** prints the resolved step plan (stages, per-step models/efforts, gate states,
  reviewers, and the `SHIP_EXIT` table) with **no side effects and no required network** — it works
  offline and without `LINEAR_API_KEY` (a resolvable key just fetches the issue title as a nicety).
- **Recon is safe by construction.** Linear issue text is untrusted external input, so recon reads
  **only files that are (a) git-tracked, (b) not on the hard deny list** (`.env*`, `.aios/…`,
  `.git/…`, `node_modules/…`, `*.key`, `*.pem`), **and (c) free of absolute / `..`-traversal paths**
  — enforced by `extractRepoFileRefs` (`scripts/linear-client.mjs`). Everything rejected is audited
  by **path + reason only; its contents are never read**. The fixed contract checklist
  (`docs/brain-api.md`, `docs/ENGINEERING-CONSTITUTION.md`) passes the *same* filter.
- **`blockedBy` direction (proven).** Linear's `IssueRelationType` has **no `blocked_by` value** —
  blocking is one directional record (`issue` **blocks** `relatedIssue`, `type: "blocks"`). The
  blockers of an issue are therefore its **`inverseRelations`** of type `blocks` (see
  `normalizeBlockedBy`); a forward `blocks` relation means the issue blocks *others* and is **not**
  a blocker of it.
- **Path-gated safety review.** If the diff touches a safety surface (`hooks/`, `validation/`,
  `scripts/leak-gate.sh`, `scaffold/.claude/`, `docs/brain-api.md`, `scripts/brain-client.mjs`,
  `scripts/brain-config.mjs`, `scripts/workspace-parse.mjs`), the merge gate runs a `safety_review`
  over the diff and **blocks unless** it emits `SAFETY_APPROVED` alone on the final line.
- **Plan runner.** `--plan-runner cli` (default and only implemented value) drives the planner
  through Claude Code (its own login auth — sidesteps a dotenvx key with no API credits). An `sdk`
  runner delegating to `relay.mjs` (which would need a funded `ANTHROPIC_API_KEY`) is **not yet
  implemented** — passing `--plan-runner sdk` is rejected as a usage error rather than silently
  ignored.
- **`--reviewers`.** Selects which gating reviewers actually run: `bugbot` waits on the
  `cursor[bot]` check via wait-for-bots; `gpt-5.5` runs the Cursor GPT PR review. Unknown reviewer
  names are a usage error. CodeRabbit, when present, is swept by the consolidator but never gated on.
- **Verify chain.** Every build/fix round runs the repo verify chain
  (`npm run build:loop && npm test && npm run lint && npm run format:check`) inside the worktree via
  `runBuild`'s `--verify`, and again pre-merge — `aios ship` can never merge code that hasn't passed it.
- **Merge is checked, not assumed.** `gh` calls return `{code,stdout,stderr}` without throwing, so
  the merge gate checks the exit code of `gh pr merge`, `gh pr checks`, and `gh pr diff --name-only`
  explicitly. A failed merge → `MERGE_BLOCKED` and cleanup never runs; unavailable CI or
  changed-path metadata fails **closed** (`MERGE_BLOCKED`), never treated as green.
- All run artifacts land under `.aios/loop/<issue>/` (gitignored) — `task.md`, `recon.md`,
  `recon-skipped.md`, `plan-r<N>.md`, `plan.md`, `deferred.md`, `build.md`, `review-gpt-r<N>.md`,
  `findings-r<N>.md`, `safety-review.md`, `ship-transcript.md`. Nothing under `.aios/` is committed.

### `SHIP_EXIT` codes

| Const                   | Code | Meaning                                                            |
| ----------------------- | ---- | ----------------------------------------------------------------- |
| `OK`                    | 0    | plan → merge → cleanup completed                                  |
| `USAGE`                 | 1    | bad args / prereqs / unresolved issue id                          |
| `RECON_FAILED`          | 10   | issue fetch or recon model step failed                            |
| `PLAN_UNAPPROVED`       | 20   | plan loop spent its round budget without `PLAN_READY`             |
| `PLAN_REJECTED`         | 21   | operator rejected the plan at the plan gate                       |
| `PLAN_GATE_BLOCKED`     | 22   | plan gate active in a non-TTY context without `--auto`            |
| `BUILD_FAILED`          | 30   | `runBuild` returned a non-recoverable code (NO_DIFF/FATAL/TIMEOUT/GATE) |
| `BUILD_NONCONVERGENCE`  | 31   | `runBuild` spent its rounds (worktree preserved)                  |
| `PR_FAILED`             | 40   | `cmdPr` push/create failed                                        |
| `REVIEW_NONCONVERGENCE` | 50   | fix loop hit `--max-fix-rounds` still BLOCKED (no partial merge)  |
| `MERGE_BLOCKED`         | 60   | merge gate: CI red/pending/unavailable or unresolved Critical/High |
| `SAFETY_BLOCKED`        | 61   | path-gated safety review withheld approval                        |
| `MERGE_GATE_BLOCKED`    | 62   | merge gate active in a non-TTY context without `--auto-merge`     |
| `MERGE_REJECTED`        | 63   | operator rejected at the merge gate                               |
| `CLEANUP_FAILED`        | 70   | post-merge ff-only failed / primary checkout dirty (never clobber) |

**Merge gate never treats a non-zero `gh pr checks` exit as a crash.** `readChecks` captures stdout
even on non-zero exit (checks pending/failing) and parses it; empty/unparseable stdout → CI
**unavailable → `MERGE_BLOCKED`** (fail closed). **Code is never force-merged** on non-convergence.

## `aios roadmap-run` — the unattended serial walker

`aios roadmap-run` picks one unblocked issue at a time and ships it with `aios ship --auto
--auto-merge`, using the documented `SHIP_EXIT` code as the interface.

```
aios roadmap-run (--label <name> | --epic AIO-<n> | --project <name>)
                 [--max-issues N] [--comment-digest [--digest-target AIO-<n>]] [--dry-run]
```

- **Exactly one source** (`--label` / `--epic` / `--project`) is required.
- **Selection** (pure `selectNextIssue`): keep candidates that are **Todo (unstarted), unassigned,
  and unblocked** (every `blockedBy` blocker `completed`, per the proven direction above); order by
  **priority**, ties by **oldest `createdAt`**; skipped candidates are logged with a reason.
- Between issues it **fast-forwards `main`** so the next issue bases off fresh state; a non-ff `main`
  **halts** (the next issue would otherwise base off stale state).
- A **morning digest** is written every run (even a zero-issue run) to
  `.aios/loop/roadmap-digest-<date>.md`. A model may prepend prose, but the deterministic digest is
  the fallback — **the digest can never be the reason a run fails**. `--comment-digest` posts it to
  the resolved target: legal only with `--epic` (the epic) **or** an explicit `--digest-target`;
  with `--label`/`--project` and no target it's a **usage error**.
- **`--dry-run` requires `LINEAR_API_KEY`** (absent → a clean, actionable message, not a stack
  trace); it lists the ordered candidates with blocked/unblocked reasoning and stops.

### Roadmap decision table (`SHIP_EXIT` → action)

| SHIP_EXIT                                  | Action     |
| ------------------------------------------ | ---------- |
| `OK`                                       | continue   |
| `RECON_FAILED` / `PLAN_UNAPPROVED`         | skip       |
| `BUILD_FAILED` / `BUILD_NONCONVERGENCE`    | skip       |
| `REVIEW_NONCONVERGENCE` / `MERGE_BLOCKED`  | skip       |
| `SAFETY_BLOCKED`                           | skip (the "touches auth/secrets/architecture" escalation) |
| `USAGE` / `PLAN_REJECTED` / `PLAN_GATE_BLOCKED` | halt   |
| `PR_FAILED`                                | halt       |
| `MERGE_GATE_BLOCKED` / `MERGE_REJECTED`    | halt       |
| `CLEANUP_FAILED`                           | halt       |
| unknown                                    | halt (fail-safe) |

Every `skip`/`halt` posts a Linear comment on that issue and records a digest entry.

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
| `scripts/consolidate-findings.mjs`         | `aios consolidate-findings` — merge CI + bot + GPT reviews into one fail-closed finding list |
| `scripts/loop-models.mjs`                  | Per-step model/effort/timeout resolver + cross-family diversity guard |
| `scripts/relay-core.mjs`                   | Primitives shared with the plan phase (Cursor driver, git, tokens, `--log`) |
| `~/.cursor/skills/ai-code-review/SKILL.md` | Cursor's code-review persona; emits `MERGE_READY`             |
| `test/build.test.mjs`                      | Pure-function unit tests                                       |
| `test/build-loop.test.mjs`                 | End-to-end loop test using a fake `cursor` on `PATH`          |
