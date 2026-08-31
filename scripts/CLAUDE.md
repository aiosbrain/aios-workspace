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
| Built-in adapters | `connectors.mjs` (lazy barrel — the ONLY import route into `connectors/`) + `connectors/linear/` (the one Linear implementation behind `aios linear`, AIO-1067); `linear.mjs` is the warning-only compat delegate |
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
- **Withdrawing a managed file takes TWO edits.** Deleting an entry from `MANAGED_PATHS`
  only stops the re-seed — `mergeManaged` visits the entry lists it is handed and nothing
  else, so the copy a workspace already vendored survives every future `aios update`,
  permanently unmanaged. Add the entry to **`RETIRED_PATHS`** (same `dest`, its historical
  `src`) as well; that is the pass that removes it, on the same `mine === base` safety rule
  applyDeletions uses. Order retirements so a fail-closed config is deleted BEFORE the
  scripts it dispatches to.
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
- **A shim may carry toolkit-only code — and that is the ONLY thing it may carry.** The
  default is unchanged: shared behaviour goes in `packages/foundation/src/`, and a shim stays
  a one-line re-export. But `packages/foundation` has a **frozen exported surface**
  (`test/foundation-package.test.mjs` pins it by name and calls a change to that table a semver
  event), and the bump is not free: `@aiosbrain/aios-devtools` pins
  `@aiosbrain/foundation@^0.1.0`, so a minor drops devtools onto a second, registry-fetched copy
  of foundation until that **separate repo** is bumped and republished too. So the test is not
  "is this file a shim" but **who can call it**:
  - Something a consumer of the PUBLISHED package could need — the GUI server, any downstream
    install — goes in `packages/foundation/src/`, and you pay for the minor + the devtools bump.
  - Something only the `aios` CLI in this repo renders or reads may live **below the
    `export *` line in the shim**, under a comment saying why it is not shared. It is then
    unreachable from the published package by construction, which is the point.

  Two obligations come with the second case, and skipping either is how this decays into
  "logic drifted into the shim":
  1. **Say so in the file.** A block comment under the `export *` naming the reason, so the
     next reader does not have to reconstruct it.
  2. **Do not overclaim in docblocks.** "every caller that resolves a brain config" is FALSE
     for anything in a shim — the GUI repo consumes `@aiosbrain/foundation` and never sees it.
     Scope the sentence to the toolkit's own callers.

  Live instance: the brain-URL mismatch helpers in `brain-config.mjs`
  (`normalizeBrainUrl` / `detectBrainUrlMismatch` / `brainUrlMismatchWarning` /
  `warnBrainUrlMismatch`). If the GUI ever needs them, that is the moment to move them.

## File-size discipline

`check-file-size.mjs` enforces line caps from `scripts/size-caps.json` — most notably
`scripts/aios.mjs` (explicitly grandfathered per AIO-320/AIO-315). Caps ratchet down: per
AIO-315 the numbers only ever go down, and an extraction PR lowers the recorded cap to match.
Prefer extracting to a new script over growing a capped file further — that is why
`scripts/cli/devtools-commands.mjs` exists (AIO-661 split it out of `cli/registry.mjs`, which
was at exactly its 500-line cap).

`scripts/ship.mjs`'s cap is gone with the file itself (AIO-662); the devtools repo owns that
discipline now.
