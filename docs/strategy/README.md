# docs/strategy — INTERNAL (reviewer-only)

> ⚠️ **Not part of the public release.** This folder holds studio strategy and
> competitive research shared with named reviewers only. It carries the studio brand
> and commercial positioning, and **must be removed before this repository is made
> public** (see `../../RELEASE-CHECKLIST.md`). It is exempt from the public-surface
> leak gate but has been verified free of client identifiers.

Contents:
- `agent-flywheel-oss-strategy.md` — the open-source ecosystem strategy brief (the
  three-pillar "Agent Flywheel": Company Graph → Learning Journeys → Team Agentic OS).
- `competitive-landscape-oss.md` — competitive analysis across open-source projects.
- `competitive-landscape-graph.yaml` — the structured competitive dataset behind it.
- `team-brain-access-strategy.md` — the access-surface doctrine (CLI-primary / MCP-bridge /
  GUI-as-harness-window) and the Layer 1 (Harness) vs Layer 2 (Brain) decoupling. Drives
  `../prd-team-brain-mcp-connector.md`.

> **Release-link hazard.** Several *public* docs (`../architecture.md`,
> `../prd-team-brain-mcp-connector.md`, `../roadmap.md`, `../integrations.md`) link to
> `team-brain-access-strategy.md`. When this folder is removed at public cut, those become dead
> links. Before release, either point them at the public substitute
> (`../architecture.md` § "Access surfaces") or strip the link. The public docs already carry a
> maintainer-only callout beside each such link to make this a find-and-fix, not a surprise.
> Tracked in `../../RELEASE-CHECKLIST.md`.
