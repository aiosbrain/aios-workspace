# GUI ↔ Toolkit Contract (AIO-594 / AIO-600)

**The GUI (`gui/server` + `gui/client`) consumes exactly two toolkit surfaces:**

1. **`@aios-alpha/monorepo` public subpaths** (`packages/monorepo`) — the frozen,
   contract-tested API (`test/monorepo-package.test.mjs`). Public subpaths only:
   `./runtimes`, `./workspace-parse`, `./brain-config`, `./linear-client`,
   `./brain-client`, `./git-files`, `./constitution`. The `./internal/*` subpaths are
   documented-private shim plumbing and are **off-limits to the GUI** — if the GUI
   needs something that only exists on an internal subpath, either promote it to a
   public subpath (a semver event: update the package exports, the frozen surface in
   `test/monorepo-package.test.mjs`, and `packages/monorepo/README.md`) or move a
   minimal gui-owned implementation into `gui/server`.
2. **`aios <cmd> --json` CLI output** — the GUI shells out to the `aios` CLI and
   parses its machine-readable output. The CLI is the process boundary; the GUI never
   imports the CLI's implementation modules.

Nothing else. In particular: **zero imports of `scripts/**` from `gui/server/**`**
(boundary rule R4 in `scripts/boundaries.json`, enforced by
`npm run check:boundaries`). R4 grandfather entries are ratchet-only-down; the AIO-594
decoupling wave (clusters C1–C5, AIO-600) deletes them all. Never add a new one to
keep a GUI import alive.

This is the seam contract for the future `aios-workspace-gui` repo split (AIO-597):
when `gui/` moves to its own repo, it must build against the published package + the
installed CLI, with no filesystem reach into toolkit internals.

---

## C1 — runtime-adapters + config routes

Files: `gui/server/runtime-adapters/{index,claude-code,acp}.mjs`,
`gui/server/config-routes.mjs`, `gui/server/index.mjs` (runtimes import only).

Package surfaces consumed:

| Surface | Named imports | Used for |
| --- | --- | --- |
| `@aios-alpha/monorepo/runtimes` | `RUNTIMES`, `GUI_RUNTIMES`, `runtimeCapabilities`, `modelCatalog`, `isModelAllowed`, `modelRejectionMessage`, `allowedApprovalModeIds`, `fullAccessEnabled` | Runtime registry + capability payloads, per-runtime model catalogs and write validation, approval-mode governance |

CLI `--json` surfaces consumed: none (this cluster is registry/config only).

**flat-yaml decision (documented choice):** `runtime-adapters/index.mjs` previously
imported `parseFlatYaml` from `scripts/flat-yaml.mjs`, whose package home is the
documented-private `@aios-alpha/monorepo/internal/flat-yaml`. The GUI's only use is
reading five flat scalar keys (`agent_runtime`, `agent_model`, `agent_base_url`,
`agent_personality`, `memory_review`) from `aios.yaml` — a format subset frozen
repo-wide by OGR04. Rather than promote a generic YAML parser onto the package's
frozen public `./runtimes` surface, the GUI owns a minimal scalar-only parser:
`gui/server/runtime-adapters/flat-config.mjs` (`parseFlatScalars`). Smaller honest
surface: the package API doesn't grow, and the GUI depends on nothing private.

---

## C2 — (appended by cluster C2)

_Pending — cluster C2 appends its surfaces here._

## C3 — (appended by cluster C3)

_Pending — cluster C3 appends its surfaces here._

## C4 — (appended by cluster C4)

_Pending — cluster C4 appends its surfaces here._

## C5 — (appended by cluster C5)

_Pending — cluster C5 appends its surfaces here._
