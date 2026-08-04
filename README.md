# AIOS Workspace

An open, agent-native operating system for **an individual contributor** — the
workspace you work in day to day and from which you push selected output to a
shared [AIOS Team Brain](docs/brain-api.md).

AIOS Workspace gives you **a clean folder structure**, a set of **governance
conventions**, **validators** that keep the repo honest, a growing library of
**dynamic multi-agent workflow harnesses** that do real operational work —
auditing a decision log, catching scope creep, turning meeting transcripts into
decisions, synthesizing the week — with **adversarial verification and
rubric-gated self-correction** so their output is trustworthy, and a **sync
client + local GUI** for deciding what leaves your machine and pushing it to the
brain.

AIOS is organized across **three repositories**, with distinct responsibilities:

- **This repo — the individual workspace.** One per person. You work here; you
  choose what to share. Nothing leaves until you `aios push` it.
- **The [standalone GUI](https://github.com/aiosbrain/aios-workspace-gui).**
  The local web GUI and desktop shell. It lives there, not here (AIO-612).
- **The [Team Brain](docs/brain-api.md).** The *one* shared service that receives
  everyone's pushes and answers questions across the team. It is the only "team"
  layer.

It is designed to be **cloned per person and shaped to your context**, asked once
at onboarding:

> **Are you a consultant working in a team for a client**, or **an employee
> working inside a company?**

Your answer selects the spine that scaffolds — the same skeleton with a context
skin (client/engagement framing, or internal role/OKR framing).

```
aios-workspace/
├── scaffold/        the workspace template (structure + rules + skills)
│   └── .claude/
│       ├── rules/    decision-log · frontmatter · publishing · hours · interlinking
│       ├── skills/   dynamic-workflow harnesses (decision-audit, scope-creep,
│       │             transcript-decisions, weekly-synthesis, aios-sync)
│       ├── rubrics/  checkable criteria for rubric-gated self-correction
│       └── memory/   instincts + incidents (cross-session learning)
├── validation/      OGR01–OGR15 validators (workspace hygiene · scaffold + runtime
│                    contracts · advisory scorecards); validate-all.sh runs them all
├── hooks/           Claude Code guards (secrets · access · frontmatter · sync nudge)
│                    shipped into every scaffolded workspace + registered in
│                    .claude/settings.json, so the PreToolUse guard fires there too
├── scripts/         scaffold-project.sh · aios.mjs (Team Brain sync CLI) · leak-gate.sh
├── packages/        @aiosbrain/foundation (npm workspace) — the shared hub modules,
│                    published to npm; scripts/ paths re-export it as thin shims
├── examples/        a fully synthetic sample to demo + test the harnesses
└── docs/            architecture · feature-set · workflows · brain-api (sync contract)
```

## Install the current stable workspace

For onboarding, clone the immutable public release rather than the moving `main`
branch:

```bash
git clone --branch v0.10.0 --depth 1 \
  https://github.com/aiosbrain/aios-workspace.git aios-toolkit
cd aios-toolkit
```

Then use `scripts/scaffold-project.sh` as shown below. A plain `git clone` checks
out `main`; that is the development surface for contributors and can contain
merged work that has not passed release promotion yet.

The CLI is also distributed on npm under the stable `latest` dist-tag:

```bash
npm install -g @aiosbrain/aios@latest
aios --help
```

The npm package carries the sync client, workspace scaffold
(`scripts/scaffold-project.sh`), the OGR validators (`validation/`), the
governance hooks, and the pinned contracts (`docs/brain-api.md`,
`docs/ENGINEERING-CONSTITUTION.md`). For the current onboarding flow, keep the
tagged toolkit checkout as the source used to scaffold and update workspaces;
the global package is a convenient CLI distribution, not a replacement for
that checkout. The unscoped `aios` package on npm is unrelated.

Release-tag checkouts do not follow `main`. When a later release is published,
fetch and check out that exact tag, then apply it deliberately from your
workspace with `aios update --from /path/to/aios-toolkit --no-pull`. Release
notes will name the tag and any migration steps.

## Quickstart

> **Want to actually drive this?** [`docs/GUIDE.md`](docs/GUIDE.md) — *The AIOS operating manual* —
> is the one task-oriented walkthrough of the whole surface, organized around your day: the daily
> brief, the asks queue + attention mode, the weekly loop, syncing to the brain, measuring yourself
> (AM), gating specs, and the agent pipeline. Start there.
>
> **New user?** [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) is the
> step-by-step stable-release path to your first `aios push` live on the Team Brain.

Scaffold your workspace — pick the context that matches how you work:

```bash
# Consultant working in a team for a client:
scripts/scaffold-project.sh --context consultant \
  --slug acme-workspace --stakeholder "Acme Corp" \
  --owner alex --team "alex,sam,jordan" \
  --org your-github-org \
  --output ~/Projects/acme-workspace

# Employee working inside a company:
scripts/scaffold-project.sh --context employee \
  --slug alex-workspace --stakeholder "Acme Inc" \
  --owner alex --team "alex,sam,jordan" \
  --org your-github-org \
  --output ~/Projects/alex-workspace
```

(Legacy flags still work: `--profile engagement` maps to `--context consultant`,
and `--lead`/`--captain`/`--client`/`--members` are accepted as aliases.)

Validate any workspace:

```bash
validation/validate-all.sh ~/Projects/acme-workspace
```

Run a harness (via Claude Code's Workflow tool) against the included sample:

```
Workflow({
  scriptPath: "scaffold/.claude/skills/decision-audit/decision-audit.workflow.js",
  args: { repoPath: "examples/sample-engagement", runDate: "2026-06-05" }
})
```

Prefer to just see results? [`examples/sample-output/`](examples/sample-output/) has
real harness output on the synthetic sample — a decision-log audit (9 verified
findings, false positives filtered out), a scope-creep register, and decisions
extracted from meeting transcripts.

Connect to a Team Brain (optional — everything works offline without one):

```bash
cp .env.example .env          # add your AIOS_API_KEY
git config aios.member alex   # your identity
aios status                   # what would sync, what's blocked, why
aios push                     # push team- and outward-tier content
aios query "what's blocking sprint 2?"
```

Chat with your repo in a browser instead of the terminal — the **local cockpit**:

```bash
npm run gui -- --repo ~/Projects/acme-workspace
```

> **Repo topology note:** the GUI and desktop shell live in
> [`aiosbrain/aios-workspace-gui`](https://github.com/aiosbrain/aios-workspace-gui)
> (history filtered from this repo). `gui/` and `src-tauri/` were **deleted from this
> repo in AIO-612** — that repo is the only copy. The GUI locates a toolkit checkout via
> [`docs/gui-toolkit-contract.md`](docs/gui-toolkit-contract.md): `--toolkit-dir`
> flag → `AIOS_TOOLKIT_DIR` env → an actionable error. The pre-split relative fallback
> (`gui/server/../../`) still exists in the GUI repo's resolver but can no longer reach a
> toolkit — nothing sits above it any more — so one of the two must be set.
> It builds against the published
> [`@aiosbrain/foundation`](https://www.npmjs.com/package/@aiosbrain/foundation)
> package plus the `aios` CLI — never toolkit internals.

The cockpit is more than a chat box:

- **Model picker** — switch between **Sonnet 4.6** (the fast, cheap default) and
  **Opus 4.8** live, mid-session, with no reconnect.
- **Chats** — a resumable chat-history sidebar; each conversation is saved and
  reopened where you left off (`+ New chat` to start fresh).
- **Context (est.) meter** — an approximate read of how much of the model's
  window the last turn used, so you can see when a chat is getting heavy.
- **Markdown rendering** — assistant replies render as GitHub-flavored markdown
  (tables, lists, code).
- **Settings → Personality** — pick the agent's voice (AIOS · Analyst · Coach ·
  Operator); it's a style layer over the system prompt and never overrides your
  rules, `CLAUDE.md`, or skills.
- **Skills** — install official, Apache-2.0 Anthropic skills (vendored and
  hash-locked) into `.claude/skills/` with one click; document skills (Word,
  Excel, PowerPoint, PDF) are surfaced as pointers to **Enable in Claude**.

First-run onboarding can **draft your profile from a link** — paste a company or
profile URL and the agent reads it with Firecrawl, then drafts your
`.claude/CLAUDE.md` for you to confirm (connect Firecrawl in Integrations first).

Not sure what else is available? `npm run help` lists every script grouped by
category (Core / Dev / Build / Internal), instead of the undifferentiated dump a
bare `npm run` prints.

## The numbered spine

Every workspace uses the same six-folder pipeline, raw → refined. The `0-context`
and `4-shared` folders take a context skin; the rest are identical either way:

| # | Folder | Holds | Audience |
|---|--------|-------|----------|
| 0 | context | consultant: charter, scope baseline + ledger · employee: role, OKRs | team |
| 1 | inbox | raw inputs (transcripts, notes, from-brain) | private |
| 2 | work | your deliverables and working docs | team |
| 3 | log | decision log, tasks, hours | private |
| 4 | shared | outward-facing — client (consultant) or company (employee) | external |
| 5 | personal | your private workspace | private |

## Access tiers

You choose what leaves your machine. Content is tagged with a **friendly** tier
label that maps to the engine's **canonical** tier:

| Friendly (consultant) | Friendly (employee) | Canonical | Syncs? |
|---|---|---|---|
| `private` | `private` | `admin` | never |
| `team` | `team` | `team` | yes — to the team brain |
| `client` | `company` | `external` | yes — outward-facing |

**Default-deny:** untagged content and anything `private`/`admin` never syncs.
Promotion is always a deliberate `aios push`.

## The daily driver — loop, asks, mode, specs

Beyond scaffolding and sync, the workspace runs an **operator loop** and a **human-operating layer**
you drive from the CLI — all offline, all local-only until you push:

- **Daily brief** — `aios loop daily`: what changed, what's blocked, what you owe today, with your
  own escalation queue on top.
- **Asks queue** — `aios asks list/add/resolve/drain`: a non-blocking escalation inbox that session
  hooks fill for you (idle → blocker, an assistant question → decision, a completion → fyi).
- **Attention mode** — `aios mode deep-work | orchestration`: one command to silence or restore the
  local end-of-turn ping (touches only `preferredNotifChannel`; mobile push untouched).
- **Steering decisions** — `aios decisions list/outcome/export`: a local, admin-tier corpus of the
  `AskUserQuestion` / plan-approval moments (this is *not* the Team Brain decision log — see the
  guide's disambiguation box).
- **Weekly loop** — `aios loop collect → weekly → verify → writeback`: a verified, approval-gated
  closeout that proves every shareable claim before it can sync.
- **Measure yourself** — `aios analyze` (agentic maturity (AM) + attention + spend),
  `aios time` (agent-runtime time tracking).
- **Spec gate** — `aios spec eval | fix`: grade a spec against the pick-up-able-issue bar before a
  builder touches it.
- **Agent pipeline** — `aios relay | build | ship`: an Opus builder reviewed by an independent
  model, gated at plan + merge. See [`docs/agent-build.md`](docs/agent-build.md).
- **Repo hardening** — `aios assess-codebase`, `aios rails missing/suggest/apply`: score any repo's
  agent-readiness and stand up a safe permission allowlist.

Every one of these is walked through, with real output and diagrams, in
[`docs/GUIDE.md`](docs/GUIDE.md).

## Skills & integrations

Every workspace ships a generated **skills catalog** (`.claude/skills/INDEX.md`) and an
**integrations catalog** (`.claude/INTEGRATIONS.md`, from `.claude/integrations.json`) —
so you can see what the workspace can do and connect to (Slack, Jira, Notion, Linear,
GitHub, Gmail, Granola, Confluence, Mattermost, Toggl). To wire an integration, copy its
server from `scaffold/.mcp.example.json` into `scaffold/.mcp.json`, set the env vars, and run
`npm run gen:catalog`. Setup notes: [`docs/integrations.md`](docs/integrations.md).

Skills are shareable: `aios push skill <name>` publishes to the brain; `aios pull skill
<name>` + `aios install-skill <name>` adopt one (install is always explicit — pulled
skills never auto-activate).

## Terminology

The toolkit started life in consulting; both vocabularies are accepted everywhere
(validators, hooks, harnesses) and existing clones never need to rename:

| Concept | Current | Legacy alias |
|---|---|---|
| Onboarding selector | `--context consultant\|employee` | `--profile project\|engagement` |
| Spine 0 | `0-context/` | `00-project/` · `00-engagement/` |
| Spine 4 | `4-shared/` | `04-shared/` · `04-client-surface/` |
| Root config | `workspace.yaml` | `project.yaml` · `engagement.yaml` |
| Owner | `--owner` | `--lead` · `--captain` |
| Counterparty | `--stakeholder` | `--client` |
| Outward tier | `client`/`company` (→`external`) | — |

See [`docs/GUIDE.md`](docs/GUIDE.md) for the task-oriented operating manual (the
whole CLI, organized around your day),
[`docs/architecture.md`](docs/architecture.md) for the hub-and-spoke model and
access tiers, [`docs/feature-set.md`](docs/feature-set.md) for the full feature set,
[`docs/workflows.md`](docs/workflows.md) for the harness design study that shaped
the skills, [`docs/byoa.md`](docs/byoa.md) for **Bring Your Own Agent** (choose
your runtime — Claude Code, Hermes, OpenClaw, Codex…), and
[`docs/brain-api.md`](docs/brain-api.md) for the Team Brain sync contract.

## Status

Early and open. The clean core (structure, rules, validators, guard, harnesses),
the rubric-gated self-correction layer, the Team Brain sync client, and the local
GUI are here; more harnesses and integration adapters are on the
[roadmap](../../issues). Contributions welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE).
