# GUI repo cut — runbook (AIO-594 / AIO-603)

Rehearsed end-to-end on 2026-07-30 against frozen SHA
`0ae23a7fadf6ce36ac9ee54247bf4c7af2b07f98` (origin/main with all of AIO-600 C1–C5
merged). Every step below was executed in throwaway directories; the numbers quoted are
the rehearsal's measured results. Seam contract: `docs/gui-toolkit-contract.md`.

> **Package rename note.** The shared package was renamed
> **`@aios-alpha/monorepo` → `@aiosbrain/foundation`** (directory
> `packages/monorepo` → `packages/foundation`), merged to main in #502. This runbook
> names the package **`@aiosbrain/foundation`** throughout; the rehearsal itself ran
> **pre-rename at `0ae23a7`**, where the same package was `@aios-alpha/monorepo` in
> `packages/monorepo` — the mechanics are identical. **The REAL cut freezes a
> post-rename SHA and re-runs the parity + tarball/publish steps of this runbook
> against it.**

## 0. Inputs

- **Frozen SHA** — pin it first: `git rev-parse origin/main` after a freeze announcement;
  all steps reference that exact commit. The real cut's frozen SHA must be
  **post-rename** (`@aiosbrain/foundation` / `packages/foundation` on main).
- **Paths manifest** — `scripts/gui-cut-paths.txt` (this repo). Sanity-check every line:
  `grep -v '^#' scripts/gui-cut-paths.txt | while read -r p; do git log --oneline -1 <sha> -- "$p" | grep -q . || echo "MISSING: $p"; done`
- **Package source** — the REHEARSAL installed the shared package from a tarball
  (`npm pack` in the package directory of a fresh clone at the frozen SHA; pre-rename
  that was `packages/monorepo`, post-rename `packages/foundation`). **The real cut
  swaps the tarball for the published npm package** (G1 criterion): publish
  `@aiosbrain/foundation` first, then the gui repo depends on it normally and the
  `vendor/` tarball step disappears.

## 1. Mirror + filter

```bash
git clone --no-local <primary-checkout> mirror     # fresh clone, HEAD == frozen SHA on main
git -C mirror remote remove origin                  # cut repo starts with no remote
git -C mirror for-each-ref --format='%(refname)' \
  | grep -v '^refs/heads/main$' \
  | while read -r r; do git -C mirror update-ref -d "$r"; done
cd mirror && git filter-repo --force --paths-from-file gui-cut-paths.txt
```

`--force` is needed only because the origin remote was stripped first (filter-repo's
fresh-clone heuristic); never run filter-repo against a working checkout. Rehearsal
result: 642 commits → **145 commits, 312 files**, 0.33 s.

## 2. Parity (all three must hold)

1. **File set**: `git -C mirror ls-files | sort` must equal
   `git ls-tree -r --name-only <sha> -- <manifest paths> | sort` (set-diff empty both
   directions; rehearsal: 312 == 312, empty).
2. **Content**: `git archive <sha> <manifest paths> | tar -x -C baseline/` then
   `diff -r --exclude=.git baseline mirror` — empty.
3. **History depth**: `git log --oneline -- <file> | wc -l` > 1 for at least one file per
   moved area. Rehearsal: `gui/server/index.mjs` 52, `gui/client/src/App.tsx` 2,
   `src-tauri/src/main.rs` 5, `test/skill-install.test.mjs` 2, `test/ux/run-ux.mjs` 6.

## 3. Secrets scan of the filtered HISTORY

Scan **every blob** (not just the tip) with `validation/secret-patterns.txt`, plus the
local NDA term set, plus a forbidden-path assertion:

```bash
git rev-list --objects --all                    # no .env / .npmrc / node_modules / dist blobs
git cat-file --batch-all-objects --batch-check  # enumerate blobs; grep each against every pattern
```

