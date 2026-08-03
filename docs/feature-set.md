# AIOS Workspace — Feature Set

A complete tour of what the system does today and where it's going. AIOS Workspace
is an **agent-native operating system for an individual contributor**: a clean
structure, a set of governance conventions, validators that keep the repo honest,
and a library of multi-agent workflow harnesses that do real operational work with
verifiable output — plus a sync client for pushing selected work to a shared
Team Brain.

It is **clone-per-person, shaped-to-context**: each individual scaffolds their own
workspace, picking one of three first-class contexts (consultant-for-a-client,
employee-in-a-company, or business-owner — the consultant skin plus a sanctioned
`6-business/` sibling for running the business itself) that selects the spine skin,
and runs the same conventions, validators, and harnesses inside it.

---

## 1. The operating model

### Two repositories
AIOS has two kinds of repo: the **individual workspace** (this toolkit's output,
one per person) and the **Team Brain** (`aios-team-brain`, the one shared hub that
receives pushes). The brain is the hub; each workspace is a spoke that pushes only
the content its owner has tagged and chosen. See `architecture.md`.

### The context-driven spine
Every workspace uses the same six-folder pipeline — `0-context`, `1-inbox`,
`2-work`, `3-log`, `4-shared`, `5-personal` — encoding maturity from raw capture to
outward-facing output. The `0-context` and `4-shared` folders take a context skin
(consultant, employee, or business-owner — which reuses the consultant skin); the
rest are identical. business-owner also gets a seventh, sanctioned sibling root,
`6-business/` (bookkeeping, entities, engagements, insurance, administration,
partnerships, portfolio), deliberately kept outside the sync boundary. Content is
promoted deliberately, with a review or approval at each step.

### Access tiers
Every file carries a friendly audience tier (`private | team | client`/`company`)
in frontmatter, mapping to canonical `admin | team | external`. Tiers are enforced
by the guard hook, the validators, the sync client (default-deny), and tier-filtered
retrieval on the brain. See `architecture.md`.

---

## 2. Scaffolding

`scripts/scaffold-project.sh --context consultant|employee|business-owner` spawns a
complete workspace from `scaffold/`: the full numbered spine with the right context
skin, the personal workspace, starter log files (decision log, hours, tasks),
CODEOWNERS, and the shipped governance rules and harness skills. One command, a
ready-to-run
workspace. (`scaffold-engagement.sh` remains as a back-compat shim → consultant.)

The template (`scaffold/.claude/`) ships:
- **Conventions** (`rules/`): decision-log format + type/audience taxonomy, frontmatter
  schema by directory, the promotion/publishing flow, hours logging, and **design-system**
  rules (when you add UI — pin `@aios-alpha/design` + `@aios-alpha/ui`; see `docs/design-system.md`).
- **Workflow harnesses** (`skills/`): the dynamic-workflow skills below. The
  `transcript-decisions` skill is a portable CLI adapter to the typed meetings engine,
  not a Workflow harness.

---

## 3. Validators (OGR)

Fifteen numbered checks — `OGR01`–`OGR15`, five Bash and ten Node ESM — that you can
run individually against any path or as one gate, also wired into CI.
`validation/validate-all.sh <path>` runs all fifteen and exits non-zero with a count of
the ones that failed. Two narrower modes exist for hot paths: `--critical` runs **OGR03
only** (the secret scan), `--quick` runs **OGR01 only** (folder structure).

### Workspace hygiene — point these at a workspace

