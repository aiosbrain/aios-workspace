---
name: aios-sync
description: >
  Sync this workspace with the AIOS Team Brain. Use when the user says
  "sync", "push to the brain", "pull team updates", or at a natural stopping
  point after producing deliverables/decisions. Reviews what is blocked and
  why before pushing — promotion is deliberate, never silent.
---

# AIOS Sync

Sync tier-tagged content between this repo and the Team Brain using the
`aios` CLI (toolkit `scripts/aios.mjs`; contract in `docs/brain-api.md`).

## Procedure

1. **Status first.** Run `aios status` and read all four buckets.
2. **Review blocked items with the user.** For each blocked file, the reason
   is one of:
   - *no `access:` frontmatter* — ask the user whether it should be
     `team`, `external`, or stay local (`admin` / leave untagged). Add the
     frontmatter only on their say-so; never bulk-tag.
   - *`access: admin`* — correct; never suggest changing this to make
     something sync.
   - *secret pattern matched* — investigate immediately; a secret in a
     content file is a problem whether or not it syncs.
3. **Dry run.** `aios push --dry-run` and show the user what would go
   (paths, kinds, tiers, row counts).
4. **Push on confirmation.** Run `aios push`. Report per-file results and
   any failures verbatim.
5. **Pull.** Run `aios pull` — new team items land in
   `01-intake/from-brain/` (append-only) and dashboard task changes merge
   into `03-status/tasks.md`. Summarize what arrived.

## Rules

- Never edit `aios.yaml` `sync_tiers` to include `admin` — the validator
  hard-fails it and the guard exists for a reason.
- Never auto-add `access:` frontmatter to make a blocked file sync without
  the user explicitly choosing the tier.
- If `aios status` shows the repo is offline (`brain_url` empty), say so and
  stop — everything else in this repo works without a brain.
