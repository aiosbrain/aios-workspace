# Contributing to AIOS

Thanks for helping build an open, agent-native operating system for an individual
contributor — the workspace you work in day to day, shaped to your context
(**consultant**, **employee**, or **business-owner**) and synced, on your terms, to a
shared [AIOS Team Brain](docs/brain-api.md).

## Ground rules

1. **No client data, ever.** This repo contains only generic structure, harness
   code, and *synthetic* example data. Before you push, `scripts/leak-gate.sh` must
   pass — it blocks client/firm/person identifiers and business-data patterns. CI
   runs it on every PR. If you need example data, invent it (see
   `examples/sample-engagement/`).
2. **Keep it generic.** Anything engagement-specific belongs in `args`, config, or
   the scaffolded repo — not in the framework. No names, no real numbers.
3. **Read-only harnesses.** A workflow harness analyzes and returns data; the calling
   session writes output. Harnesses never edit a canonical log.

## Adding a dynamic-workflow harness

Harnesses live in `scaffold/.claude/skills/<name>/` as a `SKILL.md` plus a
`<name>.workflow.js`. Read `scaffold/.claude/skills/README.md` first — it codifies the
ten conventions that came out of the design study (`docs/workflows.md`). The load-bearing ones:

- **Adversarial verification is the value**, not fan-out. Any harness that emits
  findings/claims needs an independent `verify(claim, evidence) → {real, …}` stage.
- **Prefer "re-grade severity" over binary keep/drop** in refuters (preserves recall).
- **Read shared context once; pass excerpts inline.** Batch verification by group.
  Agent *count* is the cost driver.
- **Gate by input size**; for small inputs single-pass is cheaper and as good.
- **`args` arrives as a JSON string** — always `JSON.parse(args)`.

Treat each `.workflow.js` as a **template**: it should be readable and tunable per
engagement, not a black box.

## Checks before you push

These are the actual commands CI (`.github/workflows/ci.yml`) runs. Run them locally
before opening a PR:

```bash
# Guardrails
bash scripts/leak-gate.sh .            # confidentiality leak gate — zero matches
bash validation/check-secrets.sh .     # secret scan — clean

# Constitution + docs guards
npm run check:docs                     # docs-drift guard
npm run check:domains                  # workflow-domain isolation (no cross-domain imports)
npm run check:size                     # aios.mjs size gate

# Lint + format
npm run lint
npm run format:check

# Unit + integration tests (this is the same suite CI's `tests` job runs)
npm test

# Scaffold smoke test + validate — the canonical scaffolder, not the legacy one.
# Test all three contexts when touching scaffold content (RESOLVER gate requires it):
bash scripts/scaffold-project.sh \
  --context consultant --slug ci-sample --stakeholder "Sample Co" --owner alex \
  --members "alex,sam,jordan" --org your-github-org --currency USD \
  --output /tmp/ci-sample-consultant
bash validation/validate-all.sh /tmp/ci-sample-consultant

bash scripts/scaffold-project.sh \
  --context employee --slug ci-sample-emp --stakeholder "Sample Co" --owner alex \
  --members "alex,sam,jordan" --org your-github-org --currency USD \
  --output /tmp/ci-sample-employee
bash validation/validate-all.sh /tmp/ci-sample-employee

bash scripts/scaffold-project.sh \
  --context business-owner --slug ci-sample-biz --stakeholder "Sample Co" --owner alex \
  --members "alex,sam,jordan" --org your-github-org --currency USD \
  --output /tmp/ci-sample-biz
bash validation/validate-all.sh /tmp/ci-sample-biz
```

`scripts/scaffold-engagement.sh` is a **legacy** alias kept only for backward
compatibility; use `scripts/scaffold-project.sh` (see its usage header for all flags,
including `--context employee|business-owner`) for anything new.

PRs that fail the leak gate or secret scan will not merge.

## Contributing back from a scaffolded workspace

There are two different places a change to AIOS can come from, and they end up in this
repo two different ways:

1. **You cloned this toolkit repo directly.** Make your change, open a PR against
   `main` as usual — the checks above are the bar.
2. **You're working in a workspace stamped *from* this toolkit** (i.e. you ran
   `scaffold-project.sh` and now have your own personal AIOS workspace). Most of what
   you touch day to day there is yours (`0-context/` … `5-personal/`, your own skills).
   But some files are **toolkit-managed** — vendored copies of governance the toolkit
   ships (`.claude/{rules,skills,rubrics,commands,personalities,agents,descriptors}`,
   `scripts/aios.mjs`, `hooks/*`, `validation/*`, `RESOLVER.md`, …). The full list of
   what's managed vs. seed-only vs. yours is the single source of truth in
   `scripts/toolkit-manifest.mjs` (four buckets: `MANAGED_PATHS`, `SEED_IF_ABSENT`,
   `PERSONAL_PATHS`, `SCAFFOLD_UNMANAGED`).

   **The rule: toolkit changes land upstream here, never in a fork.** `aios update`
   is the one-way flow *out* (toolkit → workspace); it is not a place to accumulate
   local improvements to managed files. If you improve a managed file inside your
   workspace, upstream it with:

   ```bash
   aios update --contribute <path-to-the-file-you-changed>
   aios update --contribute <path> --dry-run    # see the plan first, writes nothing
   ```

   This maps your workspace file back to its toolkit source path, creates a throwaway
   toolkit worktree off `origin/main` (never your primary checkout), commits your
   change there, pushes, and opens the PR via `gh` — see
   `scripts/toolkit-contribute.mjs` for exactly what it does.

   If you skip this and just keep editing the managed file locally, every subsequent
   `aios update` will re-surface it as a conflict instead of a clean merge: since the
   toolkit's version and your version have both moved, the 3-way merge can't reconcile
   them automatically and writes the incoming/attempted merge to
   `<file>.aios-incoming` / `<file>.aios-merge` next to your file rather than
   overwriting it — you resolve by hand and the file's update stamp stays pinned to the
   old base until you do. Running `--contribute` (and getting it merged) is what makes
   that conflict go away for good, for you and for everyone else who updates after you.

## Good first issues

The integrations layer (sync pipeline, knowledge base, scheduling adapters) and
additional harnesses (e.g. a weekly-synthesis harness with a fidelity verifier, a
ticket-hygiene harness) are open. Look for issues tagged **`good first issue`** on the
issue tracker.