| Validator | Checks |
|-----------|--------|
| **OGR01** `check-structure.sh` | The numbered spine (accepting the legacy numbered names too), required top-level files (`README.md`, `workspace.yaml`, `contacts.yaml`), and the personal-folder shape. Log files and OKF index files are recommended — missing ones warn, not fail |
| **OGR02** `check-frontmatter.sh` | Markdown files open with a closed YAML frontmatter block carrying the fields their directory requires: `status` everywhere, `owner` in `2-work/`, `access` in `4-shared/` |
| **OGR03** `check-secrets.sh` | API keys, tokens, private keys, `.env` files (**critical** — any match is a hard fail) |
| **OGR04** `check-aios-config.sh` | `aios.yaml`, the Team Brain sync config: no `admin` in `sync_tiers`, `api_key_env` holding a variable *name* rather than a value, no YAML nesting beyond the restricted subset. A repo with no `aios.yaml` is standalone and passes |
| **OGR05** `check-rubrics.sh` | Every `.claude/rubrics/*.md` has `kind: rubric`, an integer `budget`, and at least one criterion row with unique IDs; every rule in `.claude/memory/instincts.md` links at least one incident file that exists. Repos without `rubrics/` or `memory/` pass |
| **OGR14** `check-file-governance.mjs` | The anti-sprawl ratchet — the commit/CI-time backstop behind the write-time `file-governance-guard` hook, importing the *same* classification rules so the two layers can't drift. Every top-level entry must be a spine dir, a toolkit dir, or a known root file, and content files must carry a frontmatter block with a status/access field. Findings are warnings: it reports sprawl, it never fails the run |

### Scaffold + runtime contracts — these validate the toolkit itself

Several of these stamp a throwaway workspace with `scaffold-project.sh` and assert
against the result, so a template regression is caught before anyone clones it.

| Validator | Checks |
|-----------|--------|
| **OGR06** `check-skill-export.mjs` | The BYOA skill-export round-trip: every skill exports cleanly for each runtime (`claude-code`, `hermes`, `openclaw`, `codex`, `opencode`, `claude-api`) and `SKILL.md` stays the single source of truth — valid frontmatter, exactly one H1, `.workflow.js` preserved on claude-code identity, and multi-agent harnesses flagged **degraded** on runtimes that can't run them |
| **OGR07** `check-runtime-adapters.mjs` | The BYOA runtime registry (`scripts/runtimes.mjs`), the flat-YAML config reader, and the GUI adapter registry's resolution rules — deliberately without requiring any external runtime CLI to be installed |
| **OGR08** `check-scaffold-guard.mjs` | A scaffolded workspace ships a *working* guard: `hooks/team-ops-guard.sh` present and executable, its secret patterns alongside it, and a `.claude/settings.json` registering the hook for Edit/Write/MultiEdit — then feeds the shipped hook a secret over stdin and requires it to block (exit 2) |
| **OGR09** *(moved out)* | The cockpit skill-library gate — vendored official skills are Apache-2.0, no proprietary document skill is vendored, no symlinks in the official tree, the committed `index.json` matches what's on disk, community ids stay disjoint from official, marketplace entries carry a pinned `{repo, commit, path_in_repo}` plus per-file sha256 hashes. **Now owned and enforced by [`aiosbrain/aios-workspace-gui`](https://github.com/aiosbrain/aios-workspace-gui)** (AIO-702), which holds the library data it checks; it runs there in that repo's `gates` CI job. Not run by this repo's `validate-all.sh` |
| **OGR11** `check-scaffold-git-workflow.mjs` | A generated workspace carries the personal-workstation git contract in `.claude/CLAUDE.md`, `AGENTS.md`, and `.claude/rules/git-workflow.md` — so new owners and their agents don't treat an IC workspace as a toolkit PR staging area |
| **OGR12** `check-opencode-scaffold.mjs` | A generated workspace is OpenCode-native as well as Claude-native: `opencode.json` (`default_agent`, governance instructions, plugin), the four `.opencode/agents/`, at least six `.opencode/command/` files, the instincts plugin source, and the runtime-agnostic framing in `0-context/index.md` + `AGENTS.md` |
| **OGR15** `check-delivery-skill-suite.mjs` | `.claude/skill-suite.json` validates against its JSON Schema, and every skill in it has trigger-corpus coverage that actually routes: ≥5 positive, ≥5 negative, ≥3 overlap, ≥2 pressure cases plus an explicit one, with mutation skills required *never* to auto-select. Skips cleanly where the manifest isn't installed |

