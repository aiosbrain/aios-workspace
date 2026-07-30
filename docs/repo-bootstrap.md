# `aios repo-bootstrap` — governance stamp for split repos

**AIO-602 (multi-repo split epic AIO-594).** The ONE authoritative path for stamping the
AIOS governance surface into a repo split out of `aios-workspace` (aios-workspace-gui,
aios-devtools). A bootstrapped repo guards itself — worktree discipline, size/boundary/leak
gates, worktree hydration, CI — **with no adjacent core checkout**.

```bash
aios repo-bootstrap <target-repo-path> \
  [--check] [--force] [--json] \
  [--lint-script <name>] [--test-script <name>]   # npm scripts the CI skeleton expects
```

The target must be the **root of a git repository** (git hooks are installed into its
`.git`). Code lives in `scripts/repo-bootstrap.mjs` (CLI barrel) +
`scripts/repo-bootstrap/{manifest,engine}.mjs` + `scripts/repo-bootstrap/assets/`.

## Buckets (deliberately mirroring `aios update`)

- **MANAGED** — re-synced on every run with 3-way drift detection (below). The canonical
  copy lives in this toolkit; local edits are surfaced, never silently clobbered, and
  should be upstreamed here.
- **SEED_IF_ABSENT** — created once, then owned by the target repo. Never read, merged,
  overwritten, or deleted after creation — **including with `--force`**.

This is a **separate, small manifest** (`scripts/repo-bootstrap/manifest.mjs`), not an
extension of `scripts/toolkit-manifest.mjs`: that one defines the IC-workspace surface
for `aios update`; this one defines the split-product-repo surface. Same semantics,
different file sets, independent evolution.

## What gets stamped — classification of every file

