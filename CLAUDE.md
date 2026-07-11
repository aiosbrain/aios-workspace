# AIOS Workspace — operating manual

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
**`--context consultant`** (client/engagement framing) or **`--context employee`** (role/OKR framing) —
the same spine, two skins.

---

## 2. Repo map (where things live)

| Path | What |
|------|------|
| `scaffold/` | The workspace **template** that gets stamped into a person's repo: the numbered spine + `scaffold/.claude/` (`rules/` including **git-workflow**, `skills/`, `rubrics/`, `memory/`, `settings.json`, `CLAUDE.md.tmpl`, `AGENTS.md.tmpl`). Editing the product's behavior usually means editing here. |
| `scripts/` | `scaffold-project.sh` (stamp a workspace), `aios.mjs` (Team Brain sync CLI: `push`/`pull`/`status`), `leak-gate.sh`, GUI/runtime/catalog helpers. |
| `validation/` | OGR validators (`validate-all.sh`: structure · frontmatter · secrets · aios config · rubrics). Must pass. |
| `hooks/` | Claude Code PreToolUse guards (secrets, access-tier, frontmatter, sync nudge) shipped into every scaffolded workspace. |
| `gui/` + `src-tauri/` | Local GUI (Claude Agent SDK) + Tauri desktop shell. |
| `examples/` | A fully synthetic sample workspace used to demo + test the harnesses. Use it; never put real data here. |
| `docs/` | `architecture.md`, `feature-set.md`, `workflows.md`, **`brain-api.md` (the pinned sync contract)**, roadmap. |
| `test/` | Toolkit tests. |

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
**`team`** (syncs to the brain), **`external`** (syncs outward to stakeholders). Friendly aliases
`private`→admin, `client`/`company`→external are normalized on push. **Default-deny:** content with
no resolvable `access:` frontmatter is **not** pushed. The brain rejects `admin`-tier at the boundary
(422). Never weaken this.

---

## 4. The pinned sync contract — do not drift ⚠️

**`docs/brain-api.md` is the single pinned contract (currently **v1.8**, major `/api/v1`)** between this toolkit and
the Team Brain. Both sides build against it. **Any change to the sync protocol is a versioned change
in that file first** — bump the version and make the matching change in `aios-team-brain`. A silent
drift breaks `aios push`/`aios pull` for everyone. Forward-compat rule: clients MUST ignore item kinds
they don't recognize.

---

## 5. Conventions (internalize these)

- **Validators + hooks are the contract, not vibes.** Run `validation/validate-all.sh <workspace>`
  before claiming a scaffold/template change works. The secrets validator (`check-secrets.sh` +
  `leak-gate.sh` + the `team-ops-guard` hook) is a hard gate — **never commit secrets**, and never
  weaken the gate to make a commit pass.
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
     `AIOS_TOOLKIT_CLI`). So command code (`push`/`pull`/`analyze`/harnesses) is **always current** — you
     never vendor the full CLI (it needs `node_modules` deps and would crash in a workspace). Update it by
     `git pull` in `aios-workspace`.
  2. **Governance = vendored, synced by `aios update`.** The files Claude Code + validators read *in place*
     (`.claude/{skills,rules,rubrics,commands}`, guardrail `hooks/`, `validation/`) are copies that drift.
     **`aios update`** re-syncs exactly the scaffold-defined surface (`scripts/toolkit-manifest.mjs`,
     kept in lockstep with `scaffold-project.sh`) as an **overlay** — toolkit files overwrite, personal
     additions (a person's own skills/scripts) are never deleted. `aios update --check` reports drift; a
     `.aios-toolkit-version` stamp pins the synced sha.
  Toolkit changes always land **upstream here**, never in a fork; `aios update` is the one-way flow out.
- **Both contexts must keep working.** A scaffold change has to hold for `--context consultant` AND
  `--context employee`. Test both.
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