### Advisory scorecards — information, not a gate

Both always exit 0. A brand-new repo should not fail `validate-all` for scoring low.

| Validator | Reports |
|-----------|---------|
| **OGR10** `check-agent-readiness.mjs` | How ready a repo is for agents to work in it verifiably, scored against `agent-readiness.rubric.json` — level, composite %, per-pillar rollup, and the ranked gaps to the next level. `--json` is what `aios assess-codebase` consumes |
| **OGR13** `check-modularity.mjs` | Deterministic architecture metrics from the codebase-memory knowledge graph (dead code, fan-out hotspots, high complexity, mutual recursion) diffed against a committed baseline. Advisory today; flipping `mode: "ratchet"` in `modularity.config.json` makes a regression beyond the configured limits exit 1 |

The content-scanning validators — the secret scan and the frontmatter check — enumerate
their targets **via git** — `git ls-files` (tracked) plus
`git ls-files -o --exclude-standard` (untracked but not ignored) — never a filesystem
walk with an exclude list. That union is exactly the content that can reach a commit, and
it makes gitignored build trees structurally invisible: a 1.6 GB `src-tauri/target` used
to exhaust the secret scan's window so the gate never finished (AIO-517). A directory
that is not a git work tree (the throwaway change-set dir `aios build` assembles) falls
back to a scoped walk.

---

## 4. Guard hook

`hooks/team-ops-guard.sh` is a Claude Code PreToolUse hook that fires on every
Write/Edit and blocks: (1) secrets, (2) private/admin-tier content (rates, margins,
P&L, strategy) written into team/shared directories, and (3) markdown deliverables
missing frontmatter. Prevention at authoring time, before anything reaches version
control.

---

## 5. Dynamic-workflow harnesses — the differentiator

The heart of the system. Instead of asking one agent to do a whole task in one
context, a harness spawns focused sub-agents and adds **adversarial verification** so
its output is trustworthy. The workflow harnesses below are distinct from the typed
transcript review CLI; more harnesses are on the roadmap.

| Harness | What it does | Pattern |
|---------|--------------|---------|
| **decision-audit** | Lints the decision log against governance rules; returns only verified findings | one-verifier-per-rule + adversarial verify |
| **scope-creep** | Flags deliverables that drift from the scope baseline/ledger | per-deliverable classify + severity-downgrade refuter |

These came out of a controlled A/B study (single-pass vs harness on identical inputs).
The headline finding: **adversarial verification — not parallelism — is what makes a
harness trustworthy.** A fan-out without an independent grounding step can amplify a
single agent's error and do *worse* than a single pass. The harnesses encode ten
conventions distilled from that study (`workflows.md`, `scaffold/.claude/skills/README.md`).

Every harness is a **template**, tuned per workspace via `args`, read-only (it returns
data; the caller writes), and demonstrated against the synthetic `examples/sample-engagement/`.

### Transcript review pipeline (typed CLI)

Transcript review is intentionally separate from the dynamic-workflow harnesses. The
`transcript-decisions` skill uses the same portable, typed engine across supported
runtimes; its sole canonical execution path is the `aios transcripts` CLI:

```bash
aios transcripts draft --transcripts 1-inbox/transcripts/meeting.md
aios transcripts list
aios transcripts approve .aios/staging/transcript-decisions/<stage>.json
```

`draft` extracts both grounded decisions and explicit task commitments, grades the full
transcript batch with TD1–TD6, and writes a private `0600` V2 review stage only when
there is a review record to preserve. The owner inspects the stage and `approve` is the
single local write gate for both `3-log/decision-log.md` and `3-log/tasks-team.md`.
Approval attempts the existing `aios push` path only after local apply is durable;
`--no-push` records an explicit skip and a failed push can be retried without reapplying.
`aios loop daily` may show the owner-local pending/failed/unreadable aggregate, while
team and external views omit transcript review. Drafting remains explicit: scheduled,
connector-triggered, and daily-triggered drafting, plus stakeholder enrichment, are
deferred. The retired Workflow file is a non-executable notice only and is never
invoked, adapted, or exported as transcript execution behavior.

