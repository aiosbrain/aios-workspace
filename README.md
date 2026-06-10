# Agentic Team Ops

An open, agent-native operating system for teams — product, engineering, design,
consulting, and transformation alike.

Agentic Team Ops gives a team **a clean folder structure**, a set of
**governance conventions**, **validators** that keep a repo honest, a growing
library of **dynamic multi-agent workflow harnesses** that do real operational work —
auditing a decision log, catching scope creep, turning meeting transcripts into
decisions, synthesizing the week — with **adversarial verification and rubric-gated
self-correction** so their output is trustworthy, and an optional **sync client +
local GUI** for connecting to an [AIOS Team Brain](docs/brain-api.md).

It is designed to be **forked per team or project**: scaffold a new team-ops repo,
fill in the numbered spine as the work runs, and point the harnesses at it.

```
agentic-team-ops/
├── scaffold/        the team-ops repo template (structure + rules + skills)
│   └── .claude/
│       ├── rules/    decision-log · frontmatter · publishing · hours
│       ├── skills/   dynamic-workflow harnesses (decision-audit, scope-creep,
│       │             transcript-decisions, weekly-synthesis, aios-sync)
│       ├── rubrics/  checkable criteria for rubric-gated self-correction
│       └── memory/   instincts + incidents (cross-session learning)
├── validation/      OGR validators (structure · frontmatter · secrets · aios config · rubrics)
├── hooks/           Claude Code guards (secrets · access · frontmatter · sync nudge)
├── scripts/         scaffold-project.sh · aios.mjs (Team Brain sync CLI) · leak-gate.sh
├── gui/             local web GUI — chat with this repo via the Claude Agent SDK
├── examples/        a fully synthetic sample engagement to demo + test the harnesses
└── docs/            architecture · feature-set · workflows · brain-api (sync contract)
```

## Quickstart

Spawn a new team repo:

```bash
scripts/scaffold-project.sh \
  --slug acme-team-ops --stakeholder "Acme Corp" \
  --lead alex --members "alex,sam,jordan" \
  --org your-github-org \
  --output ~/Projects/acme-team-ops
```

(Consulting teams: `--profile engagement` keeps the legacy layout —
`scaffold-engagement.sh` still works and does exactly that.)

Validate any team-ops repo:

```bash
validation/validate-all.sh ~/Projects/acme-team-ops
```

Run a harness (via Claude Code's Workflow tool) against the included sample:

```
Workflow({
  scriptPath: "scaffold/.claude/skills/decision-audit/decision-audit.workflow.js",
  args: { repoPath: "examples/sample-engagement", runDate: "2026-06-05" }
})
```

Prefer to just see results? [`examples/sample-output/`](examples/sample-output/) has
real harness output on the synthetic engagement — a decision-log audit (9 verified
findings, false positives filtered out), a scope-creep register, and decisions
extracted from meeting transcripts.

Connect to a Team Brain (optional — everything works offline without one):

```bash
cp .env.example .env          # add your AIOS_API_KEY
git config aios.member alex   # your identity
aios status                   # what would sync, what's blocked, why
aios push                     # push team/external-tier content
aios query "what's blocking sprint 2?"
```

Chat with your repo in a browser instead of the terminal:

```bash
npm run gui -- --repo ~/Projects/acme-team-ops
```

## The numbered spine

Every team repo uses the same six-folder pipeline, raw → refined:

| # | Folder | Holds | Audience |
|---|--------|-------|----------|
| 00 | project | charter, scope baseline + ledger, roles | team |
| 01 | intake | raw inputs (transcripts, notes, from-brain) | admin |
| 02 | deliverables | sprint-scoped team outputs | team |
| 03 | status | decision log, hours, tasks | admin |
| 04 | shared | lead-approved, externally shareable | external |
| 05 | personal | per-member private workspace | individual |

## Terminology

The toolkit started life in consulting; both vocabularies are accepted everywhere
(validators, hooks, harnesses) and forks never need to rename:

| Concept | Canonical | Legacy alias |
|---|---|---|
| Unit of work | project | engagement |
| Spine 00 | `00-project/` | `00-engagement/` |
| Spine 04 | `04-shared/` | `04-client-surface/` |
| Root config | `project.yaml` | `engagement.yaml` |
| Team lead | lead | captain |
| Counterparty | stakeholder | client |
| Access tier | `external` | `client` |

Access tiers: `admin` (never leaves the repo) · `team` · `external`.

See [`docs/architecture.md`](docs/architecture.md) for the hub-and-spoke model and
access tiers, [`docs/feature-set.md`](docs/feature-set.md) for the full feature set,
[`docs/workflows.md`](docs/workflows.md) for the harness design study that shaped
the skills, and [`docs/brain-api.md`](docs/brain-api.md) for the Team Brain sync
contract.

## Status

Early and open. The clean core (structure, rules, validators, guard, harnesses),
the rubric-gated self-correction layer, the Team Brain sync client, and the local
GUI are here; more harnesses and integration adapters are on the
[roadmap](../../issues). Contributions welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
