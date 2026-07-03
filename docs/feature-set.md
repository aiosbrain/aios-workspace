# AIOS Workspace — Feature Set

A complete tour of what the system does today and where it's going. AIOS Workspace
is an **agent-native operating system for an individual contributor**: a clean
structure, a set of governance conventions, validators that keep the repo honest,
and a library of multi-agent workflow harnesses that do real operational work with
verifiable output — plus a sync client for pushing selected work to a shared
Team Brain.

It is **clone-per-person, shaped-to-context**: each individual scaffolds their own
workspace, picking the context (consultant-for-a-client or employee-in-a-company)
that selects the spine skin, and runs the same conventions, validators, and
harnesses inside it.

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
(consultant or employee); the rest are identical. Content is promoted deliberately,
with a review or approval at each step.

### Access tiers
Every file carries a friendly audience tier (`private | team | client`/`company`)
in frontmatter, mapping to canonical `admin | team | external`. Tiers are enforced
by the guard hook, the validators, the sync client (default-deny), and tier-filtered
retrieval on the brain. See `architecture.md`.

---

## 2. Scaffolding

`scripts/scaffold-project.sh --context consultant|employee` spawns a complete
workspace from `scaffold/`: the full numbered spine with the right context skin, the
personal workspace, starter log files (decision log, hours, tasks), CODEOWNERS, and
the shipped governance rules and harness skills. One command, a ready-to-run
workspace. (`scaffold-engagement.sh` remains as a back-compat shim → consultant.)

The template (`scaffold/.claude/`) ships:
- **Conventions** (`rules/`): decision-log format + type/audience taxonomy, frontmatter
  schema by directory, the promotion/publishing flow, hours logging, and **design-system**
  rules (when you add UI — pin `@aios-alpha/design` + `@aios-alpha/ui`; see `docs/design-system.md`).
- **Harnesses** (`skills/`): the dynamic-workflow skills below.

---

## 3. Validators (OGR)

Pure-shell, dependency-free checks you can point at any workspace, also wired into
CI:

| Validator | Checks |
|-----------|--------|
| `check-structure.sh` | The numbered spine, required files, personal-folder shape |
| `check-frontmatter.sh` | YAML frontmatter present + required fields by directory |
| `check-secrets.sh` | API keys, tokens, private keys, `.env` files (**critical** — hard fail) |

`validate-all.sh` runs all three, with `--critical` and `--quick` modes.

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
its output is trustworthy. Three ship today; more are on the roadmap.

| Harness | What it does | Pattern |
|---------|--------------|---------|
| **decision-audit** | Lints the decision log against governance rules; returns only verified findings | one-verifier-per-rule + adversarial verify |
| **scope-creep** | Flags deliverables that drift from the scope baseline/ledger | per-deliverable classify + severity-downgrade refuter |
| **transcript-decisions** | Turns meeting transcripts into novel, grounded decision rows | fan-out extract + dedup + adversarial grounding |

These came out of a controlled A/B study (single-pass vs harness on identical inputs).
The headline finding: **adversarial verification — not parallelism — is what makes a
harness trustworthy.** A fan-out without an independent grounding step can amplify a
single agent's error and do *worse* than a single pass. The harnesses encode ten
conventions distilled from that study (`workflows.md`, `scaffold/.claude/skills/README.md`).

Every harness is a **template**, tuned per workspace via `args`, read-only (it returns
data; the caller writes), and demonstrated against the synthetic `examples/sample-engagement/`.

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
  — connectable tools (Slack, Jira, Confluence, Linear, Notion, GitHub, Gmail/gog-cli,
  Granola, Mattermost, Toggl) with status + how-to-connect. A live `.mcp.json` stub and
  `.mcp.example.json` starter servers ship in the scaffold; `docs/integrations.md` has
  per-tool setup. *Wiring a starter set live is the remaining fast-follow.*

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
**draft from a link** chip pre-fills the composer with *"Draft my profile from this
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

## Roadmap

The clean core + catalogs + share/pull + review panel ship today. Deliberately
deferred — and ideal contribution targets:

- **Verified Operator Loop (V1, in progress)** — the daily/weekly loop over tier-tagged
  local signals, incl. **native agent-session time tracking**: `aios time capture` derives
  agent-runtime work blocks from `~/.claude` session logs into an admin-tier
  `3-log/time-log.md` (realpath-scoped, never synced) and the closeout surfaces a
  runtime-by-tag roll-up. See `docs/v1-operator-loop/domains/time-tracking.md`.
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