### The agentic build pipeline (`aios ship` / `aios roadmap-run`)

The same adversarial discipline drives an end-to-end build loop:

- **`aios ship AIO-<n>`** runs the whole gated loop for one Linear issue — recon → plan → build →
  PR → multi-reviewer consolidation → fix → merge → cleanup — behind an operator **plan gate** and
  **merge gate** (both default ON; they fail closed, never hang, in a non-TTY context). Recon reads
  only git-tracked, deny-filtered files referenced by the untrusted issue text; the merge gate
  requires green CI, a CLEAR consolidator, and a path-gated safety review for safety-critical diffs.
  A stable `SHIP_EXIT` table names every outcome. `--dry-run` previews the plan offline.
- **`aios roadmap-run (--label|--epic|--project)`** is the unattended serial walker: it ships one
  unblocked, unassigned, Todo issue at a time via `aios ship --auto --auto-merge`, fast-forwarding
  `main` between issues and writing a deterministic morning digest every run.
- **`aios pr`** pushes the current worktree branch and opens a GitHub PR **idempotently** (an
  already-open PR for the head branch is reused), always carrying the `AIO-<n>` key in the title so
  the repo automations fire. `aios build --pr` chains it after the pre-ship gates.
- **`aios consolidate-findings --pr <n> --issue AIO-<n> --local-bugbot-review <path>`** merges CI checks, the PR diff,
  mandatory Local Bugbot, current-head CodeRabbit comments/reviews, and an optional GPT-5.5 review into **one severity-ranked, fail-closed finding
  list** (`VERDICT=CLEAR|BLOCKED`; red or still-pending CI can never be CLEAR), which
  `aios build --findings <file>` then fixes from.

The pipeline is tunable and hardened for unattended runs: a **per-step model/effort/timeout config**
(`.aios/loop-models.yaml`, gitignored) with fail-closed cross-family diversity + Claude-runner
guards; **review resilience** (auto-retry once on timeout, diff-size-adaptive review timeouts);
mandatory exact-head Local Bugbot plus label-gated current-head CodeRabbit for selected/safety PRs; and a
**fenced builder** (no push/PR policy + `GIT_CEILING_DIRECTORIES` + a primary-checkout tripwire,
with `ANTHROPIC_API_KEY` stripped from the builder child so it stays on login auth). Overnight
operation on an always-on host: [`docs/hermes-runbook.md`](./hermes-runbook.md).

Full contract: [`docs/agent-build.md`](./agent-build.md).

---

## 6. Synthetic example engagement

`examples/sample-engagement/` is a fully fictional engagement ("Northwind Robotics")
seeded with deliberate governance issues, scope-creep cases, and transcript decisions —
so every harness can be run, demoed, and regression-tested with zero real data. Sample
outputs from one run live in `examples/sample-output/`.

---

## 7. Safety & open-source hygiene

- `scripts/leak-gate.sh` — a confidentiality gate (built from a client's confidential-
  information definition) that blocks client/firm/person identifiers and business-data
  patterns. CI runs it on every PR, so the repo stays clean as it grows.
- MIT licensed; contributions gated on the leak gate + secret scan + validators.

---

## 8. Discoverability: skills + integrations catalog

Every workspace generates two catalogs (`scripts/gen-catalog.mjs`, `npm run gen:catalog`):
- **Skills catalog** (`.claude/skills/INDEX.md`) — every installed skill, what it does,
  and when it runs, parsed from each `SKILL.md`. Surfaced in `CLAUDE.md` and the GUI.
