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
| `validation/` | OGR validators (`validate-all.sh`: structure · frontmatter · secrets · aios config · rubrics). Must pass. |
| `hooks/` | Claude Code PreToolUse guards (secrets, access-tier, frontmatter, sync nudge) shipped into every scaffolded workspace. |
| `gui/` + `src-tauri/` | Local GUI (Claude Agent SDK) + Tauri desktop shell. |
| `examples/` | A fully synthetic sample workspace used to demo + test the harnesses. Use it; never put real data here. |
| `docs/` | `architecture.md`, `feature-set.md`, `workflows.md`, **`brain-api.md` (the pinned sync contract)**, roadmap. |
| `test/` | Toolkit tests. |

---

## 2b. Unified Inbox feature (distinct from `1-inbox/` spine folder)

The **Unified Inbox** (`aios inbox` CLI) is a cross-source human+agent attention queue (canonical spec: `docs/v1-operator-loop/domains/unified-inbox.md`). It is a separate feature from the `1-inbox/` workspace spine folder — the spine folder is a static filing location, while the Unified Inbox is a live, ranked, prioritized attention surface. For orientation and infrastructure details: `docs/v1-operator-loop/domains/unified-inbox-overview.md`, host ops: `docs/v1-operator-loop/host/provisioning-runbook.md`, and data governance: `docs/v1-operator-loop/domains/inbox-governance/`.

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

**`docs/brain-api.md` is the single pinned contract (document revision **1.12**, member-facing API **1.12**, internal gateway **1.10**, major `/api/v1`)** between this toolkit and
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
  (e.g. the NDA leak gate) — never bypass it with `--no-verify`.
- **Validators + hooks are the contract, not vibes.** Run `validation/validate-all.sh <workspace>`
  before claiming a scaffold/template change works. The secrets validator (`check-secrets.sh` +
  `leak-gate.sh` + the `team-ops-guard` hook) is a hard gate — **never commit secrets**, and never
  weaken the gate to make a commit pass.
- **Local Bugbot is a completion gate.** `hooks/local-bugbot-gate.mjs` runs from the native
  Claude, Codex, Cursor, and OpenCode lifecycle adapters. A changed diff must pass local code
  and security review before completion or merge; Medium-or-higher findings block. Never disable
  or bypass the hook when it reports a finding or infrastructure failure. OpenCode's upstream
  lifecycle API is post-idle only, so `aios build`/`aios ship` remains its hard pre-merge gate.
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
     that forwards every command to the one canonical toolkit checkout (`../aios/aios-workspace`, or
     `AIOS_TOOLKIT_DIR`). So command code (`push`/`pull`/`analyze`/harnesses) is **always current** — you
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

- **Node ESM** tooling (zero-/light-dep CLIs), Bash validators/hooks, a Claude Agent SDK GUI + Tauri shell.

```bash
# scaffold a throwaway workspace to verify template changes:
scripts/scaffold-project.sh --context consultant --slug sandbox --stakeholder "Acme" --owner alex --team "alex,sam"
validation/validate-all.sh <workspace-path>     # OGR validators (must pass)
npm run aios -- status                           # sync client status (push/pull/status)
npm run gui                                      # local GUI (chat with this repo via the Agent SDK)
```

- **Sync:** `aios push` (only tier-tagged content leaves), `aios pull` (brain → `1-inbox/`), `aios status`.
- **Deploy/release:** see `RELEASE-CHECKLIST.md`; the website documents only what's in the tagged release.

---

## 7. Do not

- **Do not** break `docs/brain-api.md` (v1) without bumping the version + matching the brain (§4).
- **Do not** commit secrets, or relax the secrets/access hooks to get a commit through.
- **Do not** make `admin`/`private` content syncable, or remove the default-deny on missing `access:`.
- **Do not** edit a stamped workspace when you mean to change the product — edit `scaffold/`.
