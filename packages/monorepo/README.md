# @aios-alpha/monorepo

Shared hub modules of the AIOS workspace toolkit, extracted as an npm workspace package
(AIO-601, part of the multi-repo split program AIO-594). ESM only, zero runtime
dependencies, Node `>=22 <23`.

There is **no root export**. Every module is a dedicated subpath, and undeclared deep
paths do not resolve — the exports map below is the whole public surface.

## Public subpaths

| Subpath | What it is |
|---------|------------|
| `@aios-alpha/monorepo/runtimes` | Canonical agent-runtime registry (`RUNTIMES`, driver caps, model catalogs, approval modes). The single source of truth for BYOA export targets and GUI-drivable runtimes. |
| `@aios-alpha/monorepo/workspace-parse` | Dependency-light parsers for AIOS workspace content: frontmatter, tier normalization, item-payload validation, evidence rows, decision-table scanning + H3 admin-row redaction. Ships its own `.d.mts` typings. |
| `@aios-alpha/monorepo/brain-config` | Resolves the team-brain connection (brain URL + member API key + team) from `process.env`, workspace/toolkit `.env` (incl. dotenvx-encrypted), and `aios.yaml`. |
| `@aios-alpha/monorepo/linear-client` | Minimal Linear GraphQL client + helpers (`normalizeBlockedBy`, `extractRepoFileRefs`). |
| `@aios-alpha/monorepo/brain-client` | HTTP/SSE client for the Team Brain member API (`createBrainClient`, SSE block parsing). |
| `@aios-alpha/monorepo/git-files` | Enumerate a repo's content via git (`git ls-files`), never a filesystem walk (AIO-517). |
| `@aios-alpha/monorepo/constitution` | Load the repo's engineering-constitution digest for prompt injection. |

## Private/unstable internal subpaths

The `./internal/*` subpaths exist **only** so the toolkit's back-compat shims in
`scripts/` can re-export modules that are internal to this package. They are **not**
public API: no semver guarantee, may be renamed, split, or removed in any release, and
they are deliberately excluded from the package's public-API contract test.

| Subpath | Why it exists |
|---------|---------------|
| `@aios-alpha/monorepo/internal/flat-yaml` | Restricted flat-YAML reader used by `workspace-parse` and `brain-config`. |
| `@aios-alpha/monorepo/internal/brain-origin` | Brain origin normalization/locking, used by `brain-client`. |
| `@aios-alpha/monorepo/internal/tasks-table` | Task-table parsing/writeback, used by `workspace-parse`. |
| `@aios-alpha/monorepo/internal/transcript-adapters` | Fact/stakeholder wire adapters, used by `workspace-parse`. |
| `@aios-alpha/monorepo/internal/skill-scan` | Pure static safety scanner for an Agent Skill directory (`scanSkill`). Consumed by the workspace GUI's skill-library install flow and by the `scripts/skill-scan.mjs` CLI shim (AIO-600). |

## Relationship to @aios-alpha/design

This package follows the precedent set by `@aios-alpha/design` / `@aios-alpha/ui`:
a published, no-auth npm package under the `@aios-alpha` scope that is the single
source of truth for a shared surface (there: design tokens; here: the toolkit's hub
modules), consumed by sibling repos rather than copy-pasted. Like the design package,
consumers pin it as an ordinary dependency; inside the toolkit repo it resolves via the
npm workspace, so the shims in `scripts/` always see the current source.

## Consumption

```js
import { RUNTIMES } from "@aios-alpha/monorepo/runtimes";
import { parseFrontmatter, normalizeTier } from "@aios-alpha/monorepo/workspace-parse";
```

Inside the toolkit repo, keep importing the `scripts/<hub>.mjs` shims — they re-export
from this package and preserve every historical import path.
