# GUI ↔ Toolkit Contract (AIO-594 / AIO-600)

**The GUI (`gui/server` + `gui/client`) consumes exactly two toolkit surfaces:**

1. **`@aios-alpha/monorepo` public subpaths** (`packages/monorepo`) — the frozen,
   contract-tested API (`test/monorepo-package.test.mjs`). Public subpaths only:
   `./runtimes`, `./workspace-parse`, `./brain-config`, `./linear-client`,
   `./brain-client`, `./git-files`, `./constitution`. The `./internal/*` subpaths are
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

## C3 — (appended by cluster C3)

_Pending — cluster C3 appends its surfaces here._

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
