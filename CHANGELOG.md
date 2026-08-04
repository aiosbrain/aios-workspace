# Changelog

All notable changes to the AIOS Workspace are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/); dates are
ISO-8601.

This is the **individual workspace** repo. The Team Brain sync contract
(`docs/brain-api.md`) is versioned separately; it is currently at **v1.17**
(additive within major `v1`). Entries predating a bump did not change the protocol.

## [Unreleased]

### Added

- **Code Maintenance Loop Phase 0 (AIO-610)** — codebase-health v2 distinguishes the observed
  score from evidence completeness and automation admission, loads per-repository capability
  profiles, and emits stable redacted findings for Team Brain. Missing, stale, or errored required
  evidence now produces an `unknown` gate and can never admit background remediation.

## [0.10.1] — 2026-08-03

This patch completes the Workspace changes that landed after the exact `0.10.0` tag and npm
artifact. It adds structured maturity guidance, restores current Codex analysis, and hardens the
coverage, routing, and validation paths. The top-level command registry and the exact
`@aiosbrain/aios-devtools@0.2.0` delegation boundary are unchanged.

Separately, the Team Brain API document revision is now **v1.16**. It documents the already-shipped
authenticated `GET /api/v1/attribution` and `GET /api/v1/timeline` reads. This is contract and
conformance-fixture alignment only: neither route's runtime or wire behavior changed.

### Added

- `aios analyze --json` now exposes typed `chat`, `command`, `edit`, and `doc` actions for every
  maturity axis, plus the exact blockers to the next maturity spine level when the workspace is
  below L5 (AIO-706).