- **Integrations catalog** (`.claude/INTEGRATIONS.md` from `.claude/integrations.json`)
  — connectable tools (Slack, Linear, Notion, GitHub, Gmail/gog-cli, Granola, Mattermost,
  Toggl) with status + how-to-connect. Jira/Confluence ship **example-only** (manual
  setup): the `atlassian` server relies on the unofficial, single-maintainer
  `mcp-atlassian` package, so it was demoted out of the auto-connectable set in V1.0
  hardening and lives pinned + provenance-warned in `.mcp.example.json`. A live
  `.mcp.json` stub and `.mcp.example.json` starter servers ship in the scaffold;
  `docs/integrations.md` has per-tool setup. *Wiring a starter set live is the remaining
  fast-follow.*

## 9. Skill + artifact share/pull

Skills are shareable across the team via the brain:
- `aios push skill <name>` — publish `SKILL.md` (kind `skill`, with a reference manifest)
  + its files (kind `artifact`) under `.claude/skills/<name>/`.
- `aios pull skill <name>` / `aios pull deliverable <path>` — fetch on demand into
  `1-inbox/from-brain/` with provenance (source workspace + author).
- `aios install-skill <name>` — promote a pulled skill into `.claude/skills/`
  (explicit, append-only). **Pulled skills are code and never auto-activate.**
- The dashboard has a **Skills** catalog page with a copyable `aios pull skill` per skill.

## 10. Review-and-push panel (GUI + TUI)

Choosing what reaches the brain is visual, not blind:
- **GUI panel** (`gui/client`, "Review & push" tab) — lists new/modified/blocked/clean
  from `aios status --json`, with per-file tier + block reason, checkboxes to include,
  a dry-run, and push. Backed by token-gated `/api/review` + `/api/push` endpoints that
  reuse the CLI's exact plan logic — so the same default-deny safety holds server-side
  (an `admin` file stays blocked even if explicitly requested).
- **TUI** (`aios review`) — the same model, keyboard-driven, for terminal users.

---

## 11. The cockpit — chat with your repo

