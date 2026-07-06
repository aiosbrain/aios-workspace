---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON7, brain-sync]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON7: Brain Sync Verification

## Why

The `aios` CLI (status, push, pull) is the primary brain sync surface. It's designed to
work from any shell-capable agent (explicitly listed in `docs/architecture.md`: "Claude
Code, Codex, OpenCode, cron, CI"). However, it has never been tested from within an
OpenCode session with the full OpenCode-native config stack (AGENTS.md, opencode.json,
instincts plugin, project agents).

This spec verifies that brain sync works identically from OpenCode as it does from
Claude Code — same output, same guards, same blocked/clean buckets.

## What

A verification run — no code changes, just confirmation:

1. Run `node scripts/aios.mjs status` from OpenCode bash — verify blocked/clean buckets
2. Run `node scripts/aios.mjs push --dry-run` — verify eligible files
3. Run `node scripts/aios.mjs pull` — verify brain pulls land in `1-inbox/from-brain/`
4. Verify frontmatter guard: create a test file with no `access:` frontmatter in a
   sync-included path, confirm `aios status` shows it as blocked (default-deny)
5. Verify admin-tier guard: confirm files with `access: admin` never appear as eligible
6. Verify the instincts plugin does not interfere with brain sync commands (no false
   positives from access gate triggering on `aios push`)

## Acceptance criteria

- `node scripts/aios.mjs status` exits 0 and shows expected blocked/clean buckets
- `node scripts/aios.mjs push --dry-run` exits 0 and shows expected eligible files (or
  "nothing to push" if all clean)
- `node scripts/aios.mjs pull` exits 0 and new items land in `1-inbox/from-brain/`
- A temporary untagged file in `2-work/` appears as "blocked — default-deny" in status
- A file tagged `access: admin` in `2-work/` appears as "blocked — admin never syncs"
- No `aios` commands are blocked or flagged by the instincts plugin's access gate
- All output matches expected format from previous Claude Code sessions (verbatim
  comparison of status output)

## Integration points

- `scripts/aios.mjs` — CLI shim (invoked)
- `../aios/aios-workspace/scripts/aios.mjs` — toolkit CLI (forwarded to)
- `aios.yaml` — brain config (read by CLI)
- `.opencode/plugins/aios-instincts.ts` — instincts plugin (must not interfere)
- `1-inbox/from-brain/` — pull destination (verified)

## Deps

- ON1–ON6: all workspace config must be in place (AGENTS.md, opencode.json, commands,
  agents, plugin)
- `AIOS_API_KEY` env var — must be set for push/pull operations
- `../aios/aios-workspace/` — toolkit repo must be cloned and functional
- Node.js >= 20 — required by `scripts/aios.mjs`

## Scope

In scope: verification of all 3 CLI operations + frontmatter guards + non-interference
from instincts plugin.

Deferred: Automated CI test for brain sync from OpenCode; performance comparison
(Claude Code vs OpenCode sync latency); multi-session sync conflict test.

## Build-with

sonnet / low

## Tier-safety

Brain push/pull involves the brain API (`brain_url` in `aios.yaml`). The `AIOS_API_KEY`
is read from env, never stored in any file. No admin content is pushed during verification
(or a dry-run is used). The existing tier rules in `scripts/aios.mjs` buildPlan are the
single enforcement point — this spec only verifies they fire, doesn't modify them.

## Testability

Demonstrated by running each CLI command and comparing output to expected format.
Manual verification documented in ON8 smoke report.
