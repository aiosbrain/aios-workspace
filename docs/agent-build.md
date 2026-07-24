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
its own authentication. More than not *needing* it: the tool **actively strips `ANTHROPIC_API_KEY`
from the builder child's environment**, so a dotenvx-injected key (e.g. when invoked via
`npm run aios`) can never silently flip the builder from login/subscription auth to metered API
billing. Cursor and the relay SDK path are untouched by the strip.

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
sandbox — a determined builder could still reach an explicit path. Alongside the env
hardening above (the `ANTHROPIC_API_KEY` strip), the "fence" is three overlapping layers
that reduce blast radius:

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

When `--merge` is set, `aios build` runs **local code and security review passes** on the real
worktree diff before merging (the code pass uses the same `/review-bugbot` skill as the IDE).
Both passes block on Medium-or-higher findings unless you pass `--no-bugbot`. Standalone:

```bash
npm run aios -- review-bugbot feat/my-branch
```

For interactive product-repo work, `hooks/local-bugbot-gate.mjs` is the shared agent
completion gate. Project adapters invoke it from Claude Code `Stop`, Codex `Stop`, Cursor
`stop`, and OpenCode `session.idle`. It reviews committed, staged, and unstaged changes and
fails closed on reviewer/infrastructure errors or any untracked file. Stage intended new files
before review; this prevents forgotten local secrets from being sent to the external reviewer.
Medium-or-higher findings block. Blocked evidence is cached in worktree-local git state for the
exact diff fingerprint, but clear verdicts are never trusted from writable disk. The read-only
Cursor reviewer runs from a neutral temporary directory, so it cannot load the checkout's Stop
hook and recursively fire the same gate. This neutral-directory rule applies to every read-only
review provider, and the lifecycle gate pins its reviewer model rather than accepting an agent-
controlled environment override. The parent gate independently requires the child's
exact clear marker and re-fingerprints the worktree after review; malformed output or a mid-review
edit fails closed and requires a fresh pass. The hook uses Cursor Composer so an exhausted
premium-model allowance cannot silently skip the required review. The lifecycle gate runs the reviewer in read-only mode against the supplied
diff; repository tests remain a separate required check and cannot be mutated or restarted by
the reviewer. The lifecycle gate, the iterative `aios build` review/scan loop, and both hard
pre-merge paths (`aios build` and `aios ship`) resolve the diff base through the same canonical
GitHub `main` lookup instead of trusting the writable local
`origin/main` ref; this lookup requires network access and fails closed when the canonical base
cannot be verified. That verification intentionally precedes the no-diff decision: a clean Git
status can still contain committed feature-branch changes, while a local `origin/main`-based skip
would restore the writable-ref bypass. The standalone `aios review-bugbot` command uses the same lookup unless the
operator deliberately supplies `--base`. Before any external review, the gate runs the local secrets scanner and withholds
all scanner output. Untracked files are fingerprinted locally but their contents are never sent; the
gate fails closed until each intended file is staged or the local-only file is ignored/removed.
Trusted Git calls disable replacement objects, and a full-worktree review refuses to run while any
tracked path is marked `skip-worktree` or `assume-unchanged`, so local index hints cannot shrink the
reviewed changeset.

This is intentionally a toolkit-product checkout gate, not a vendored customer-workspace
hook: it depends on the toolkit's `scripts/aios.mjs` review CLI. A review sees the whole atomic
changeset. Diffs above the 500,000-character review limit fail closed with a request to split the
changeset, because independently clearing chunks could miss a cross-file vulnerability. Code and
security passes run concurrently; a timed-out Cursor call retries once with a
doubled per-call budget. The hook writes a local progress heartbeat every 30 seconds to stderr
while preserving machine-readable JSON on stdout. The native adapters share an explicit 24-hour
capacity. Abandoned locks carry an owner PID and are reclaimed as soon as that process is gone.

