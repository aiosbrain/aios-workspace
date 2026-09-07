# AIOS Workspace — operating manual

**Skill/doc routing: see `RESOLVER.md`** — gates (worktree, edit-the-template,
brain-api, tiers, spec-before-build, secrets, rubrics) and the review/audit
arbitration table. Stamped workspaces get their own resolver from
`scaffold/RESOLVER.md.tmpl`.

This file is read at the start of every session. It describes **this repo** — the AIOS
**individual workspace toolkit** — and the conventions for working in it. Follow it over
generic habits.

> Monorepo context: this repo sits beside `aios-team-brain` and `aios-website` under a
> context-monorepo root (`../CLAUDE.md`). This file governs the workspace toolkit specifically.

---

## 1. What this repo is

An **agent-native operating system for one individual contributor.** It is *not* the server —
it's the workspace a person works in and from which they push selected output to the one shared
**Team Brain** (`aios-team-brain`). Two distinct repos; do not conflate them:

- **This repo** scaffolds + governs a personal workspace, runs multi-agent **workflow harnesses**
  (decision audit, scope-creep, transcript→decisions, weekly synthesis), validates the repo, and
  syncs to the brain. **Nothing leaves the machine until `aios push`.**
- **The Team Brain** is the only shared/team layer; it receives pushes and answers queries.

The toolkit is **cloned per person** and skinned to a context chosen at onboarding:
**`--context consultant`** (client/engagement framing), **`--context employee`** (role/OKR framing), or
**`--context business-owner`** (consultant profile + a `6-business/` spine folder) —
the same spine, three skins.

---

## 2. Repo map (where things live)

| Path | What |
|------|------|
| `scaffold/` | The workspace **template** that gets stamped into a person's repo: the numbered spine + `scaffold/.claude/` (`rules/` including **git-workflow**, `skills/`, `rubrics/`, `memory/`, `settings.json`, `CLAUDE.md.tmpl`) + `scaffold/AGENTS.md.tmpl`. Editing the product's behavior usually means editing here. |
| `scripts/` | `scaffold-project.sh` (stamp a workspace), `aios.mjs` (Team Brain sync CLI: `push`/`pull`/`status`), `leak-gate.sh`, GUI/runtime/catalog helpers. |
| `validation/` | The OGR validators, `OGR01`–`OGR15` **except `OGR09`** (`validate-all.sh` runs all fourteen; `--critical` = OGR03 secrets only, `--quick` = OGR01 structure only). Workspace hygiene (OGR01–05, 14), scaffold + runtime contracts (OGR06–08, 11, 12, 15), advisory scorecards (OGR10, 13 — always exit 0). **OGR09 (skill library) moved to `aiosbrain/aios-workspace-gui`** with the library data it checks (AIO-702). Must pass. Full table: `docs/feature-set.md` §3. |
| `hooks/` | Claude Code PreToolUse guards (secrets, access-tier, frontmatter, sync nudge) shipped into every scaffolded workspace. |
| `packages/foundation/` | `@aiosbrain/foundation` (npm workspace) — the shared hub modules, **published to npm (public)**; `scripts/` paths are one-line re-export shims. |
| `examples/` | A fully synthetic sample workspace used to demo + test the harnesses. Use it; never put real data here. |
| `docs/` | `architecture.md`, `feature-set.md`, `workflows.md`, **`brain-api.md` (the pinned sync contract)**, roadmap. |
| `test/` | Toolkit tests. |

---

## 2b. Unified Inbox feature (distinct from `1-inbox/` spine folder)

The **Unified Inbox** (`aios inbox` CLI) is a cross-source human+agent attention queue (canonical spec: `docs/v1-operator-loop/domains/unified-inbox.md`). It is a separate feature from the `1-inbox/` workspace spine folder — the spine folder is a static filing location, while the Unified Inbox is a live, ranked, prioritized attention surface. For orientation and infrastructure details: `docs/v1-operator-loop/domains/unified-inbox-overview.md`, host ops: `docs/v1-operator-loop/host/provisioning-runbook.md`, and data governance: `docs/v1-operator-loop/domains/inbox-governance/`.