| Stamped path (target-relative) | Bucket | Class | Source / notes |
| --- | --- | --- | --- |
| `.harness/hooks/git/pre-commit-primary-guard` | MANAGED | **copied + adapted** | From `.harness/hooks/git/…`; the `strict-commit-policy` transform flips the policy default `default-ok → strict` (fail-closed: the stamp ABORTS if the anchor line is missing). Blocks every authored commit in the primary checkout, any branch. Override: `AIOS_ALLOW_PRIMARY_COMMIT=1`. |
| `.harness/hooks/git/reference-transaction-strand-guard` | MANAGED | copied | Parse-free backstop: blocks `checkout -b` / `switch -c` stranding the primary on a feature branch; explicitly allows `git worktree add -b`. |
| `.harness/hooks/git/install-primary-commit-guard.sh` | MANAGED | copied | Self-locating installer (installs from its own directory → the target's OWN `.harness` copy). Wires `pre-commit`, `pre-merge-commit`, `reference-transaction`; chains pre-existing hooks. |
| `.harness/hooks/guard-worktree.sh` | MANAGED | copied | Agent-hook policy: blocks primary-checkout **edits** and branch/commit **commands** at tool-use time (strict via `run-strict-guard.sh`). |
| `.harness/hooks/prepare-event.sh`, `validate-event.sh`, `validate-action.sh`, `trace-event.sh` | MANAGED | copied | The guard's protocol closure (payload normalization/validation). |
| `.harness/adapters/run-hook.sh`, `.harness/adapters/claude-code/normalize.sh`, `.harness/adapters/claude-code/run-strict-guard.sh` | MANAGED | copied | Runtime adapter: Claude Code payload → portable event; `run-strict-guard.sh` exports the strict edit+commit policies. |
| `scripts/check-file-size.mjs` | MANAGED | copied | Byte-identical copy of the canonical default-deny size gate. Reads the target-owned `scripts/size-caps.json`. |
| `scripts/check-boundaries.mjs` | MANAGED | copied | Byte-identical copy of the seam gate. Reads the target-owned co-located `scripts/boundaries.json`. |
| `scripts/git-files.mjs` | MANAGED | copied | Shared git-enumeration helper both gates import. |
| `validation/agent-readiness-lib.mjs` | MANAGED | copied | Copied whole so `check-file-size.mjs` needs no import rewriting (it imports `globToRegex` from here). |
| `scripts/leak-gate.sh` | MANAGED | copied | Confidentiality gate; baseline shape rules always on, term set via `AIOS_LEAK_TERMS_B64` / `~/.config/aios-nda/`. |
| `hooks/git/pre-push-leak-gate` | MANAGED | copied | Push-is-publication gate; self-locates `scripts/leak-gate.sh` in the target. |
| `scripts/install-leak-gate-push-hook.sh` | MANAGED | copied | Installs/chains the pre-push hook. |
| `scripts/link-worktree-env.sh` | MANAGED | **generated** (toolkit asset) | Generic hydrator: symlinks `node_modules`/`.env*`/`.envrc` from the primary, copies `.claude/settings.json` when absent, writes the `.aios/.worktree-hydrated` marker. References only the target's own tree. |
| `.harness/hooks/git/post-checkout` | MANAGED | **generated** (toolkit asset) | Auto-hydrates a fresh worktree by running the target's own `scripts/link-worktree-env.sh`. Never blocks a checkout. |
| `ENGINEERING-CONSTITUTION.md` | SEED | **generated + referenced** | Points at the canonical core doc (`aios-workspace/docs/ENGINEERING-CONSTITUTION.md`) and seeds the **§8 invariant registry** (INV-SIZE / INV-BOUNDARY / INV-LEAK / INV-WORKTREE) wired to the stamped scripts. Independently owned after seeding. |
| `scripts/size-caps.json` | SEED | generated → **independently-owned** | Fresh default-deny config: cap 500, **empty grandfather**. The target owns its ratchet from day one. |
| `scripts/boundaries.json` | SEED | generated → **independently-owned** | Starter R1–R5 seam rules, empty grandfather. |
| `.github/workflows/ci.yml` | SEED | generated (parameterized) → **independently-owned** | Three jobs: governance gates (size + boundaries + leak), lint, tests. `--lint-script`/`--test-script` fill the npm script names (`--if-present`, tolerant of a repo with no `package.json` yet). |
| `.claude/settings.json` | SEED | generated → **independently-owned** | PreToolUse wiring of the strict worktree guard (Write/Edit + Bash) to the target's own `.harness` copy. |
| `.gitignore` | SEED | generated → **independently-owned** | `node_modules/`, `.aios/`, env files, `*.aios-incoming`. |
| `.aios-bootstrap-version` | state | **generated every run** | Bootstrap semver + source toolkit sha/semver + `stampedAt` + per-file sha256 of every MANAGED stamp (the 3-way base). |
| `.git/hooks/{pre-commit,pre-merge-commit,reference-transaction,pre-push,post-checkout}` | install action | installed | Installed **from the target's own stamped copies**; pre-existing foreign hooks are chained (`<hook>.chained`), a foreign `post-checkout` is preserved untouched. |

Class legend — **copied**: byte-identical to the canonical toolkit file; **copied +
adapted**: copied through a named fail-closed transform; **generated**: produced from a
template under `scripts/repo-bootstrap/assets/` (parameter substitution where noted);
**referenced**: content that points at, rather than duplicates, the canonical core doc;
**independently-owned**: the target repo owns and evolves it after the first stamp.

## Re-run + drift story

Every run recomputes a 3-way decision per MANAGED file, reusing the toolkit's decision
table (`decideMerge` from `scripts/toolkit-merge.mjs`) over **content hashes**:

- **base** = sha256 recorded in `.aios-bootstrap-version` at the last stamp
- **mine** = the target's current file — **theirs** = the toolkit's new source

| Situation | Decision | Behavior |
| --- | --- | --- |
| identical everywhere | noop | nothing (exec bit re-asserted) |
| file missing in target | create | write |
| target untouched, source moved | take-theirs | update, re-record hash |
| **local edit**, source unchanged | keep-mine | keep the local file, keep the OLD base (a later source change still 3-ways correctly), report as drift |
| **local edit + source changed** (or no recorded base) | merge / fallback | keep the local file, write the new source to `<file>.aios-incoming` — surface, never guess |

- `--check` — report-only: no writes, no hooks, no version stamp; **exit 1** when any
  drift exists (that's the CI-able drift detector).
- `--force` — restore the canonical copy over a drifted MANAGED file. Seeds are never
  touched by `--force`.
- Seeds deleted from the target are re-created on the next run (create-only refill).

Local improvements to a MANAGED file belong **upstream in this repo** — the drift report
will keep surfacing them until they converge (the same lesson as `aios update`).

## Verification

`test/repo-bootstrap.test.mjs` bootstraps throwaway repos under `os.tmpdir()` (far from
any core checkout) and asserts: full stamp + version file, idempotent re-run, drift
detection (`--check` exit 1) and `--force` restore, conflict surfacing via
`.aios-incoming`, seed immutability, and the epic's acceptance — a primary-checkout
commit is **blocked** while `git worktree add -b feat/x <sibling> origin/main` plus a
commit inside the worktree both work, with the stamped `post-checkout` self-hydration
firing and the stamped gates running clean, all with no adjacent core checkout.