> **Repo note:** the GUI (this cockpit + the Review-and-push panel above, plus the
> `src-tauri/` desktop shell) has been cut to a standalone repo,
> [`aiosbrain/aios-workspace-gui`](https://github.com/aiosbrain/aios-workspace-gui) —
> its future home. Until the deferred deletion PR (AIO-612) merges, the in-tree
> `gui/` here stays the authoritative, working copy. The standalone repo builds
> against the published `@aiosbrain/foundation` npm package + the `aios` CLI and
> locates a toolkit checkout per [`gui-toolkit-contract.md`](gui-toolkit-contract.md).
> The desktop (Tauri) shell supports **adjacent-checkout mode only** today —
> self-contained bundling is AIO-581, owned by the GUI repo.

`npm run gui` opens a local web cockpit that drives this repo through the Claude
Agent SDK. Beyond the Review-and-push panel above, the chat surface ships:

- **Model picker** — choose **Sonnet 4.6** (default; fast and cheap) or
  **Opus 4.8** from the chat header and switch **mid-session with no reconnect**;
  the choice persists to `agent_model` in `aios.yaml`. An unknown value degrades
  to Sonnet with a visible warning rather than breaking chat.
- **Resumable Chats** — every conversation is saved to a local session store and
  listed in a sidebar (titled from its first message, newest first). Reopen a
  chat to replay its transcript and resume the same session; `+ New chat` starts
  fresh. The last-open chat is restored on reload.
- **Context (est.) meter** — an approximate `~Nk / 200k` read of how much of the
  model's window the last turn used (input + cached tokens). Labelled *est.*
  because it's a per-turn proxy, not a live running total.
- **Markdown rendering** — assistant replies render as GitHub-flavored markdown;
  links open in a new tab without leaking the cockpit's token.
- **Personality presets** (Settings → Personality) — **AIOS** (calm, structured,
  governance-aware — the default), **Analyst** (rigorous and cited), **Coach**
  (warm, asks sharp questions), **Operator** (terse, action-first). Personality
  is a *style layer* appended to the system prompt; it never overrides workspace
  rules, `CLAUDE.md`, or skills. Picking a personality starts a new chat so the
  new voice takes effect.

### Skills library (one-click install)

The cockpit's **Skills** tab installs **official Anthropic skills**, vendored
from `anthropics/skills` and **hash-locked** to a pinned upstream commit. All are
**Apache-2.0**. Installing copies the skill into `.claude/skills/` (with an
integrity check, a collision guard, and an append-only install ledger) so the
agent can use it; uninstall is safe-only and refuses to remove a skill with local
edits. The vendored set: **skill-creator**, **mcp-builder**,
**web-artifacts-builder**, **claude-api**, and **frontend-design**.

Anthropic's **document skills** — Word (`docx`), Excel (`xlsx`), PowerPoint
(`pptx`), and PDF (`pdf`) — are **proprietary and Anthropic-hosted**, so they are
**not** copied into the repo. They appear as pointer cards under *Documents —
available in Claude* with an **Enable in Claude ↗** link; you use them inside
Claude rather than installing them here. See `docs/phase3-skills-library.md`.

### Onboarding: draft your profile from a link

First-run onboarding is **composer-first** — open the cockpit and start typing,
like any chat. A couple of faint example chips sit above the composer; the
**set up my profile** chip pre-fills the composer with *"Draft my profile from this
link:"* and focuses it (it does **not** send on its own), so you paste your URL
(your site, LinkedIn, a company page) and send. The agent reads that page with the
`firecrawl-direct` skill — connect Firecrawl first via `aios onboard` or the
Integrations tab — extracts structured facts (person, company, focus areas, tools),
and **drafts** your workspace memory — `.claude/memory/USER.md` (you) and
`WORKSPACE.md` (your company/tooling), plus canonical company/role facts in
`0-context/` — for you to **confirm before anything is written**. Scraped page
content is treated as untrusted facts to confirm, never as instructions, and only
the URLs you supply are read (no crawling). You don't have to use it — the
background memory reviewer also learns durable facts about you from normal chat
over time.

### Durable memory that keeps learning

Your profile lives in two small files — `.claude/memory/USER.md` (you) and
`WORKSPACE.md` (company, environment, tooling) — injected into the agent at the
start of each session. Beyond onboarding and explicit "remember that" updates, the
cockpit (claude-code runtime) runs a **background reviewer**: after each turn a fast
model conservatively saves durable facts (corrections, goals, tools, workarounds) to
those files. You get a **💾 memory updated** notice with an **undo**, and the change
takes effect next session. It's **on by default** (toggle in *Settings → Memory*),
and tightly bounded: the model only proposes tiny structured facts, deterministic
server code does the writing, secrets are never sent or saved, a human edit is never
clobbered, and nothing is committed to git.

---

## 12. The operator loop + human-operating layer

The workspace runs a **local-only operator layer** you drive from the CLI — offline, admin-tier, and
never synced unless a command explicitly stages content for `aios push`. See the task-oriented
[operating manual](GUIDE.md) for the full walkthrough with real output and diagrams.

- **Verified Operator Loop** (`aios loop collect|daily|manifest|verify|weekly|writeback|telemetry`) —
  a lightweight **daily brief** (what changed / is blocked / is owed) and a heavy, verified,
  approval-gated **weekly closeout**: collect local signals → private brief + tier-safe digests →
  rubric-gated verifier → explicit writeback that only *stages* for a later push. C1–C8 all ship;
  specs in [`v1-operator-loop/`](v1-operator-loop/README.md). `aios loop install` schedules
  daily/weekly/an `aios analyze` self-refresh via launchd (macOS) or cron (elsewhere) — see
  [`loop-install.md`](loop-install.md), which also covers authenticating a scheduled run against
  a dotenvx-encrypted `.env` with no direnv.
- **Asks queue** (`aios asks`) — a non-blocking escalation inbox. Session hooks route events into it
  (idle → blocker, an assistant question → decision, a completion → fyi); you drain it on your own
  cadence. Local, admin-tier, never synced.
- **Attention mode** (`aios mode deep-work|orchestration`) — one command to silence or restore the
  local end-of-turn ping (toggles only `preferredNotifChannel`; mobile push untouched).
- **Steering decisions** (`aios decisions`) — a local corpus of `AskUserQuestion` / plan-approval
  moments (with outcomes on annotation). Distinct from the Team Brain decision log — one is *how you
  steer the agent* (private), the other is *what the team decided* (shared).
- **Spec gate** (`aios spec eval|fix`) — a two-layer (deterministic + adversarial) readiness check
  that enforces the pick-up-able-issue bar before a builder starts; it also gates `aios relay --spec`.
- **Permission rails** (`aios rails missing|suggest|apply`) + **`aios assess-codebase`** — score any
  repo's agent-readiness and stand up a *safe* permission allowlist (suggest → review → apply;
  guards are never touched).
