# Contributing to AIOS

Thanks for helping build an open operating system for AI consulting teams.

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

```bash
scripts/leak-gate.sh .            # zero matches
validation/check-secrets.sh .     # clean
# syntax-check every harness:
for f in scaffold/.claude/skills/*/*.workflow.js; do node -e "..."; done   # see CI
scripts/scaffold-engagement.sh ... && validation/validate-all.sh <out>     # smoke test
```

CI (`.github/workflows/ci.yml`) runs all of these. PRs that fail the leak gate or
secret scan will not merge.

## Good first issues

The integrations layer (sync pipeline, knowledge base, scheduling adapters) and
additional harnesses (e.g. a weekly-synthesis harness with a fidelity verifier, a
ticket-hygiene harness) are open. See the issue tracker.
