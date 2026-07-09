# AIOS Workspace — agent guide

The operating manual for this repo lives in **[CLAUDE.md](CLAUDE.md)** — read it first.
It covers what the toolkit is, the repo map, the workspace spine + access-tier safety
boundary, the pinned `docs/brain-api.md` sync contract, and the do-not list.

## Cross-project memory

When you need to look up a person, organization, or contact (e.g., "who is Stephan
Ledain?"), resolve against the single entity registry: `../john-workspace/entities/`.
Entity files are `access: private` and never sync — they exist only at that location.
For other cross-project memory routing, consult `.tessera/memory/router.yaml` at the
Tessera root.