---

## 2c. Repo topology — multi-repo split (in transition)

The one-repo layout is being split (AIO-597; `scripts/check-boundaries.mjs` encodes the
seams as import rules). Current, verified state:

| Piece | Home | Status |
|-------|------|--------|
| Core toolkit (CLI, scaffold, validators, hooks, operator loop) | this repo | Authoritative. |
| Shared hubs (`runtimes`, `workspace-parse`, `brain-config`, `linear-client`, `brain-client`, `git-files`, `constitution`) | `@aiosbrain/foundation` — `packages/foundation/`, published to npm (public, 0.1.0) | Shipped. `scripts/` paths are one-line re-export shims. |
| GUI + desktop shell | `github.com/aiosbrain/aios-workspace-gui` (filtered history from core at freeze SHA `d6dcdeb` / tag `cut/gui-freeze`) | **Cut and removed** (AIO-612). `gui/` and `src-tauri/` are **gone from this repo** — the GUI repo is the only copy, and it is authoritative. Seam contract: `docs/gui-toolkit-contract.md` (toolkit location: `--toolkit-dir` → `AIOS_TOOLKIT_DIR` → actionable error; the pre-split relative fallback `gui/server/../../` went with the trees, so installs must set `AIOS_TOOLKIT_DIR` or pass `--toolkit-dir`). |
| Desktop (Tauri) | travels with the GUI repo | Adjacent-checkout mode only; **do-not-demo** for v0.9.0. Self-contained bundling is AIO-581, owned by the GUI repo. |
| Devtools | `aiosbrain/aios-devtools` | **Cut and removed** (AIO-594 → AIO-661 → AIO-662). `ship`, `build`, `roadmap-run`, `spec-eval`, `spec-publish`, `consolidate-findings` and `scripts/ship/` are **gone from this repo**; `@aiosbrain/aios-devtools` is authoritative and is a dependency of `@aiosbrain/aios`, so `aios ship` works on a plain `npm i -g @aiosbrain/aios`. Core dispatches through `scripts/devtools-dispatch.mjs` (`--devtools-dir` → `AIOS_DEVTOOLS_DIR` → the package → actionable error). `scripts/boundaries.json` carries **zero R6 grandfathers** — the machine-checkable proof the direction is clean. Seam contract: `docs/devtools-toolkit-contract.md`. |

Migration for existing workspace owners at v0.9.0: one `aios update`; no re-scaffold. A
pre-AIO-814 shim that cannot find the checkout needs a one-time bootstrap through a global/toolkit
CLI invocation, a recognized sibling layout, or `AIOS_TOOLKIT_DIR`. Once the update vendors the
new shim, the workspace reads the checkout out of its own `.aios-toolkit-version` stamp and no
permanent env var is needed. The **GUI** still requires `AIOS_TOOLKIT_DIR` or `--toolkit-dir`; it
has no stamp to read.

---

## 3. The workspace spine + tier model (the core invariant)

Every scaffolded workspace uses the same six-folder spine, each with a default access tier:

```
0-context/   charter/scope (consultant) or role/OKRs (employee)   tier: team
1-inbox/     raw inputs, transcripts, from-brain pulls             tier: admin
2-work/      deliverables, working documents                       tier: team
3-log/       decision log, tasks, hours                            tier: admin
4-shared/    client-facing / company-facing                        tier: external
5-personal/  private scratch                                       tier: admin
```

**Access tiers are the safety boundary.** Canonical values: **`admin`** (never syncs — owner only),
**`team`** (syncs to the brain), **`external`** (syncs outward to stakeholders). **Default-deny:**
content with no resolvable `access:` frontmatter is **not** pushed. The brain rejects `admin`-tier
at the boundary (422). Never weaken this. Full vocabulary (aliases, spine defaults, isolation
invariants): `../docs/tier-vocabulary.md` — the scaffold's self-contained copy is
`scaffold/.claude/rules/frontmatter.md`; change both together.