OpenCode 1.18 does not expose a blocking `Stop`/`session.stopping` plugin hook. Its adapter
runs the same required gate on `session.idle` and re-prompts an interactive session on failure
through the asynchronous prompt endpoint, awaiting its enqueue acknowledgement so delivery errors propagate,
but a headless OpenCode process can exit after the idle event. The aligned `aios build`/`aios
ship` pre-merge review is therefore the hard enforcement boundary for OpenCode until upstream
adds a blocking lifecycle hook. Claude, Codex, and Cursor block directly in their native Stop
contracts. Their native commands enter through `hooks/run-local-bugbot-gate.sh`, which removes
Node, dynamic-loader, shell-startup, Git, and Bugbot override variables before Node starts. The
OpenCode plugin applies the equivalent cleanup to the gate child environment. The shell launcher
selects only an executable, working Node binary from fixed system/Homebrew locations, while the
review runner invokes the Cursor CLI through a resolved absolute path and gives its child a fixed
system tool PATH. The reviewer derives its home directory from the OS account record, pins the
standard XDG roots beneath it, and rejects inherited Cursor config/path overrides; hook-supplied
`HOME` or `XDG_CONFIG_HOME` therefore cannot select reviewer configuration. The Cursor child uses
an allowlisted environment (locale/terminal metadata plus Cursor authentication only), so proxy,
endpoint, certificate, loader, and other inherited process overrides do not reach the reviewer.
Claude and Cursor pass their native project-root variables explicitly; Codex
derives the root with a pinned `/usr/bin/git` under an empty environment.

These checked-in lifecycle adapters are project-local UX controls, not a cryptographic boundary
against an actor that can rewrite the worktree or its hook configuration. The pinned, read-only
`aios build`/`aios ship` review is the normal pre-merge boundary; organizations requiring
tamper-resistant enforcement must also make the same review a required external CI check.

Manual diagnostic invocation (the OpenCode shape returns the raw structured result):

```bash
node hooks/local-bugbot-gate.mjs --runtime opencode --json --check-exit
```

`bugbot-status.sh` is deprecated because the hook cache cannot prove a local clear result. Run the
local review directly, or wait for CodeRabbit when that reviewer is required:

```bash
aios review-bugbot <branch> --worktree <path>
node scripts/wait-for-bots.mjs --pr <pr-number> --repo aiosbrain/aios-workspace
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
aios build … --pr → Local Bugbot → [label-gated CodeRabbit] → GPT-5.5 → consolidate-findings → fix
```

1. **`aios build … --pr`** opens the PR after the local gates (including local Bugbot).
2. **Local Bugbot is mandatory and canonical.** `aios ship` persists its artifact with the exact
   reviewed branch head and verified base SHA, and reruns it whenever either changes.
3. **`scripts/wait-for-bots.mjs`** is CodeRabbit-only. It accepts only substantive issue comments,
   inline comments, or submitted reviews at or after the latest PR commit; a successful check run
   alone is insufficient. It exits `2` when current-head evidence times out.
4. An optional **GPT-5.5 PR review** writes a markdown findings file.
5. **`aios consolidate-findings --pr <n> --issue AIO-<n> --local-bugbot-review <path>`** merges CI checks, the PR diff, the
   bot comments/reviews, and the GPT review into **one severity-ranked finding list** at
   `.aios/loop/<issue>/findings-r<N>.md`, printing `VERDICT=CLEAR|BLOCKED`.
6. On `BLOCKED`, feed it back with **`aios build --findings <file>`** — round 1 becomes a fix
   round seeded from the **must-fix subset** (all Critical/High + `(plan-conformance)` Medium).

### `aios consolidate-findings`

```
aios consolidate-findings --pr <n> --issue AIO-<n> [--round N] [--repo owner/repo]
                          --local-bugbot-review <path>
                          [--gpt-review <path>] [--out <path>]
```

- Reads its prompt from `.claude/agents/code-reviewer.md` at runtime (frontmatter stripped —
  never forked) and **supplies the PR diff** so its AIOS-rule / plan-conformance instructions
  stay grounded.
- **Inputs** (per `code-reviewer.md` "How to gather inputs"): CI checks (`gh pr checks --json`,
  tolerant of a red/pending board), the PR diff (capped at `DIFF_CAP` = 50000 chars), the required
  Local Bugbot markdown, current-head CodeRabbit issue/inline comments + submitted reviews, and an optional GPT-5.5 review markdown
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
  ├─ 2. spec eval    EE5 spec-readiness gate on the Linear issue body
  ├─ 3. plan         Opus plan ↔ Cursor /review-plan loop  ──▶ [PLAN GATE]
  ├─ 4. follow-up    file `## Deferred (out of scope)` items as Linear children
  ├─ 5. build        runBuild on an isolated worktree (secrets gate inside)
  ├─ 6. PR           cmdPr push + open PR (title carries AIO-<n>)
  ├─ 7. review       exact-head Local Bugbot + optional/required CodeRabbit + GPT-5.5 + consolidation
  ├─ 8. fix loop     re-build from the must-fix subset until CLEAR or --max-fix-rounds
  ├─ 9. merge gate   CI green + consolidator CLEAR + path-gated safety review  ──▶ [MERGE GATE]
  └─ 10. cleanup     ff-only main → worktree remove → prune → branch delete
