# GUI ↔ Toolkit Contract (AIO-594 / AIO-600)

**The GUI (`gui/server` + `gui/client`) consumes exactly two toolkit surfaces:**

1. **`@aios-alpha/monorepo` public subpaths** (`packages/monorepo`) — the frozen,
   contract-tested API (`test/monorepo-package.test.mjs`). Public subpaths only:
   `./runtimes`, `./workspace-parse`, `./brain-config`, `./linear-client`,
   `./brain-client`, `./git-files`, `./constitution`, `./tasks-table` (promoted from
   internal in C3, below). The `./internal/*` subpaths are
   documented-private and **off-limits to the GUI by default** — if the GUI needs
   something that only exists on an internal subpath, first either promote it to a
   public subpath (a semver event: update the package exports, the frozen surface in
   `test/monorepo-package.test.mjs`, and `packages/monorepo/README.md`) or move a
   minimal gui-owned implementation into `gui/server`. As a documented **last resort**
   (AIO-600 wave rule) the GUI may consume a dedicated internal subpath when neither a
   CLI seam nor an honest gui-owned copy fits (e.g. a large single-implementation
   security component); every such use must be recorded in this contract, the package
   README, and the contract test's internal list.
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

## C2 — Skill library (install/scan/uninstall)

Files: `gui/server/skill-library.mjs` (+ new `gui/server/skill-library-util.mjs`).

Package surfaces consumed:

| Surface | Named imports | Used for |
| --- | --- | --- |
| `@aios-alpha/monorepo/internal/skill-scan` (documented-private, last-resort rule above) | `scanSkill` | The advisory static safety scan behind the consent gate. Moved verbatim from `scripts/skill-scan.mjs`, which is now a relative-path re-export shim (+ its unchanged CLI), so the GUI consent gate, OGR09 (`validation/check-skill-library.mjs`), and the CLI scan identically — a 350-line security scanner must stay single-implementation (a copy could drift fail-open), and its structured findings/throws are consumed in-process, so neither a CLI spawn nor a gui copy fits. |

CLI surfaces consumed:

| Surface | Used for |
| --- | --- |
| `aios gen-catalog --repo <workspace>` (hidden registry descriptor; `scripts/gen-catalog.mjs` exports `generate()`) | Refreshing the workspace's skills/integrations catalogs after install/uninstall. Spawned via the sanctioned `AIOS_CLI` pattern (same as `gui/server/loop.mjs`); best-effort, `stdio: "ignore"` — replaces the old direct spawn of `scripts/gen-catalog.mjs`. |

Removed R4 grandfathers (5): `skill-library.mjs` → `lock-skill-library.mjs`,
`lock-marketplace.mjs`, `connector.mjs`, `gen-catalog.mjs`, `skill-scan.mjs`.

| Former deep import | Seam decision |
|---|---|
| `LIBRARY_DIR` (lock-skill-library.mjs) | **GUI-owned path.** The vendored library data physically lives at `gui/server/skill-library/`; the gui computes the path itself. The lock scripts keep their own pointer to the same dir — they are the writer side, the gui is the reader side. |
| `hashDir`, `rollupHash` (lock-skill-library.mjs) | **GUI-owned copy** in `skill-library-util.mjs` (provenance-commented, C1 flat-yaml / C4 price-table pattern). Parity is fail-closed: the committed locks are generated with the scripts-side copies and verified at install with the gui copies, so drift = hash mismatch = refused install + red `test/skill-install*.test.mjs`. |
| `gitFetchSubdir` (lock-marketplace.mjs) | **GUI-owned copy**, same file/pattern; exercised against scripts-side-built catalogs by `test/skill-install-marketplace.test.mjs` (offline `file://` fixture). |
| `copyDir`, `ensureGitignore` (connector.mjs) | **GUI-owned copies** — small, stable, generic fs helpers. |
| `frontmatter`, `readSkills` (gen-catalog.mjs) | **GUI-owned.** `frontmatter` is copied (the block-scalar-aware SKILL.md parser; `workspace-parse`'s flat parser is NOT equivalent). `readSkills` was only used for its ids → replaced by a minimal `installedSkillIds()`. |
| `scanSkill` (skill-scan.mjs) | **Package internal subpath** — see table above. |

## C3 — Tasks panel + server core (catalog / connector / brain-config)

Files: `gui/server/tasks.mjs`, `gui/server/index.mjs` (catalog + connector +
brain-config imports), new `gui/server/catalog.mjs`, new `gui/server/aios-json.mjs`.

Package surfaces consumed:

| Surface | Named imports | Used for |
| --- | --- | --- |
| `@aios-alpha/monorepo/workspace-parse` | `parseFrontmatter`, `normalizeTier` | Task-file tier resolution (`tasks.mjs`); personality frontmatter scan (`catalog.mjs`) |
| `@aios-alpha/monorepo/tasks-table` | `parseTaskRows`, `mergeTaskWriteback` (+ `TaskRow` via the exports-map `types` condition) | Tasks panel row parse + single-row writeback |

**tasks-table promotion (documented choice):** `tasks.mjs` needed
`parseTaskRows`/`mergeTaskWriteback`, which lived on the documented-private
`./internal/tasks-table` subpath — off-limits to the GUI by default under this
contract, and no last-resort case applied (promotion fits cleanly). A
gui-owned copy was rejected: the writeback grammar (row_key matching, hierarchy-column
widening, body-never-touched) is exactly what makes the cockpit round-trip a table the
way `aios pull` does, and a drifting copy would corrupt task files silently. So the
subpath was **promoted to public `./tasks-table`** as the prescribed semver event:
package `exports` map updated, surface frozen in `test/monorepo-package.test.mjs`
(9 named exports; `./internal/tasks-table` now asserted NOT to resolve), and
`packages/monorepo/README.md` moved it into the public table. The in-package relative
importers (`workspace-parse/{core,decisions}.mjs`) and the `scripts/tasks-table.*`
shims follow the file move; no historical import path broke.

CLI `--json` surfaces consumed (spawned via `gui/server/aios-json.mjs`, never imported;
both are hidden registry commands adding ZERO lines to `scripts/aios.mjs`):

| Surface | Shape | Used for |
| --- | --- | --- |
| `aios catalog --json` (`scripts/gen-catalog.mjs#cmdCatalog`) | raw `{ skills, integrations }` | `/api/catalog` (shaped client-side by `catalog.mjs#mapCatalog`); without `--json` the command runs the INDEX.md/INTEGRATIONS.md generator |
| `aios connector <action> [id] [--secrets-stdin]` (`scripts/connector-cli.mjs`) | one `{ "status": n, "body": {…} }` document | `/api/connectors*` and `/api/blueprint` routes |

The connector envelope's `status` is HTTP-shaped on purpose: 200, 422 (failed
validation / `credential_missing` / `oauth_not_connected`), 502 (OAuth relay error),
503 (no brain connection), 500 (internal) — the exact mapping the GUI routes computed
in-process before the seam, now owned by the CLI so every consumer agrees on it. Exit
code is 0 whenever a JSON result was produced (a 4xx/5xx status is a *result*); 1 only
on usage errors. **Secrets travel over stdin** (`--secrets-stdin`, JSON
`{ "secrets": { ENV: value } }`) — never argv, which is `ps`-visible.

