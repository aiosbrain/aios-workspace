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

There are **two repositories** in AIOS, and they are not the same thing:

- **This repo — the individual workspace.** One per person. You work here; you
  choose what to share. Nothing leaves until you `aios push` it.
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
├── validation/      OGR validators (structure · frontmatter · secrets · aios config · rubrics)
├── hooks/           Claude Code guards (secrets · access · frontmatter · sync nudge)
│                    shipped into every scaffolded workspace + registered in
│                    .claude/settings.json, so the PreToolUse guard fires there too
├── scripts/         scaffold-project.sh · aios.mjs (Team Brain sync CLI) · leak-gate.sh
├── gui/             local web GUI — chat with this repo via the Claude Agent SDK
├── examples/        a fully synthetic sample to demo + test the harnesses
└── docs/            architecture · feature-set · workflows · brain-api (sync contract)
```

## Quickstart

> **New contributor?** [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) is the
> step-by-step path from a fresh clone to your first `aios push` live on the Team Brain.

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

## Skills & integrations

Every workspace ships a generated **skills catalog** (`.claude/skills/INDEX.md`) and an
**integrations catalog** (`.claude/INTEGRATIONS.md`, from `.claude/integrations.json`) —
so you can see what the workspace can do and connect to (Slack, Jira, Notion, Linear,
GitHub, Gmail, Granola, Confluence, Mattermost, Toggl). To wire an integration, copy its
server from `.mcp.example.json` into `.mcp.json`, set the env vars, and run
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

See [`docs/architecture.md`](docs/architecture.md) for the hub-and-spoke model and
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

[Apache-2.0](LICENSE).
