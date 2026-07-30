# @aiosbrain/foundation

Shared hub modules of the AIOS workspace toolkit, extracted as an npm workspace package
(AIO-601, part of the multi-repo split program AIO-594). ESM only, zero runtime
dependencies, Node `>=22 <23`.

There is **no root export**. Every module is a dedicated subpath, and undeclared deep
paths do not resolve — the exports map below is the whole public surface.

## Public subpaths

| Subpath | What it is |
|---------|------------|
| `@aiosbrain/foundation/runtimes` | Canonical agent-runtime registry (`RUNTIMES`, driver caps, model catalogs, approval modes). The single source of truth for BYOA export targets and GUI-drivable runtimes. |
| `@aiosbrain/foundation/workspace-parse` | Dependency-light parsers for AIOS workspace content: frontmatter, tier normalization, item-payload validation, evidence rows, decision-table scanning + H3 admin-row redaction. Ships its own `.d.mts` typings. |
| `@aiosbrain/foundation/brain-config` | Resolves the team-brain connection (brain URL + member API key + team) from `process.env`, workspace/toolkit `.env` (incl. dotenvx-encrypted), and `aios.yaml`. |
| `@aiosbrain/foundation/linear-client` | Minimal Linear GraphQL client + helpers (`normalizeBlockedBy`, `extractRepoFileRefs`). |
| `@aiosbrain/foundation/brain-client` | HTTP/SSE client for the Team Brain member API (`createBrainClient`, SSE block parsing). |
| `@aiosbrain/foundation/git-files` | Enumerate a repo's content via git (`git ls-files`), never a filesystem walk (AIO-517). |
| `@aiosbrain/foundation/constitution` | Load the repo's engineering-constitution digest for prompt injection. |
| `@aiosbrain/foundation/tasks-table` | Markdown task/decision-table parsing + merge writeback (`parseTaskRows`, `mergeTaskWriteback`, canonical statuses). Promoted from `./internal/` in AIO-600 C3: the GUI tasks panel must round-trip tables exactly the way `aios pull` does, so the shared implementation is public rather than copied. Ships `.d.mts` typings. |
| `@aiosbrain/foundation/workspace-markers` | The one definition of "what makes a directory an AIOS workspace" (`WORKSPACE_MARKERS`). Shared by the `run-gui` launcher and the GUI server's startup check so the lists can never drift (AIO-600 C5). |
| `@aiosbrain/foundation/adapter-contract` | The GUI adapter-registry + write-guard contract checks (`checkAdapterRegistry`, `checkGuardWrite`, `GUARD_SCENARIOS`). Core-owned inversion of OGR07's former direct gui imports; run by both `validation/check-runtime-adapters.mjs` and the GUI's own `adapter-contract.test.mjs` (AIO-600 C5). |

## Private/unstable internal subpaths

The `./internal/*` subpaths exist **only** so the toolkit's back-compat shims in
`scripts/` can re-export modules that are internal to this package. They are **not**
public API: no semver guarantee, may be renamed, split, or removed in any release, and
they are deliberately excluded from the package's public-API contract test.

| Subpath | Why it exists |
|---------|---------------|
| `@aiosbrain/foundation/internal/flat-yaml` | Restricted flat-YAML reader used by `workspace-parse` and `brain-config`. |
| `@aiosbrain/foundation/internal/brain-origin` | Brain origin normalization/locking, used by `brain-client`. |
| `@aiosbrain/foundation/internal/transcript-adapters` | Fact/stakeholder wire adapters, used by `workspace-parse`. |
| `@aiosbrain/foundation/internal/skill-scan` | Pure static safety scanner for an Agent Skill directory (`scanSkill`). Consumed by the workspace GUI's skill-library install flow and by the `scripts/skill-scan.mjs` CLI shim (AIO-600). |

## Relationship to @aios-alpha/design

This package follows the precedent set by `@aios-alpha/design` / `@aios-alpha/ui`:
a published, no-auth npm package under the `@aios-alpha` scope that is the single
source of truth for a shared surface (there: design tokens; here: the toolkit's hub
modules), consumed by sibling repos rather than copy-pasted. Like the design package,
consumers pin it as an ordinary dependency; inside the toolkit repo it resolves via the
npm workspace, so the shims in `scripts/` always see the current source.

## Consumption

```js
import { RUNTIMES } from "@aiosbrain/foundation/runtimes";
import { parseFrontmatter, normalizeTier } from "@aiosbrain/foundation/workspace-parse";
```

Inside the toolkit repo, keep importing the `scripts/<hub>.mjs` shims — they re-export
from this package and preserve every historical import path.