Rehearsal: 1852 objects / 868 unique blobs — forbidden paths **clean**, NDA terms
**clean**, secret patterns **clean except one documented false positive**: a
Slack-token-shaped documentation placeholder (`xox<c>-new-...`, with `<c>` a real
token-type letter in the source — spelled out literally there, masked here so this
runbook doesn't trip the same scanner) in 4 vendored
`gui/server/skill-library/claude-api/*/managed-agents/README.md` docs, identical to
what is already on main. Report counts/paths only — never matched content.

## 4. Bootstrap the standalone repo

1. Root `package.json`: npm workspaces `[gui/client, gui/server]`; scripts
   `test:server` (`node --test gui/server/`), `test:client` (workspace vitest),
   `build:client`, minimal `lint` (`node --check` until an eslint config is chosen).
2. Apply the two **contract-prescribed** import rewrites (both files carry a comment
   naming their post-cut specifier; use the post-rename package name):
   - `gui/server/index.mjs` → `@aiosbrain/foundation/workspace-markers`
   - `gui/server/runtime-adapters/adapter-contract.test.mjs` →
     `@aiosbrain/foundation/{adapter-contract,runtimes}`
   (rehearsed pre-rename as `@aios-alpha/monorepo/...` at `0ae23a7`)
3. `node <frozen-core>/scripts/aios.mjs repo-bootstrap <gui-repo> --lint-script lint
   --test-script test` — run from a **frozen-SHA toolkit clone**, not the live primary.
   Stamps the primary-commit guard, worktree hydration, size/boundary/leak gates, CI
   skeleton, `.aios-bootstrap-version`.
4. **Carry the moved files' grandfather entries** from core's `scripts/size-caps.json`
   into the seeded one (the seed is deliberately empty; 9 moved files are over the
   500-line cap — the rehearsal confirmed core's recorded caps match their current line
   counts exactly).
5. `npm install` — see F2 below (peer-dep conflict); resolve it properly at cut, don't
   ship `--legacy-peer-deps`.

## 5. Verify

Rehearsal results at the frozen SHA:

- **Client**: build green (vite); **161/161** tests green.
- **Server (no toolkit)**: 195/229 — every failure is a server-boot/guard test failing
  with the toolkit-locate contract's actionable error, as designed.
- **Server (with `AIOS_TOOLKIT_DIR=<toolkit>`)**: **221/229**; the 8 remaining failures
  are the known cut-adaptation items (below), not regressions.
- **Stamped gates**: `check:boundaries` clean (0 grandfathered couplings), `leak-gate`
  clean, `check-file-size` clean after step 4.4.
- **Primary-commit guard**: authored commit in the new repo's primary checkout BLOCKED
  (exit 1); `ALLOW_PRIMARY_COMMIT=1` override works; worktree commits no-op.
- **Worktree hydration**: `git worktree add` fires the stamped `post-checkout` →
  `link-worktree-env.sh` writes `.aios/.worktree-hydrated`.
- **Two-direction smoke**:
  - (a) monorepo authoritative: from the frozen toolkit checkout,
    `npm run gui -- --repo <workspace>` boots the in-tree gui; `/api/info` reports
    `toolkit.source: AIOS_TOOLKIT_DIR` and `capabilities.operatorLoop: available`.
  - (b) cut repo against an installed toolkit: from the gui repo,
    `AIOS_TOOLKIT_DIR=<toolkit> node gui/server/index.mjs --repo <workspace>` boots;
    `/api/info` verified; CLI seam verified live via `/api/catalog` (spawned `aios`
    CLI: 17 skills / 9 integrations).

## 6. Known cut-time adaptations (rehearsal findings)

| ID | What | Fix at cut |
|----|------|-----------|
| F2 | `npm install` ERESOLVE: gui/client `vite ^8.1.5` vs `@vitejs/plugin-react ^4.3.0` (peers vite ^4–7). The monorepo lock masks it (root hoists vite 6.4.3 for other consumers). | Bump plugin-react to a vite-8-compatible major (or pin vite), commit a clean lockfile. |
| F3 | `gui/server/loop.test.mjs:19` hard-codes `AIOS_CLI = ../../scripts/aios.mjs` (2 asks tests fail standalone). | Resolve the CLI via `toolkit-locate.mjs`. |
| F4 | `gui/server/approval-mode-governance.test.mjs:22` hard-codes `<root>/hooks/team-ops-guard.sh` (5 tests fail standalone). | Locate the guard via the toolkit; skip-when-absent like the adapter-contract test. |
| F5 | `gui/server/toolkit-locate.test.mjs` resolution-order test uses the repo root as a valid toolkit (pre-cut layout). | Synthetic toolkit fixture. |
| F7 | `maturity.test.mjs` + `cost-config.test.mjs` SEAM PARITY import core `scripts/analyze/*`; `inbox-capability.test.mjs` imports `../../../dist/operator-loop`. | Toolkit-checkout prerequisite for the parity pair; `@aios-alpha/operator-loop` publish (or toolkit-dist fallback) for the capability suite. |
| F8 | `test/skill-install-marketplace.test.mjs` (`scripts/lock-marketplace.mjs`) and `test/ux/run-ux.mjs` (`scripts/connector.mjs`) import core modules. | Toolkit-checkout test prerequisite, as the contract already flags for the UX harness. |

## 7. Deferred — DONE (AIO-612 landed)

The deletion PR has merged. `gui/` and `src-tauri/` are gone from core; the GUI repo is
the only copy. What was listed here as deferred:

- **Tauri bundle story** — `src-tauri` moved as-is; repointing the desktop shell is
  **AIO-581 in the GUI repo** (contract §src-tauri). Still open, still owned there.
- **Nightly `inbox-authorization` mutation floor** — DONE, by removal rather than
  re-calibration. Its calibrated oracle WAS the gui-owned capability suite, so with that
  suite in the other repo the group's `nightlyTests` override is gone and both lanes run
  the operator-loop umbrella. `breakThresholdByTarget` still pins the 90% floor for the
  compiled target; if the nightly cost becomes a problem, re-measure a replacement floor
  per AIO-539's rules rather than reinstating a cross-repo path.
- **Core CI lane removals** — DONE. `client-tests`, `rust-tests` and `install-smoke` are
  deleted along with their `test-gate.needs` entries (12 lanes → 9), and the
  `runtime-capabilities` + `client-auth-permissions` mutation legs are gone from
  `mutation.yml`. `test/skill-scan-fixtures/` was RETAINED, as specified.

## 8. Rollback

AIO-612 has merged, so the pre-deletion rollback (delete the new repo and stop) no
longer applies. Rollback is now **`git revert -m 1 <merge-sha>`** on the deletion PR: it
landed as a single squash commit precisely so the trees, the lockfile, the workflows and
the config all come back atomically. The moved files' history is still fully present in
core's git history at the frozen SHA, so a single file can be recovered with
`git checkout cut/gui-freeze -- <path>` (tag `cut/gui-freeze` = `d6dcdeb`).