```

```
aios ship AIO-<n> [--auto] [--auto-merge] [--max-fix-rounds N]
                  [--reviewers coderabbit,gpt-5.5] [--plan-runner cli|sdk]
                  [--skip-spec-gate] [--dry-run]
```

- **Gates default ON.** `--auto` skips the plan gate; `--auto-merge` skips the merge gate for
  Standard PRs. Safety-sensitive PRs reject `--auto-merge` and require the interactive operator
  gate or a deliberate resumed `--approve-merge`. In a
  **non-TTY** context with a gate still active (no matching flag), ship **runs up to the gate**,
  persists everything needed to judge it (`GATE-<plan|merge>.pending.md` + `state.json` in the
  audit dir), prints a machine-greppable `SHIP_GATE <name> pending` marker, and exits with the
  gate's `*_GATE_BLOCKED` code — **resumable, never hanging**. (Interactive prompts print the same
  marker before the `[y/N]`.)
- **Checkpoint + resume.** Every stage checkpoint lands in `.aios/loop/<issue>/state.json`
  (recon text, `specReady`, plan text, gate approvals, branch, PR number, review round, reviewed
  branch head, verified base SHA, and exact Local Bugbot artifact path).
  `aios ship AIO-<n> --resume` skips completed stages and re-enters at the first incomplete one —
  an aborted run costs minutes, not a fresh plan loop. `--resume --approve-plan` / `--resume --approve-merge` satisfy a pending
  gate after you've inspected it (an honest audit record of who approved what).
- **Parallel workstreams are safe.** `main` advancing mid-build (other agents merging) does **not**
  abort a build: the tripwire classifies primary-checkout movement — a HEAD-only move is a benign
  note; a working-tree change gets a loud warning + log entry (aborting could not undo it and would
  only discard finished work). Post-merge cleanup is **best-effort**: worktree/branch removal always
  proceeds; the ff-only of a primary checkout with local changes is skipped with instructions, never
  a `CLEANUP_FAILED`.
- **Driving ship from an agent (or any non-TTY caller).** Run gate-wise on the exit codes: run →
  inspect `GATE-plan.pending.md` → `--resume --approve-plan` → inspect PR at the merge gate →
  `--resume --approve-merge`. The legacy pseudo-terminal pattern
  (`script -q /tmp/ship-tty.log aios ship AIO-123 < <(tail -f /tmp/ship-stdin.txt)`)
  still works for truly live prompts, but the resume flags leave a better audit trail. Use
  `--auto`/`--auto-merge` when you simply want a gate skipped.
- **`--dry-run`** prints the resolved step plan (stages, per-step models/efforts, gate states,
  reviewers, and the `SHIP_EXIT` table) with **no side effects and no required network** — it works
  offline and without `LINEAR_API_KEY`. Key resolution follows the normal order
  (`process.env.LINEAR_API_KEY` → the repo's `.env` via `loadDotEnv`), so if a key **is** resolvable
  (env or `.env`), dry-run makes one **best-effort** `getIssue` call to show the issue title — a
  failure there is swallowed and the dry-run still completes. No `git`/`gh`/`claude`/`cursor`
  mutation ever runs in dry-run.
- **Recon is safe by construction.** Linear issue text is untrusted external input, so recon reads
  **only files that are (a) git-tracked, (b) not on the hard deny list** (`.env*`, `.aios/…`,
  `.git/…`, `node_modules/…`, `*.key`, `*.pem`), **and (c) free of absolute / `..`-traversal paths**
  — enforced by `extractRepoFileRefs` (`scripts/linear-client.mjs`). Everything rejected is audited
  by **path + reason only; its contents are never read**. The fixed contract checklist
  (`docs/brain-api.md`, `docs/ENGINEERING-CONSTITUTION.md`) passes the *same* filter. The recon
  model step is then run with **no tools at all** (`--permission-mode plan` + a `--disallowedTools`
  default-deny over every filesystem/exec/network tool): the pre-vetted file contents are already
  in the prompt, so a prompt-injection payload buried in the untrusted Linear text has **no tool to
  read `.env` or anything else outside the tracked-only allow list**. The path-gated `safety_review`
  step runs under the same no-tools stance (its diff is fully injected).
- **`blockedBy` direction (proven).** Linear's `IssueRelationType` has **no `blocked_by` value** —
  blocking is one directional record (`issue` **blocks** `relatedIssue`, `type: "blocks"`). The
  blockers of an issue are therefore its **`inverseRelations`** of type `blocks` (see
  `normalizeBlockedBy`); a forward `blocks` relation means the issue blocks *others* and is **not**
  a blocker of it.
- **Path-gated safety review.** If the diff touches a safety surface (`hooks/`, `validation/`,
  `scripts/leak-gate.sh`, `scaffold/.claude/`, `docs/brain-api.md`, `scripts/brain-client.mjs`,
  `scripts/brain-config.mjs`, `scripts/workspace-parse.mjs`), the merge gate runs a `safety_review`
  over the diff, requires current-head CodeRabbit evidence behind the `ready-for-review` label, and
  **blocks unless** the safety review emits `SAFETY_APPROVED` alone on the final line.
- **Plan runner.** `--plan-runner cli` (**default**) drives the planner through Claude Code, which
  strips `ANTHROPIC_API_KEY` and uses its own login auth — sidestepping a dotenvx key with no API
  credits. `--plan-runner sdk` is the **documented alternative**: it drives the plan loop through
  Opus via the Anthropic SDK (the same `callOpus` path `aios relay` uses) and therefore **requires a
  funded `ANTHROPIC_API_KEY`**. `sdk` is *not* the default precisely because the operator/Hermes
  dotenvx key has no API credits; a missing `ANTHROPIC_API_KEY` is caught up front as a usage error
  (credit exhaustion on a present key can only surface at call time). The Cursor plan review is
  identical for both runners; the Anthropic client is constructed lazily only when `sdk` is selected.
- **`--reviewers`.** Selects optional reviewers: `gpt-5.5` is the default and `coderabbit` requires
  current-head CodeRabbit evidence plus the `ready-for-review` label. Local Bugbot is mandatory and
  outside selection. `bugbot` remains temporarily accepted as a deprecated no-op alias; unknown
  names are usage errors. After a fix push, ship posts `@coderabbitai review` before waiting again.
- **Verify chain.** Every build/fix round runs the repo verify chain
  (`npm run build:loop && npm test && npm run lint && npm run format:check`) inside the worktree via
  `runBuild`'s `--verify`, and again pre-merge — `aios ship` can never merge code that hasn't passed it.
- **Merge is checked, not assumed.** `gh` calls return `{code,stdout,stderr}` without throwing, so
  the merge gate checks the exit code of `gh pr merge`, `gh pr checks`, and `gh pr diff --name-only`
  explicitly. A failed merge → `MERGE_BLOCKED` and cleanup never runs; unavailable CI or
  changed-path metadata fails **closed** (`MERGE_BLOCKED`), never treated as green.
- All run artifacts land under `.aios/loop/<issue>/` (gitignored) — `task.md`, `recon.md`,
  `recon-skipped.md`, `spec.md`, `spec-eval-r1.md`, `plan-r<N>.md`, `plan.md`, `deferred.md`,
  `build.md`, `local-bugbot-<head>.md`, `review-gpt-r<N>.md`, `findings-r<N>.md`,
  `safety-review.md`, `ship-transcript.md`.
  Nothing under `.aios/` is committed.
- **Spec-readiness gate (EE5).** After recon and before the plan loop, ship runs `aios spec eval`
  against the Linear issue body (description + comments). Only `SPEC_READY` proceeds; otherwise ship
  exits `SPEC_NOT_READY` (15) with findings in the audit dir and a hint to
  `aios spec fix .aios/loop/<issue>/spec.md`.
  - **Enforcement policy — `--spec-gate <block|advisory|off>`** (or spec frontmatter `spec_gate:`;
    default `block`). `advisory` runs the gate and prints/records findings but **builds anyway**
    (warn, don't block) — the escape hatch for a gate you don't yet trust, without giving up the
    signal. `off` (== `--skip-spec-gate`) skips the gate entirely; it is a logged escape hatch and
    is rejected under `--loop light`, whose entry contract is a real gate result. `advisory` *is*
    allowed under light because it still runs and records.
- **Light loop (AIO-398).** `aios ship AIO-<n> --loop light` keeps the mandatory `SPEC_READY`
  gate but skips recon, the planner, and the plan gate. It derives the builder contract from the
  spec's **Interfaces**, **Implementation**, and **Acceptance** sections, then runs the normal
  build → review → fix → consolidate → merge path. Its pinned profile wins over
  `.aios/loop-models.yaml` (only an explicit CLI override can win), so a session or local config
  cannot silently change the deliberate build/reviewer split: Codex Sol builds and routine fixes,
  Codex Terra handles escalated fixes, DeepSeek V4 Pro reviews, and OpenRouter GPT-4o mini
  consolidates. Claude Opus remains the independent high-risk safety reviewer. `--skip-spec-gate` is rejected for
  this loop. A light-loop safety review runs only when the raw issue description begins with YAML
  frontmatter containing `safety: true`; it does not infer that requirement from changed paths.
  Resume with the same loop shape — a full/light checkpoint mismatch is rejected rather than
  reusing an incompatible plan.

### Agent convention — writing Linear specs

When you **author or materially revise** a Linear issue that will be built (via `aios ship`,
`aios relay --build`, or a handover build):

1. Start from [`aios-issue-template.md`](./agentic-ergonomics/aios-issue-template.md):
   `aios spec init draft.md --title "…"`, fill sections, then `aios spec eval draft.md`.
   Push to Linear with `linear.mjs set-desc AIO-n draft.md` or `create --template aios`.
2. **Before calling `aios ship`**, run a spec eval pass on the body (export to a temp file if
   helpful): `npm run aios -- spec eval path/to/spec.md` — or rely on ship's built-in gate (step 2
   above), which evaluates the live Linear description + comments.
3. If `NOT_READY`, run `aios spec fix` on the audit copy (`.aios/loop/<issue>/spec.md` after a
   failed ship, or your draft file) and update Linear before planning/building.

`aios relay "task" --spec <file>` already enforces the same gate for file-based specs (EE5).

---

### `SHIP_EXIT` codes

| Const                   | Code | Meaning                                                            |
| ----------------------- | ---- | ----------------------------------------------------------------- |
| `OK`                    | 0    | plan → merge → cleanup completed                                  |
| `USAGE`                 | 1    | bad args / prereqs / unresolved issue id                          |
| `RECON_FAILED`          | 10   | issue fetch or recon model step failed                            |
| `SPEC_NOT_READY`        | 15   | spec-readiness gate failed — fix spec, then re-run                |
| `PLAN_UNAPPROVED`       | 20   | plan loop spent its round budget without `PLAN_READY`             |
| `PLAN_REJECTED`         | 21   | operator rejected the plan at the plan gate                       |
| `PLAN_GATE_BLOCKED`     | 22   | plan gate pending in a non-TTY context — resumable via `--resume --approve-plan` |
| `BUILD_FAILED`          | 30   | `runBuild` returned a non-recoverable code (NO_DIFF/FATAL/TIMEOUT/GATE) |
| `BUILD_NONCONVERGENCE`  | 31   | `runBuild` spent its rounds (worktree preserved)                  |
| `PR_FAILED`             | 40   | `cmdPr` push/create failed                                        |
| `REVIEW_NONCONVERGENCE` | 50   | fix loop hit `--max-fix-rounds` still BLOCKED (no partial merge)  |
| `MERGE_BLOCKED`         | 60   | merge gate: CI red/pending/unavailable or unresolved Critical/High |
| `SAFETY_BLOCKED`        | 61   | path-gated safety review withheld approval                        |
| `MERGE_GATE_BLOCKED`    | 62   | merge gate pending in a non-TTY context — resumable via `--resume --approve-merge` |
| `MERGE_REJECTED`        | 63   | operator rejected at the merge gate                               |
| `CLEANUP_FAILED`        | 70   | (rare) cleanup could not run at all — a skipped ff on a busy primary is OK, not this |

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
| `RECON_FAILED` / `SPEC_NOT_READY` / `PLAN_UNAPPROVED` | skip       |
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