- The maturity capture hook accepts `AIOS_MATURITY_TRANSCRIPT_MAX_MB`. Its safe default is now
  50 MB instead of 10 MB so high-activity sessions are not silently omitted; invalid overrides
  fall back to the default (#550).

### Changed

- Codex maturity analysis now recognizes current custom-tool events and delegated child sessions,
  attributes them to their human-root session, and counts only shell-backed execution wrappers as
  verification. The analysis cache schema moves to v2, so the first run reparses stale v1 cache
  entries (AIO-722).
- Core no longer owns or runs the Skill Library writer and OGR09. That validation moved to
  `aiosbrain/aios-workspace-gui`, where the vendored library lives and the equivalent gate runs in
  CI. The separate marketplace catalog writer remains in core during the GUI cut and now fails
  closed when its catalog is absent (AIO-612).

### Fixed

- Optional coverage dependency installation is now genuinely fail-open: an `npm ci`
  failure cannot prevent the repository or a newly scaffolded consumer from reaching its Brain
  scan. Regression guards enforce the behavior in both workflow copies (AIO-697).
- Explicit-only skills now reject malformed `$skill-id-suffix` and `/skill-id-suffix`
  invocations instead of letting a word-boundary match bypass semantic-routing restrictions
  (AIO-695).
- Explicit skill routing now ignores URL, filesystem-path, and embedded-token sigil substrings
  while preserving real `$skill` and `/skill` invocations (AIO-741).
- Root and merge coverage paths now treat `gui/client/package.json` as ownership of the client
  suite and run it with `npm --prefix gui/client`. Client coverage therefore continues through npm
  workspace deregistration and skips only after the client manifest is removed (AIO-742).
- The public-secret gate classifies a narrow set of committed dummy fixtures without suppressing
  nearby opaque credentials, and forces text-mode scanning so a tracked NUL byte cannot hide a
  later finding (AIO-726).
- Secret-scan failures still identify the rule, relative file, and exact line number, but replace
  the matched source line with `[REDACTED]` before findings are written or printed. Exit behavior
  remains fail-closed (AIO-743).

### Repository-only changes and package boundary

- The new `evolve` skill audits actual local skill reads, routing evidence, and catalog parity with
  prompt text omitted by default. When an operator opts into excerpts, secret-bearing assignments
  are redacted in full, including short, punctuated, whitespace-containing, and URL values
  (AIO-741). The skill lives under root `.claude/skills/` and is available from a source checkout;
  that tree is **not** part of the `@aiosbrain/aios` npm tarball (#541).
- The Workspace cost chart now uses canonical `--aios-*` design variables instead of hard-coded
  provider colors. `gui/` is not included in the CLI tarball, so this ships only in the Workspace
  source/tag, not with the global CLI install (AIO-703).
- Root `.github/` workflows and regression tests remain source-only. The npm tarball does include
  `scripts/`, `hooks/`, `validation/`, the managed `scaffold/` workflow, `CHANGELOG.md`, and the
  pinned Brain contract documents. The routing, analysis, capture, validation, and scaffold
  changes above are therefore inside the published package boundary; only the `evolve` half of
  AIO-741 is source-only.

### Breaking, migration, and rollback

- Upgrade the CLI and the template used for newly scaffolded workspaces with
  `npm install -g @aiosbrain/aios@0.10.1`. There is no configuration, stored-data, or Brain API
  migration from `0.10.0`. The optional transcript-size environment variable needs no action.
- **Validation ownership change:** `validation/validate-all.sh` no longer runs OGR09. Consumers
  that vendor or operate the GUI Skill Library must run its integrity gate from
  `aiosbrain/aios-workspace-gui`; treating the core validator as an OGR09 substitute is no longer
  supported.
- A global install does not rewrite the managed workflow already copied into an existing
  workspace. To apply the scaffold workflow fix there, use the explicit managed-file update below.
- To apply the fix to an existing workspace, check out Workspace `v0.10.1`, then run
  `aios update --from <path-to-v0.10.1-checkout> --no-pull` from that workspace. Review and
  commit the resulting managed-file update normally.
- To roll back the copied workflow, repeat that update from a Workspace `v0.10.0` checkout;
  reinstall `@aiosbrain/aios@0.10.0` as well if the CLI must also be rolled back. The `0.10.0`
  line retains the devtools extraction, preflight, and migration docs.

## [0.10.0] — 2026-08-03

The standalone Workspace release completes the devtools extraction and makes the
published CLI the supported installation boundary. The Team Brain API contract is
unchanged at **v1.15**.

### Added

- **One-click Team Brain Create path (AIO-445)** — `aios onboard` explains the Railway app +
  Postgres deployment and cost boundary, stops for approval before opening the official template,
  and can resume directly into Join when deployment is ready.
- **Devtools migration preflight (AIO-665)** — `npm run check:devtools` resolves every delegated
  command, reports whether it came from the pinned package or `AIOS_DEVTOOLS_DIR`, and fails with
  actionable installation and rollback guidance when the package is unavailable.
- **Brain-reporting scaffold CI** — newly scaffolded workspaces include the protected-main scan
  workflow and report real codebase-health and coverage evidence instead of silently treating
  missing coverage as zero.
- **`aios-deck` skill** — a reusable, brand-themeable deck builder with a visual QA gate.

### Changed

- The pinned onboarding orchestration contract is v3. Create now uses the stable
  `https://aiosbrain.dev/deploy/team-brain/` front door, then reuses Join's canonical-origin human
  gate and `GET /api/v1/me` proof. No Brain origin or API key is persisted before validation, and
  onboarding still never pushes workspace content.
- **Devtools ownership moved out of core (AIO-661/AIO-662)** — `ship`, `build`, `roadmap-run`,
  `spec`, and `consolidate-findings` now dispatch to exactly pinned
  `@aiosbrain/aios-devtools@0.2.0`; their former in-tree implementations and tests were removed.
  The dispatch seam remains fail-open for unrelated core commands and fail-closed with an
  actionable diagnostic for each delegated command.
- The scan-on-merge workflow and its scaffold source now use immutable Action and scanner SHAs,
  exact hash-locked dependencies, lifecycle scripts disabled during installation, and narrowly
  scoped Brain credentials. It runs only after a push to protected `main`.

### Fixed

- Coverage production now writes its artifact even when a test suite fails; GUI coverage is
  optional and no longer collides with the core report key.
- SR18 scope-fence evaluation now distinguishes a per-file “leave unchanged” instruction from a
  blanket scope freeze, carries Scope semantics into nested headings, and exits them at the correct
  sibling level. Devtools CI is pinned to the reviewed current-core implementation.
- Daily operator-loop items reject malformed due dates instead of accepting invalid calendar text.

### Migration (0.9.x → 0.10.0)

- Global installs: `npm install -g @aiosbrain/aios@0.10.0`, then run
  `npm run check:devtools` from a toolkit checkout when validating the delegated command package.
- Adjacent devtools development: export `AIOS_DEVTOOLS_DIR=/path/to/aios-devtools`; the preflight
  names that source explicitly. Remove the variable to return to the pinned npm dependency.
- Rollback: install `@aiosbrain/aios@0.9.1`, whose tarball still contains the in-tree devtools
  implementations. The complete procedure is in `docs/devtools-migration.md`.

## [0.9.1] — 2026-08-01

The CLI becomes an independently installable npm package (AIO-668). Nothing in
the sync protocol changes — brain-api stays at **v1.15**. The patch bump exists
because v0.9.0 was tagged before this packaging work; publishing post-tag
content as `0.9.0` would misrepresent what the tag points at.

### Added

- **`@aiosbrain/aios` npm package** — `package.json` is now publishable
  (`aios-workspace` → `@aiosbrain/aios`, `private` removed, public
  `publishConfig`), with a `files` allowlist shipping exactly the CLI's traced
  runtime surface: `scripts/`, `scaffold/`, `validation/`, `hooks/`, the
  prebuilt `dist/` operator-loop, the relative-path foundation sources
  (`packages/foundation/src`), and the pinned contracts (`docs/brain-api.md`,
  `docs/ENGINEERING-CONSTITUTION.md`, `docs/GETTING-STARTED.md`). `gui/`,
  `src-tauri/`, `test/`, `examples/`, and `.github/` do not ship.
  `@aiosbrain/foundation ^0.1.0` is declared as a real dependency (local dev
  keeps resolving the `packages/foundation` workspace copy). **Not yet
  published** — the first publish is a deliberate `publish-npm.yml` dispatch.
- **Golden-path pack test + CI lane** (`npm run test:pack-golden`,
  `test/npm-pack-golden-path.test.mjs`) — packs the tarball, installs it into a
  clean prefix, then runs `aios --help`, scaffolds a consultant workspace,
  runs `validation/validate-all.sh --quick`, and drives offline
  `aios status`/`push --dry-run` from the installed location only, proving the
  CLI is repo-clone-independent.
- **`publish-npm.yml`** — tokenless npm Trusted Publishing (OIDC) via
  `workflow_dispatch` with an explicit version input that must match
  `package.json`; runs the golden-path gate before `npm publish`.

### Fixed

- `npm run gui` in a GUI-less install now fails with one actionable diagnostic
  instead of a cryptic module-not-found from the spawned server, and
  `scaffold-project.sh` recreates `.opencode/.gitignore` when the scaffold
  source lost it to npm's tarball `.gitignore` stripping.

## [0.9.0] — 2026-08-01

The multi-repo split release (AIO-594/AIO-597): the one-repo layout is cut along
declared, tested seams into a published foundation package, a standalone GUI
repo, and a devtools repo — while the core toolkit in this repo stays
authoritative for every cut surface until the deferred deletion PRs land. The
Brain API contract stays within major `v1` at revision **1.15**.

### Added

- **`@aiosbrain/foundation` 0.1.0 published to npm (public)** — the shared hub
  modules (`runtimes`, `workspace-parse`, `brain-config`, `linear-client`,
  `brain-client`, `git-files`, `constitution`) extracted into the
  `packages/foundation/` npm workspace; the old `scripts/` paths remain as
  one-line re-export shims so nothing consuming them breaks. (AIO-601, #492,
  renamed from `@aios-alpha/monorepo` in #502)
- **Toolkit-runtime seams + contracts** — the GUI reaches the toolkit only
  through the toolkit-location contract (`--toolkit-dir` → `AIOS_TOOLKIT_DIR` →
  pre-split relative fallback; `docs/gui-toolkit-contract.md`), and the
  devtools-bound command set (`ship`, `build`, `roadmap-run`, `spec-eval`,
  `spec-publish`, `consolidate-findings`) reaches core-staying modules only
  through `scripts/toolkit-locate.mjs` (`docs/devtools-toolkit-contract.md`).
  (AIO-600 C1–C5 #495–#499, AIO-594 #511)
- **Boundary gate** — `scripts/check-boundaries.mjs` encodes the repo seams as
  import rules and runs as a named CI gate (`check:boundaries`), including rule
  **R6**: core must not import the devtools path set. (AIO-597 #464/#486,
  AIO-594 #508)
- **`aios codebase-health`** — composed codebase-health scorer + rubric + CLI
  with an advisory CI baseline delta (AIO-605, #494). Brain API revision
  **1.15** adds an optional, scalar-only `metrics.codebase_health` object on
  `POST /codebases` (AIO-608, #489); the scan-on-merge workflow can attach the
  snapshot to its scan payload — opt-in via the `AIOS_PUSH_CODEBASE_HEALTH=1`
  repo variable (default OFF in the workflow; enabled on the canonical repo).
  (AIO-608, #501)
- **`aios repo-bootstrap`** — governance stamp installer for split repos, used
  to bootstrap the cut repositories. (AIO-602, #493)
- **Delivery manifest tooling** — durable split-delivery manifest with read-only
  reporting (AIO-595, #491) and `aios delivery status` cross-repo
  PR/worktree/branch reconciliation (AIO-579, #466).

### Changed

- **GUI + desktop shell cut to `github.com/aiosbrain/aios-workspace-gui`** —
  filtered history from core at freeze SHA `d6dcdeb` (tag `cut/gui-freeze`).
  The in-tree `gui/` + `src-tauri/` remain present and authoritative in 0.9.0;
  their deletion from core is a deferred post-demo PR (AIO-612). (AIO-603 #500,
  AIO-594 #509)
- **Devtools command set cut to `github.com/aiosbrain/aios-devtools`** —
  bootstrapped via `aios repo-bootstrap` with pinned-toolkit CI; the in-tree
  `scripts/` implementations remain authoritative until the removal PR lands.
  (AIO-594)
- **Harness guards hardened** — command segmentation + cwd scope fixed in the
  guard hooks (AIO-637, #513), shell redirects parsed without quoted false
  positives (#472), and the hook installers never clobber tracked
  `core.hooksPath` policy hooks (AIO-638, #503/#504).
- Also in this release: TypeScript covered by typescript-eslint with warn-only
  complexity budgets (AIO-598, #487); the file-size gate flipped to
  default-deny with a ratchet (#463); CI lanes path-filtered (AIO-599, #467);
  the leak gate enforces a name-free baseline on push, not just merge (#450);
  the Claude Code statusline ships to every scaffolded workspace (#485); the
  spec-eval adversarial layer is opt-in (AIO-573, #460); Local Bugbot is
  optional — current-head cloud review satisfies the review gate (AIO-567,
  #484).

### Migration (0.8.0 → 0.9.0)

- **Existing workspace owners:** run `aios update` once, and set
  `AIOS_TOOLKIT_DIR` in your workspace `.envrc` to your toolkit checkout. No
  re-scaffold is needed.
- **Standalone GUI installs** (from `aios-workspace-gui`) must locate the
  toolkit explicitly — set `AIOS_TOOLKIT_DIR` or pass `--toolkit-dir`; the
  relative fallback only resolves in the in-tree monorepo layout
  (`docs/gui-toolkit-contract.md`).
- **In-tree GUI still works:** because the deletion is deferred (AIO-612), the
  `gui/` + `src-tauri/` trees in this repo are still present and authoritative
  in 0.9.0 — nothing changes for in-tree GUI users this release.
- **Desktop (Tauri)** is adjacent-checkout mode only and not demo-ready;
  self-contained bundling is AIO-581, owned by the GUI repo.

## [0.8.0] — 2026-07-28

Onboarding V2 and the first complete Operator Loop release train. This release
standardizes inspect-first setup across Personal, Join, and Create paths; makes
toolkit updates previewable and approval-gated; and advances the additive Brain
API contract through **v1.14**.

### Added

- **Onboarding V2** — `aios onboard --inspect --json` discovers an existing
  toolkit/workspace before mutation, then guides exactly one Personal, Join, or
  Create path. Join validates the approved Brain origin and API key through
  `GET /api/v1/me`; Create remains guide-only; onboarding never pushes content.
- **Operator Loop and Unified Inbox** — action-oriented daily/weekly workflows,
  governed connector ingestion, durable attention state, task writeback, and
  the CLI-first inbox surface.
- **`aios stakeholders (--owns | --who | --meeting)`** — query the team
  Company-Graph over the new team-tier `GET /api/v1/company-graph` endpoint
  (brain-api **v1.5**, additive): who owns a workflow domain, one person's
  role/reports-to/owned workflows, and meeting attendees derived from item
  frontmatter. Team-tier only — an external key is rejected up front on every
  mode via a `GET /me` probe. Exposed over MCP as `brain_stakeholders`.
  (AIO-141)

### Changed

- **Safe toolkit updates** — `aios update --preview` reports its safety check and
  proposed mutations before explicit approval, while managed governance files
  retain three-way merge and conflict-preserving behavior.
- **PR review evidence cleanup** — `aios ship` now treats Local Bugbot as the mandatory canonical
  review, persisted against the exact branch head and verified base SHA. CodeRabbit is
  `ready-for-review` label-gated, optional for Standard PRs, mandatory for safety-sensitive PRs,
  and must provide substantive current-head text. `--reviewers` selects `coderabbit` and/or the
  default `gpt-5.5`; the old `bugbot` name is a deprecated no-op alias. Safety-sensitive changes
  reject `--auto-merge`.

### Fixed

- Hardened secrets, access-tier, worktree, local-review, transcript-grounding,
  connector, and update boundaries so failures remain explicit and recoverable.

## [0.7.0] — 2026-07-04

Cognitive Ergonomics **shadow band** rollout (epic AIO-211): CE and Agentic
Maturity visible against each other in the CLI, cockpit GUI, and Team Brain —
always badged **shadow · uncalibrated**; raw attention signals never sync.
Sync contract stays **v1**; `ce_band` is an additive **v1.3** field on
`POST /api/v1/metrics`. (AIO-212–AIO-222.)

### Added

- **`aios analyze --push`** — includes optional `ce_band` (`0`–`4` or `null`) on
  each daily metrics payload; scored client-side vs the operator's own baseline.
  (AIO-218, #175)
- **TUI CE line** — Cognitive ergonomics shadow band, 14-day AM/CE dual sparkline,
  and attention tips in `aios analyze` text output. (AIO-213)
- **GUI Maturity panel** — cockpit shows AM axes plus CE shadow band and 30-day
  trend (local-only shadow semantics). (AIO-215)
- **Session pulse Stop hook** — after each session, a throttled Stop hook reads
  precomputed `last_summary` (AM + CE + weakest-axis tip); cron recipe in
  `docs/GUIDE.md` §7 keeps analyze state fresh. (AIO-214, #170)
- **`aios analyze --calibrate`** — Phase B calibration harness (Spearman rho vs
  autonomy, MERGE/PROMOTE/HOLD/NOT_ENOUGH_DATA verdict); analysis-only, writes
  a local verdict artifact under `.aios/`. (AIO-216)

### Changed

- **Display rename** — "Agentic Engineering Maturity (AEM)" → **Agentic Maturity
  (AM)** in user-facing copy; wire metric id `aem-individual` and axis keys
  unchanged. (AIO-212)

### Documentation

- **`docs/brain-api.md` v1.3** — documents optional `ce_band` on
  `POST /api/v1/metrics` (provenance-only; brain persists verbatim). (AIO-217)

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
