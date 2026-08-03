# scripts/ — the toolkit's operational surface

Flat directory of ~90 Node-ESM CLIs + a few bash scripts. This IS the product's
command layer: `aios.mjs` is the dispatch entry every `aios <cmd>` call resolves to
(directly here, or via a scaffolded workspace's delegating shim
`scaffold/scripts/aios.mjs`, which forwards to this checkout so command code never
needs vendoring). No shared build step — each script is a standalone entry point.

## Groupings

| Group | Members |
|-------|---------|
| Scaffolding | `scaffold-project.sh` (stamp a workspace), `scaffold-engagement.sh` |
| Sync CLI | `aios.mjs` (dispatch entry) |
| Toolkit self-update | `toolkit-manifest.mjs` (4 buckets), `toolkit-merge.mjs` (3-way merge), `toolkit-contribute.mjs` (upstream a local fix via a throwaway worktree), `toolkit-meta.mjs` (semver + brain-api version stamping) |
| Inbox ops | `inbox.mjs`, `inbox-coordinator.mjs`, `inbox-host-verify.mjs`, `inbox-host-restore-drill.mjs`, `inbox-redaction-lint.mjs` |
| Build/ship pipeline | **Not here — `aiosbrain/aios-devtools`** (AIO-662). `ship`, `build`, `roadmap-run`, `spec-eval`, `spec-publish`, `consolidate-findings` left this repo; core dispatches to them through `devtools-dispatch.mjs`. `loop.mjs` (daily/weekly/writeback CLI) stays. |
| `analyze/` subdir | usage/cost/ergonomics tooling: `aem.mjs`, `cost-report.mjs`, `ergonomics.mjs`, `ergonomics-calibrate.mjs`, `cursor-api.mjs`, `metrics.mjs`, `guidance.mjs` |
| Guards | `leak-gate.sh` (secret-leak gate), `check-domain-isolation.mjs`, `check-file-size.mjs` |

## Invariants

- **Manifest ↔ scaffold parity.** `toolkit-manifest.mjs`'s four buckets (MANAGED /
  SEED_IF_ABSENT / PERSONAL / SCAFFOLD_UNMANAGED) must classify every path
  `scaffold-project.sh` stamps. `test/toolkit-manifest-parity.test.mjs` fails the build
  if a new stamped path isn't classified — the "kept in lockstep by hand" footgun this
  test exists to catch.
- **Registering a new script may need catalog gen too.** `gen-catalog.mjs` regenerates
  the skills/integrations catalog (`.claude/skills/INDEX.md`, `.claude/INTEGRATIONS.md`);
  `export-commands.mjs` mirrors `.claude/commands/*.md` into `.opencode/command/` for
  OpenCode. Check both, and the manifest, when a script changes what gets stamped or surfaced.
- **Reuse the shared helpers, don't reimplement:** `flat-yaml.mjs` (flat YAML config),
  `workspace-parse.mjs` (frontmatter parsing), `linear-client.mjs` (Linear GraphQL),
  `brain-config.mjs` (env/brain config loading). All four are imported across many
  scripts (e.g. `aios.mjs`, `ship.mjs`, `roadmap-run.mjs`, `promote.mjs`, `task-tier.mjs`).
  Since AIO-601 these (plus `runtimes`, `brain-client`, `git-files`, `constitution`,
  `brain-origin`, `tasks-table`, `transcript-adapters`) are one-line shims re-exporting
  `@aiosbrain/foundation` (`packages/foundation/` — an npm workspace, **published to npm
  as public `@aiosbrain/foundation@0.1.0`**; public hub subpaths: `runtimes`,
  `workspace-parse`, `brain-config`, `linear-client`, `brain-client`, `git-files`,
  `constitution`, plus contract/`internal/*` subpaths — see the package `exports`); edit
  the module bodies there, keep importing the `scripts/` paths from toolkit code. The
  standalone GUI repo consumes the published package, never these shims
  (`docs/gui-toolkit-contract.md`).

## File-size discipline

`check-file-size.mjs` enforces line caps from `scripts/size-caps.json` — most notably
`scripts/aios.mjs` (explicitly grandfathered per AIO-320/AIO-315). Caps ratchet down: per
AIO-315 the numbers only ever go down, and an extraction PR lowers the recorded cap to match.
Prefer extracting to a new script over growing a capped file further — that is why
`scripts/cli/devtools-commands.mjs` exists (AIO-661 split it out of `cli/registry.mjs`, which
was at exactly its 500-line cap).

`scripts/ship.mjs`'s cap is gone with the file itself (AIO-662); the devtools repo owns that
discipline now.
