# Cockpit roadmap — next workstreams

The cockpit overhaul (model picker, resumable sessions, personality, Skills library)
shipped in #16 + #17. These are the planned follow-ups, in priority order. Each has
its own plan doc; this file is the index.

| # | Workstream | Plan | Size | Depends on |
|---|---|---|---|---|
| 1 | **Onboarding enrichment** — paste a link, Firecrawl reads it, drafts the profile | [plan-onboarding-enrichment.md](./plan-onboarding-enrichment.md) | M–L | Integrations vault (shipped) |
| 2 | **Untrusted-install phase** — admit skills beyond the vendored official set, safely | [plan-skills-untrusted-install.md](./plan-skills-untrusted-install.md) | M | Skills library #17 (shipped) |
| 3 | **Docs + changelog** — document the new cockpit on the website, cut a release | [plan-cockpit-docs-release.md](./plan-cockpit-docs-release.md) | S | features shipped (done) |

Sequencing: (1) is the highest-value user-facing feature and is independent; (3) can
run anytime (release hygiene); (2) is only needed once we want non-official skills.
