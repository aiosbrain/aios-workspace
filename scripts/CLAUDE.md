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
| Build/ship pipeline | `build.mjs`, `ship.mjs`, `roadmap-run.mjs`, `spec-eval.mjs`, `loop.mjs` (daily/weekly/writeback CLI) |
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

## File-size discipline

`check-file-size.mjs` enforces line caps from `scripts/size-caps.json` (currently only
`scripts/aios.mjs` → 2848 lines, explicitly grandfathered per AIO-320/AIO-315 — extraction
PRs ratchet the cap down). `ship.mjs` is comparably large (2209 lines) but is not yet in
`size-caps.json`, so it isn't enforced — don't assume it's covered by the same gate.
Prefer extracting to a new script over growing either file further.