- **Native agent-session time tracking** (`aios time capture|report|reconcile`) — derives
  agent-runtime work blocks from `~/.claude` session logs into an admin-tier `3-log/time-log.md`
  (realpath-scoped, never synced); the closeout surfaces a runtime-by-tag roll-up. See
  `docs/v1-operator-loop/domains/time-tracking.md`.

---

## 13. Timeline — screenshot-rich weekly summaries (team + public)

`aios timeline` turns a week of work across **any number of repos** into a styled, self-contained
HTML "what we shipped" page — one run, two audiences:

- **Collect** — merged PRs (`gh pr list`) + raw commits (`git log`) per `--repo <path>[=liveUrl]`
  (or everything in `.aios/timeline-config.json`, which also carries each repo's tier + display
  alias, same default-deny posture as `.aios/time-config.json`). Repos without a `gh`-visible
  remote degrade gracefully to commit-only data.
- **Faces** — contributor avatars resolve brain-first (`GET /api/v1/members` `github_login` →
  `avatar_url`), fall back to GitHub's public avatar CDN, then to an inline initials mark — a new
  contributor never renders as a broken image.
- **Screenshots** — per merged PR: Vercel preview URL from the bot's PR comment → the repo's
  production `liveUrl` → a "code change" card (diff stat) for non-visual work. Captured with the
  same pinned `agent-browser` the nightly UX harness drives; `--no-shots` skips capture.
- **Two renders, one dataset** — `--as team|external|all`. Team sees everything ≤ team tier with
  PR links; external is strictly a subset (external-tier repos only, no links, no diagnostics).
  Both are single-file HTML (images inlined as data URIs) styled with `@aios-alpha/design`
  tokens, light + dark.
- **Fail-closed sharing** — the external file ships **only** after `scripts/leak-gate.sh` actually
  ran clean over it: a detected term withholds it (exit 2), an unconfigured term set withholds it
  (exit 3) — never "filtered by convention". Admin-tier repos render nowhere.

Output lands in `.aios/timeline/<stamp>/index-{team,external}.html` (gitignored, never synced);
`--dry-run` previews repos/window/PR counts without capturing or writing; `--open` finishes on a
browser tab.

---

## Roadmap

The clean core + catalogs + share/pull + review panel + operator loop + ergonomics layer ship today.
Deliberately deferred — and ideal contribution targets:

- **Live integration wiring** — wire a starter set (Gmail via gog-cli + Granola + one
  MCP server) end-to-end, beyond the catalog + `.mcp.json` scaffold that ships now.
- **Sync pipeline** — fetch → triage → promote across email/chat/time-tracking, as
  pluggable integration adapters (rather than hard-wired to one stack).
- **Access-aware knowledge base** — local RAG over the corpus with retrieval filtered
  by access tier, exposed as an MCP server.
- **Scheduling** — OS-level recurring sync.
- **More harnesses** — a weekly-synthesis harness *with a fidelity verifier* (the study
  showed synthesis without one fabricates), a ticket-hygiene harness, and a
  classifier-router that picks single-pass vs harness by input size.

See the issue tracker for the current list.