---

## 4. The pinned sync contract — do not drift ⚠️

**`docs/brain-api.md` is the single pinned contract (document revision **1.24**, member-facing API **1.24**, internal gateway **1.10**, major `/api/v1`)** between this toolkit and
the Team Brain. Both sides build against it. **Any change to the sync protocol is a versioned change
in that file first** — bump the version and make the matching change in `aios-team-brain`. A silent
drift breaks `aios push`/`aios pull` for everyone. Forward-compat rule: clients MUST ignore item kinds
they don't recognize.

---

## 5. Conventions (internalize these)

- **No direct commits in the primary checkout, on any branch.** A local `pre-commit` guard
  (tracked source: `hooks/git/pre-commit-primary-guard`; installed by
  `scripts/install-primary-commit-guard.sh`, and automatically by `aios worktree add` /
  `aios worktree install-hook`) BLOCKS **every** authored commit made in the PRIMARY
  checkout — including on `main` — telling you to `aios worktree add <branch>` instead. The
  primary should only ever advance via `git merge --ff-only` from origin, which moves the ref
  without creating a commit and so never triggers the hook; a non-ff merge in the primary IS
  the anti-pattern and is blocked too (use the override if genuinely intended). It NO-OPs
  inside linked worktrees (where all real work belongs). This is the structural enforcement of
  the worktree rule — it exists because automated harnesses (oh-my-opencode / Codex, and a
  Linear agent seen writing code straight on `main`) were observed committing in the primary,
  landing feature work on `main`, stranding it on a feature branch, and producing duplicate
  PRs. Override only for a genuine primary hotfix or a deliberate non-ff merge on `main`:
  `AIOS_ALLOW_PRIMARY_COMMIT=1 git commit ...`. It chains any pre-existing pre-commit hook
  (e.g. the NDA leak gate) — never bypass it with `--no-verify`. In a `core.hooksPath` repo
  whose destination hook carries the line-anchored `# aios-tracked-hook` marker (a tracked
  policy hook, e.g. aios-team-brain's `.githooks/`), the installers leave the tracked file
  untouched and install machine-locally into `$(git rev-parse --git-common-dir)/hooks/` —
  the chain target the tracked hook execs. If that policy directory does not provide a
  tracked dispatcher for another required hook name, the stamped harness installer keeps
  the executable hook in `core.hooksPath` and adds only that generated path to the
  repository-local `.git/info/exclude`, preserving both enforcement and a clean checkout
  (AIO-638).
- **Validators + hooks are the contract, not vibes.** Run `validation/validate-all.sh <workspace>`
  before claiming a scaffold/template change works. The secrets validator (`check-secrets.sh` +
  `leak-gate.sh` + the `team-ops-guard` hook) is a hard gate — **never commit secrets**, and never
  weaken the gate to make a commit pass.
- **Current-head cloud review is sufficient; Local Bugbot is optional.**
  `hooks/local-bugbot-gate.mjs` still runs from the native Claude, Codex, Cursor, and OpenCode
  lifecycle adapters, but at Stop/idle it only performs a cheap non-blocking advisory probe
  (AIO-567). For a pushed PR, green required CI plus at least one substantive current-head cloud
  Bugbot or CodeRabbit review with no unresolved findings satisfies the review gate. `aios build`
  / `aios ship` may still run local code + security review as an operator-workflow stage, and the
  manual diagnostic remains
  `node hooks/local-bugbot-gate.mjs --runtime <rt> --json --check-exit`; neither makes Local
  Bugbot a repository-wide merge prerequisite. Address substantive Medium-or-higher findings
  from any reviewer, but a Local Bugbot outage, protocol error, or unrelated-worktree failure does
  not by itself block an otherwise clear PR.
- **CodeRabbit is current-head and label-gated.** Standard PRs use it only when selected; safety
  PRs require it and the `ready-for-review` label. After any fix push, request a fresh review with
  `@coderabbitai review`. A successful check run without substantive review text is not evidence.
- **Harnesses must stay trustworthy.** Skills under `scaffold/.claude/skills/` are dynamic multi-agent
  workflows with **adversarial verification + rubric-gated self-correction** (`scaffold/.claude/rubrics/`).
  When you change a harness, keep its rubric honest — the rubric is what makes the output trustworthy.
- **Spec before build.** Linear issue bodies (and domain specs under `docs/`) should pass
  `aios spec eval` (`SPEC_READY`) before `aios ship` or `aios relay --spec` planning — ship enforces
  this automatically; agents writing specs should self-check first. See `docs/agent-build.md`.
- **Edit the template, not a stamped copy.** Product behavior lives in `scaffold/`; changing a single
  user's stamped workspace doesn't change the product. Stamped workspaces ship
  `.claude/rules/git-workflow.md` + `AGENTS.md` so owners treat their IC repo as personal
  context (`master` only) and do toolkit PRs in **this** repo instead.
- **How forks stay in sync (two layers, one command).** Every contributor has an independent
  scaffolded workspace repo. It stays current WITHOUT re-scaffolding:
  1. **CLI = a delegating shim.** A workspace's `scripts/aios.mjs` is a thin shim (`scaffold/scripts/aios.mjs`)
     that forwards every command to the one canonical toolkit checkout. It finds that checkout from
     `AIOS_TOOLKIT_DIR`, else the deprecated `AIOS_TOOLKIT_CLI` entrypoint, else the `source` line in
     the workspace's `.aios-toolkit-version` stamp (written by the scaffolder, rewritten by every
     `aios update` — so no env var and no particular directory layout is required, AIO-814), else
     from relative `~/Projects` layouts as a legacy last resort. So command code
     (`push`/`pull`/`analyze`/harnesses) is **always current** — you
     never vendor the full CLI (it needs `node_modules` deps and would crash in a workspace). Update it by
     `aios update` (or `git pull` in `aios-workspace`).
  2. **Governance = vendored, synced by `aios update`.** The files Claude Code + validators read *in place*
     (`.claude/{skills,rules,rubrics,commands}`, guardrail `hooks/`, `validation/`) are copies that drift.
     **`aios update`** re-syncs exactly the scaffold-defined surface (`scripts/toolkit-manifest.mjs`, whose
     four buckets — MANAGED / SEED_IF_ABSENT / PERSONAL / SCAFFOLD_UNMANAGED — are held in lockstep with `scaffold-project.sh`
     by a parity test). Managed files use a **3-way merge** (`scripts/toolkit-merge.mjs`); create-only seeds fill
     a missing starter but never read, merge, overwrite, or delete an existing personal file. With the toolkit at the last-synced
     sha as the base, a *committed* local edit is **merged** with the toolkit's change (or surfaced as a
     conflict — written to `<file>.aios-incoming`/`.aios-merge`, never inline into the live file), an
     *uncommitted* edit is **skipped** (`--force` overwrites), personal additions are never deleted, and
     upstream deletions propagate only for files you didn't touch. On conflict the stamp stays at the old base
     until you resolve + re-run. `scaffold-project.sh` writes a full-sha `.aios-toolkit-version` at scaffold
     time; the stamp + every `aios update` also record the toolkit **semver** (`package.json`) + the
     **brain-api** contract version (`docs/brain-api.md` header) so a workspace reasons about "v0.6 → v0.7",
     not an opaque sha (`scripts/toolkit-meta.mjs`). `aios update --check` reports drift.
  Toolkit changes always land **upstream here**, never in a fork; `aios update` is the one-way flow out. If
  you improve a *managed* file locally, upstream it — the merge will keep surfacing it as a conflict against
  each toolkit change until it converges (that's the granola-1.1.0 lesson). **`aios update --contribute <path>`**
  (`scripts/toolkit-contribute.mjs`) closes that loop in one command: it maps the workspace file back to its
  toolkit `src`, drops it into a throwaway toolkit worktree off `origin/main` (never the primary checkout),
  and opens the PR with `gh`. `--dry-run` prints the plan without writing.
- **All three contexts must keep working.** A scaffold change has to hold for `--context consultant` AND
  `--context employee` AND `--context business-owner`. Test all three.
- **The example is synthetic.** `examples/` is the only place with sample content; keep it fake.
- **Workflow-layer code follows the constitution.** The 5 workflow domains + the Operator Loop are
  governed by **`docs/ENGINEERING-CONSTITUTION.md`** — all-TypeScript, well-bounded modules that emit
  typed tier-tagged signals into the loop, spec-before-code (`spec → plan → tasks → implement`). Don't
  port prior-build code verbatim; rebuild clean and typed. The V1 decomposition lives in
  `docs/v1-operator-loop/`.

---

## 6. Stack & key commands

- **Node ESM** tooling (zero-/light-dep CLIs), Bash validators/hooks, and the published `@aiosbrain/foundation` npm workspace. The Claude Agent SDK GUI + Tauri shell live in `aiosbrain/aios-workspace-gui` (§2c).
- **Two Node numbers, doing two different jobs — do not collapse them** (AIO-628).
  - **Development pin: 22** (`.nvmrc` / `.node-version`). Worktrees symlink `node_modules` from the
    primary, so they all run the primary's compiled `better-sqlite3` — running tests under a different
    Node major (e.g. Homebrew's newer Node) triggers a `NODE_MODULE_VERSION` ABI crash in the
    operator-loop DB tests. Run `nvm use` (or fnm/mise, which read `.nvmrc`) so your shell is on 22.
    `scripts/ensure-native-abi.mjs` (a `pretest` gate + worktree-hydration step) turns any mismatch into
    an actionable message instead of a cryptic ABI number, and auto-rebuilds when the active Node is a
    supported one. **Keep these files at 22** — bumping them to match the supported range below is the
    exact mistake this split exists to prevent.
  - **Supported range: `engines.node: ">=22"`** in `package.json` *and*
    `packages/foundation/package.json`. `@aiosbrain/foundation` is published to npm, so this range
    propagates to every downstream consumer; npm only warns on `engines`, but **yarn and pnpm hard-fail
    by default**, so a stale upper bound is a real install failure for a user on a newer LTS. The old
    `<23` ceiling encoded better-sqlite3 11.x's prebuild limit; the repo is on **13.x**, which declares
    `engines: { node: ">=22" }` with no upper bound, so the ceiling is gone. CI proves the range by
    running the `Node tests` lane on **22, 24 and 26** — keep that matrix in step with this line, and
    keep it off the coverage lanes (one runtime owns the ratchet baseline).

```bash
# scaffold a throwaway workspace to verify template changes:
scripts/scaffold-project.sh --context consultant --slug sandbox --stakeholder "Acme" --owner alex --team "alex,sam"
validation/validate-all.sh <workspace-path>     # OGR validators (must pass)
npm run aios -- status                           # sync client status (push/pull/status)
```

- **Sync:** `aios push` (only tier-tagged content leaves), `aios pull` (brain → `1-inbox/`), `aios status`.
- **Deploy/release:** see `RELEASE-CHECKLIST.md`; the website documents only what's in the tagged release.

---

## 7. Do not

- **Do not** break `docs/brain-api.md` (v1) without bumping the version + matching the brain (§4).
- **Do not** commit secrets, or relax the secrets/access hooks to get a commit through.
- **Do not** make `admin`/`private` content syncable, or remove the default-deny on missing `access:`.
- **Do not** edit a stamped workspace when you mean to change the product — edit `scaffold/`.
