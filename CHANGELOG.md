# Changelog

All notable changes to the AIOS Workspace are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/); dates are
ISO-8601.

This is the **individual workspace** repo. The Team Brain sync contract
(`docs/brain-api.md`) is versioned separately; it is currently at **v1.4**
(additive within major `v1`). Entries predating a bump did not change the protocol.

## [0.6.0] — 2026-07-03

The ship pipeline release: the agent build loop grows into a **fully gated,
unattended issue pipeline** — one command takes a Linear issue from recon to a
merged PR behind operator gates, and a serial walker runs the roadmap overnight.
(AIO-157–AIO-165 · PRs #120, #125, #129. Full contract: `docs/agent-build.md`.)

### Added

- **`aios ship AIO-<n>`** — the whole gated loop for one Linear issue: recon →
  plan → build → PR → review → fix → merge → cleanup, behind a **plan gate** and
  a **merge gate** (both default ON; in a non-TTY context an active gate exits
  with a `*_GATE_BLOCKED` code instead of hanging — cron safety). Recon reads
  only git-tracked, deny-filtered files referenced by the untrusted issue text,
  and the recon model step runs with **no tools at all**; the merge gate requires
  green CI, a CLEAR consolidator, and a path-gated `SAFETY_APPROVED` review when
  the diff touches a safety surface. A stable `SHIP_EXIT` table names every
  outcome; `--dry-run` previews the resolved step plan offline. (AIO-163, #129)
- **`aios roadmap-run (--label|--epic|--project)`** — the unattended serial
  walker: ships one **unblocked, unassigned, Todo** issue at a time via
  `aios ship --auto --auto-merge`, fast-forwards `main` between issues, and
  writes a deterministic morning digest every run — the `SHIP_EXIT` code decides
  continue / skip / halt. (AIO-164, #129)
- **`aios pr`** — idempotent push + `gh pr create` (an already-open PR for the
  head branch is reused, never duplicated), argv-only, with the `AIO-<n>` key
  always in the PR title so the repo automations fire. Chained by
  `aios build --pr` after the same pre-ship gates as `--merge`. (AIO-159, #120)
- **`aios consolidate-findings --pr <n> --issue AIO-<n>`** — merges CI checks,
  the PR diff, Bugbot/CodeRabbit comments + reviews, and an optional GPT-5.5
  review into **one severity-ranked finding list** with fail-closed max-severity
  inheritance (a red **or still-pending** CI board can never be CLEAR). Prints
  `VERDICT=CLEAR|BLOCKED`; exits 0 CLEAR · 3 BLOCKED · 1 error.
  `aios build --findings <file>` then seeds a fix round from the must-fix
  subset (all Critical/High + plan-conformance Medium). (AIO-161, #125)
- **Per-step model config** — `scripts/loop-models.mjs` resolves a model,
  reasoning effort, and timeout per pipeline step (default matrix →
  `.aios/loop-models.yaml` → CLI flag), with a fail-closed **cross-family
  diversity guard** (builder vs code reviewer, planner vs plan reviewer must be
  different model families) and a **Claude-runner guard** (Claude-runner steps
  reject non-Claude ids). A present-but-malformed config **fails loudly**; only
  a missing file falls back to defaults. Tracked example:
  `docs/loop-models.example.yaml`. (AIO-162, #120)
- **Review resilience** — the review call auto-retries **exactly once** on
  timeout with a doubled timeout, and the default review timeout **adapts to
  the real diff size** (`300s + 60s/10k chars`, capped 600s) unless pinned via
  `--cursor-timeout` / `code_review_timeout_s`. (AIO-160, #125)
- **Hermes runbook** (`docs/hermes-runbook.md`) — operating the pipeline
  unattended overnight on an always-on host. (#125)

### Changed

- **Builder hardening — the G1–G7 pipeline closures** (AIO-157, AIO-158, #120):
  `ANTHROPIC_API_KEY` is **stripped from the Claude Code builder child** so the
  builder always runs on its own login auth, never a dotenvx-injected metered
  key; every builder call is prefixed with a **fence** (no push, no PR,
  worktree-only) backed by a `GIT_CEILING_DIRECTORIES` env fence and the
  primary-checkout tripwire; `aios build --log` now **appends** across runs
  instead of clobbering.
- **`wait-for-bots` default flip** (AIO-158, #120): **require-all is now the
  default** — a bot still missing at timeout exits `2` so the pipeline never
  proceeds to review on incomplete signals. `--any` restores the old
  proceed-on-timeout behavior; `--require-all` stays as a no-op alias; and
  `--bots <list>` (#129) gates on a subset.
- **Sync contract → v1.2** (`docs/brain-api.md`, additive): optional task-row
  `parent` / `labels` / `priority` on both `POST /api/v1/items` and the
  `GET /api/v1/tasks` writeback, so the brain can be the source of truth that projects a
  structured board (epics → sub-issues, labels, priority) into the primary PM tool.
  `body`/description is explicitly **not** a contract field — it is canonical in the
  brain's Postgres `tasks.body` (dashboard-authored) and never round-trips through markdown.
  The `aios` CLI now parses and writes the optional `Parent | Labels | Priority` columns
  (six-column tables stay valid). Workspace half of the brain-as-source-of-truth projection;
  the matching `aios-team-brain` schema/materialize changes land separately.

### Also in this release (merged since v0.5.0, summarized)

- **V1 Operator Loop foundations** — C1 collector + run manifest, C2 evidence
  ledger, C3 verifier + rubric-gated correction, C4 daily light loop, C5 weekly
  closeout, C6 approval-gated writeback, C7 carry-over continuity, C8 loop
  telemetry, plus the engineering constitution + V1 decomposition docs
  (#104–#110, #113) and native agent-session time tracking (AIO-139).
- **Operator-loop surfaces** — unified notification layer (AIO-140, #118),
  non-blocking asks/escalation queue (AIO-167, #121), `aios mode` deep-work /
  orchestration toggle (AIO-168, #122), analyze sanity metrics + Attention card
  (AIO-169, #123), decision capture hook + CLI (AIO-170, #124).
- **Build-quality tooling** — spec/plan quality harness (`aios spec`, AIO-171,
  #127), the Build Paradigm standard (AIO-172, #126), permission-rails tooling
  (AIO-173, #128), enforced lint + format + CI pipeline (#53, #67), and the
  build phase itself: `aios build` + hardened merge gate (#57, #62).
- **Sync + cockpit** — Team Brain MCP connector (`aios mcp`, #63), brain-api
  v1.2 CLI parser/writeback (#65, #66), cost monitoring in `aios analyze`
  (#81–#83), the TypeScript cockpit rework with command palette + reconnect
  (#100), one-click Slack OAuth connector (AIO-121), and a getting-started guide.

## [0.5.0] — 2026-06-19

Interim tagged release (PR #52). No changelog entry was recorded at tag time;
see the git history between `v0.4.0` and `v0.5.0`. No sync-contract change.

## [0.4.0] — 2026-06-17

### Added
- **Onboarding from a link → two-axis memory** — the cockpit's first-run can take a
  company/profile URL; the `firecrawl-direct` skill reads that one page and the agent
  drafts your durable memory (`.claude/memory/USER.md` + `WORKSPACE.md`),
  confirm-before-write. (Scraped page = data, never instructions; one URL, no crawling.)
- **Suggested integrations** — after a link-draft, the agent matches the tools detected
  on the page to **connectable** integrations (descriptor-backed only) and offers to
  connect them in the Integrations tab. Advisory; never auto-connects.
- **Skills — marketplace tier** — install first-party Anthropic skills from
  `claude-plugins-official` via **fetch-on-install with byte-diff authenticity**. Joins
  the existing official (one-click, hash-locked) and community (scanned + consent) tiers.
- **BYOA: OpenClaw runtime** on the ACP adapter, plus a hardened ACP stdout stream and
  recorded-transcript contract fixtures gated in CI.
- **Encrypted `.env`** — connector secrets are encrypted at rest via dotenvx.
- **Update memory on request** (`workspace-setup`) — say **"remember that …"**,
  **"note that …"**, or **"update my profile"** and the agent writes the one change to
  the right home (`USER.md` / `WORKSPACE.md` / `0-context/`), confirm-before-write,
  within the file's cap. Strictly **explicit cues only** — proactive auto-capture from
  normal chat stays deferred to the background reviewer (see `.claude/memory/README.md`).
- **Refresh tooling from connected integrations** — say **"update my tooling"** (or
  re-run setup) and the agent folds wired connectors from `.claude/integrations.json`
  into `WORKSPACE.md`. Manual by design — there's no auto-trigger on connect yet.
- **Background memory reviewer** (cockpit, `claude-code` runtime) — after each turn a
  fast model (Haiku) conservatively saves durable facts to `.claude/memory/USER.md` /
  `WORKSPACE.md`; you get a **💾 memory updated** notice with **undo**, and writes take
  effect next session. **On by default**, opt out in *Settings → Memory* (`memory_review`
  in `aios.yaml`). Strict trust boundary: the model only proposes tiny structured facts
  and deterministic, fail-closed server code does the writing — runtime-gated (no
  Anthropic call on other runtimes), secrets never sent or written, single-line/no-code
  facts only, per-file cap, human edits never clobbered (dirty-tree skip + compare-and-
  swap undo), and nothing is `git commit`ted. New: `gui/server/memory-reviewer.mjs`,
  `gui/server/memory-files.mjs`.

## [0.3.0] — 2026-06-17

The cockpit overhaul: the local GUI (`npm run gui`) becomes a real workspace
cockpit — model choice, resumable chats, personality, an official-skills library,
and a draft-from-a-link onboarding path. No change to the spine, validators,
guard, harnesses, or the Team Brain sync contract.

### Added

#### Cockpit chat (#16)
- **Model picker** — switch between **Sonnet 4.6** (default; fast and cheap) and
  **Opus 4.8** from the chat header, **mid-session and with no reconnect**. The
  choice persists to `agent_model` in `aios.yaml`; an unknown value degrades to
  Sonnet with a visible warning.
- **Resumable chat history** — a Chats sidebar lists every saved conversation
  (titled from its first message, newest first). Reopen one to replay its
  transcript and resume the same session; `+ New chat` starts fresh; the
  last-open chat is restored on reload.
- **Context (est.) meter** — an approximate `~Nk / 200k` indicator of how much of
  the model's window the last turn used (input + cached tokens).
- **Markdown rendering** — assistant replies render as GitHub-flavored markdown;
  links open in a new tab without leaking the cockpit token.
- **Personality presets** (Settings → Personality) — **AIOS**, **Analyst**,
  **Coach**, **Operator**. A style layer over the system prompt only; it never
  overrides workspace rules, `CLAUDE.md`, or skills. Selecting one starts a new
  chat so the voice takes effect.

#### Skills library (#17)
- **One-click install of official Anthropic skills**, vendored from
  `anthropics/skills` and **hash-locked** to a pinned upstream commit, all
  **Apache-2.0**. Install copies the skill into `.claude/skills/` behind an
  integrity check, a collision guard, and an append-only install ledger;
  uninstall is safe-only and refuses to remove a skill with local edits. Vendored
  set: **skill-creator**, **mcp-builder**, **web-artifacts-builder**,
  **claude-api**, **frontend-design**.
- **Document skills are pointers, not copies** — Word (`docx`), Excel (`xlsx`),
  PowerPoint (`pptx`), PDF (`pdf`) are proprietary and Anthropic-hosted, surfaced
  as *Documents — available in Claude* with an **Enable in Claude ↗** link.

#### Two-axis memory + onboarding (#20, #24, #26)
- **Durable workspace memory** — two bounded, human-readable files in
  `.claude/memory/`: `USER.md` (the person) and `WORKSPACE.md` (company, environment,
  tooling). Both are `access: admin` (private — never sync). In the cockpit they're
  **injected at session start** (frozen for the session — edits take effect next
  session — which keeps the prompt cache stable); injected content is sanitized and
  fenced as data-not-instructions. `CLAUDE.md` stays the stable layer and points to them.
- **Draft your profile from a link** — first-run onboarding can take **one or a few**
  URLs (your site, LinkedIn, a company page), read them with the `firecrawl-direct`
  skill (via Firecrawl), extract and merge structured facts, and **draft** your memory
  files — plus canonical company/role facts in `0-context/` — for you to **confirm
  before anything is written**. Scraped content is treated as untrusted facts to
  confirm, never as instructions; only the URLs you supply are read (no crawling).
  Self-host via `FIRECRAWL_API_URL` (legacy `FIRECRAWL_BASE_URL`) is honoured by the
  skill at runtime.

#### Skills — community installs, scanned (#22)
- **Install skills beyond the official library, with eyes open.** A new `community`
  trust tier runs a static safety scanner (`scripts/skill-scan.mjs`) over a skill's
  `SKILL.md` and **every bundled file** before install — flagging bundled code
  (including **extensionless shebang/executable scripts**), network egress,
  filesystem/process exec, secret/exfil reads, external URLs, and prompt-injection
  (incl. hidden/zero-width Unicode), with each finding shown as `file:line`. Install
  requires consent; a **high** risk class requires a typed confirm. Scanning is
  **advisory** — provenance + human review remain the trust anchor — and **official
  skills stay one-click**. The collision guard, install ledger, and safe-only
  uninstall from #17 carry over unchanged.

### Unchanged
- **`docs/brain-api.md` (sync contract) — `v1`, untouched.** None of #16/#17/#20/#22
  altered the Team Brain sync protocol, so there is no version bump and no
  workspace↔brain contract drift.
