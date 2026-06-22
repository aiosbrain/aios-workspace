# Cockpit roadmap — next workstreams

The cockpit overhaul (model picker, resumable sessions, personality, Skills library)
shipped in #16 + #17. These are the planned follow-ups, in priority order. Each has
its own plan doc; this file is the index.

| # | Workstream | Plan | Size | Depends on |
|---|---|---|---|---|
| 1 | **Onboarding enrichment** — paste a link, Firecrawl reads it, drafts the profile | [plan-onboarding-enrichment.md](./plan-onboarding-enrichment.md) | M–L | Integrations vault (shipped) |
| 2 | **Untrusted-install phase** — admit skills beyond the vendored official set, safely | [plan-skills-untrusted-install.md](./plan-skills-untrusted-install.md) | M | Skills library #17 (shipped) |
| 3 | **Docs + changelog** — document the new cockpit on the website, cut a release | [plan-cockpit-docs-release.md](./plan-cockpit-docs-release.md) | S | features shipped (done) |
| 4 | **Team Brain MCP connector** — bridge Claude Desktop/Cowork/Codex to the brain; P0 (read-only `aios mcp` + tests) landed, P1 `.mcpb` packaging next | [prd-team-brain-mcp-connector.md](./prd-team-brain-mcp-connector.md) | M | brain-api v1 (shipped) |
| 5 | **GUI → harness-state window** — re-aim the GUI from chat client to read-only harness visibility + CLI trainer | [prd…§12](./prd-team-brain-mcp-connector.md#12-gui-repositioning-companion-track-not-blocking) + (plan doc TBD) | M–L | none (independent) |

Sequencing: (1) is the highest-value user-facing feature and is independent; (3) can
run anytime (release hygiene); (2) is only needed once we want non-official skills.
(4) is the wide on-ramp — read-only server already in tree; P1 packaging unblocks
non-technical Claude Desktop users. (5) follows from the access-surface doctrine
(public summary: [`architecture.md` § Access surfaces](./architecture.md#access-surfaces--how-callers-reach-the-brain);
fuller maintainer-only brief in `strategy/`, removed at public release) and is independent of (4).