Removed R4 grandfathers (5):

| Former deep import | Seam decision |
|---|---|
| `gui/server/tasks.mjs` → `scripts/tasks-table.mjs` | Package: `@aios-alpha/monorepo/tasks-table` (promoted public, above). |
| `gui/server/tasks.mjs` → `scripts/workspace-parse.mjs` | Package: `@aios-alpha/monorepo/workspace-parse` (public). |
| `gui/server/index.mjs` → `scripts/gen-catalog.mjs` | CLI seam `aios catalog --json`; `firstSentence` is a provenance-commented 4-line copy in `catalog.mjs`; the personalities scan (GUI-only concept) moved to `catalog.mjs` on the public `workspace-parse` parser. |
| `gui/server/index.mjs` → `scripts/connector.mjs` | CLI seam `aios connector …` (all 8 actions), spawned through `aios-json.mjs`. |
| `gui/server/index.mjs` → `scripts/brain-config.mjs` | Deleted outright — `resolveBrainConfig` was only used inside the connector routes, and the CLI seam resolves the brain config on its own side of the boundary. |

## C4 — Maturity panel + cost config

Files: `gui/server/maturity.mjs`, `gui/server/cost-config.mjs`.

Package surfaces consumed: none.

CLI `--json` surfaces consumed:

| Surface | Fields consumed | Used for |
| --- | --- | --- |
| `aios analyze --json` (report.mjs `toJson`, via the shared analysis cache) | `presentation.axis_labels`, `presentation.axis_guide`, `presentation.ergonomics_tip` (plus the pre-existing `placement`/`axes_shadow`/`attention`/`days` reads) | Maturity panel axis labels, glosses, weakest-axis coaching, and the CE tip |

Removed R4 grandfathers (3):

| Former deep import | Seam decision |
|---|---|
| `gui/server/maturity.mjs` → `scripts/analyze/guidance.mjs` (`AXIS_GUIDE`, `ergonomicsTip`) | **CLI JSON seam.** `aios analyze --json` (report.mjs `toJson`) now ships an additive `presentation` block: `{ axis_labels, axis_guide, ergonomics_tip }`. The panel reads it from the same snapshot it already parses; `maturity.mjs` now has zero imports. |
| `gui/server/maturity.mjs` → `scripts/analyze/aem.mjs` (`AXIS_LABELS`) | Same — `presentation.axis_labels` in the analyze JSON. |
| `gui/server/cost-config.mjs` → `scripts/analyze/claude-plan.mjs` (`PLAN_PRICES`) | **GUI-owned copy + parity test** (the same pattern as C1's flat-yaml decision). The plan price table is needed synchronously on the settings/ledger read path (resolving a bare `claude.plan` to its list price without spawning the CLI), so the JSON seam doesn't fit. `cost-config.mjs` carries a provenance-commented copy; `cost-config.test.mjs` deep-equals it against the CLI export, so any price drift fails tests. |

**The `presentation` block (analyze JSON, additive):**

```jsonc
{
  // ...existing toJson fields...
  "presentation": {
    "axis_labels": { "verification": "Verification", /* … per axis */ },
    "axis_guide": { "verification": { "gloss": "…", "meaning": "…", "why": "…", "steps": ["…"] }, /* … */ },
    "ergonomics_tip": "…" // precomputed from this window's attention reading; "" when none
  }
}
```

- Purely additive — no existing field moved or renamed; the frozen toJson key-set
  test (`test/analyze-render.test.mjs`) was deliberately extended.
- **Legacy snapshots degrade gracefully:** a persisted pre-seam
  `.aios/gui/analysis-snapshot.json` has no `presentation`; the panel then
  renders axis keys as labels and omits glosses/coaching/CE tip until the next
  analyze refresh. `buildMaturityPayload` never throws on its absence.
- Drift guards: `gui/server/maturity.test.mjs` "SEAM PARITY" feeds a real
  `toJson()` document through the reshaper; `gui/server/cost-config.test.mjs`
  "SEAM PARITY" pins the price-table copy. Test files may import
  `scripts/analyze/*` for expectations (R4 exempts test sources).

## C5 — (appended by cluster C5)

_Pending — cluster C5 appends its surfaces here._
