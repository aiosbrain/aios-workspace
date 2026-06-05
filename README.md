# Agentic Team Ops

An open, agent-native operating system for consulting and transformation teams.

Agentic Team Ops gives an engagement a **clean folder structure**, a set of
**governance conventions**, **validators** that keep a repo honest, and a growing
library of **dynamic multi-agent workflow harnesses** that do real operational work —
auditing a decision log, catching scope creep, turning meeting transcripts into
decisions — with adversarial verification so their output is trustworthy.

It is designed to be **forked per client**: scaffold a new team-ops repo, fill in the
numbered spine as the engagement runs, and point the harnesses at it.

```
agentic-team-ops/
├── scaffold/        the team-ops repo template (structure + rules + skills)
│   └── .claude/
│       ├── rules/   decision-log · frontmatter · publishing · hours
│       └── skills/  dynamic-workflow harnesses (decision-audit, scope-creep, transcript-decisions)
├── validation/      OGR validators (structure · frontmatter · secrets)
├── hooks/           Claude Code PreToolUse guard (secrets · access · frontmatter)
├── scripts/         scaffold-engagement.sh · leak-gate.sh
├── examples/        a fully synthetic sample engagement to demo + test the harnesses
└── docs/            architecture · feature-set · workflows
```

## Quickstart

Spawn a new engagement repo:

```bash
scripts/scaffold-engagement.sh \
  --slug acme-team-ops --client "Acme Corp" \
  --captain alex --members "alex,sam,jordan" \
  --org your-github-org --currency USD \
  --output ~/Projects/acme-team-ops
```

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

## The numbered spine

Every engagement uses the same six-folder pipeline, raw → refined:

| # | Folder | Holds | Audience |
|---|--------|-------|----------|
| 00 | engagement | charter, scope baseline + ledger, roles | team |
| 01 | intake | raw inputs (transcripts, notes) | admin |
| 02 | deliverables | sprint-scoped team outputs | team |
| 03 | status | decision log, hours, tasks | admin |
| 04 | client-surface | captain-approved, client-facing | client |
| 05 | personal | per-member private workspace | individual |

See [`docs/architecture.md`](docs/architecture.md) for the hub-and-spoke model and
access tiers, [`docs/feature-set.md`](docs/feature-set.md) for the full feature set,
and [`docs/workflows.md`](docs/workflows.md) for the harness design study that shaped
the skills.

## Status

Early and open. The clean core (structure, rules, validators, guard, and three
harnesses) is here; the integrations layer (sync pipeline, knowledge base, scheduling)
and more harnesses are on the [roadmap](../../issues). Contributions welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
