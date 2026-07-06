---
status: draft
owner: john
access: team
created: 2026-07-06
type: epic
tags:
  - opencode
  - onboarding
  - agent-layer
  - abe
---

# Spec — ON-EPIC: OpenCode Native Workspace (dual agent citizenship)

Linear epic: [AIO-298](https://linear.app/je4light/issue/AIO-298)
Children: AIO-299 (ON1) · AIO-300 (ON2) · AIO-301 (ON3) · AIO-302 (ON4) ·
AIO-303 (ON5) · AIO-304 (ON6) · AIO-305 (ON7) · AIO-306 (ON8)

## Why

The AIOS workspace is Claude Code-native today. The agent layer lives in `.claude/`
(system prompt, skills, rules, rubrics, commands, hooks). OpenCode sessions can read
`.claude/skills/` and `CLAUDE.md` via a compat layer, but nothing is purpose-built
for OpenCode's native agent loop.

Abe (incoming contributor) works primarily in OpenCode. When he opens this workspace, the
agent has no orientation — no spine map, no access tiers, no brain sync instructions, no
workflow agents, no instincts. The workspace needs **dual citizenship**: fully functional
in both Claude Code and OpenCode, with a shared canonical agent layer.

This epic is distinct from AIO-243 (OpenCode as a thin client UI over Claude's engine).
AIO-243 gives you OpenCode's TUI with Claude doing the work underneath. This epic gives
you OpenCode's agent loop driving the workspace directly — no Claude Code required.

## What

Eight deliverables that make the workspace OpenCode-native while preserving Claude Code
compatibility:

1. **AGENTS.md** — workspace root orientation file for OpenCode sessions
2. **opencode.json** — project-level config with model defaults, instructions, permissions
3. **Command export pipeline** — single-source commands in `.claude/commands/`, generated
   OpenCode wrappers in `.opencode/command/`
4. **Project agents** — 4 OpenCode agents for AIOS workflows
5. **Instincts plugin** — 10 Claude Code instincts ported to OpenCode hooks
6. **Skill export verification** — all 7 AIOS harnesses export cleanly for opencode runtime
7. **Brain sync verification** — `aios` CLI works identically from OpenCode sessions
8. **End-to-end smoke test** — full workspace session in OpenCode

### Design principles

- **`.claude/` is the canonical, runtime-agnostic agent root.** It is not Claude-specific
  despite the name. Skills, rules, rubrics, and commands live here for all runtimes.
- **Thin orientation, not duplication.** AGENTS.md and CLAUDE.md are pointers to the
  spine — the shared vocabulary lives in `.claude/rules/`, `.claude/memory/`, and spine
  index files. Agent-specific divergences are short, demarcated footers.
- **BYOA export pattern applied to commands.** Single canonical source
  (`.claude/commands/`), runtime-specific generated wrappers, committed output.
- **Skills stay where they are.** `.claude/skills/` is the canonical skills directory.
  OpenCode reads them via its compat layer. No duplication.

## Children

| Order | ID  | Deliverable                                           | Deps      | Effort   |
|-------|-----|-------------------------------------------------------|-----------|----------|
| 1     | ON1 | Workspace `AGENTS.md` + `0-context/index.md` update    | —         | small    |
| 2     | ON2 | Project `opencode.json`                                | ON1       | small    |
| 3     | ON3 | Command export script + 6 generated `.opencode/command/*.md` | ON2 | medium |
| 4     | ON4 | 4 `.opencode/agents/` workflow agents                  | ON1       | medium   |
| 5     | ON5 | Instincts plugin (`.opencode/plugins/aios-instincts.ts`) | ON2    | large    |
| 6     | ON6 | Skill export verification (OGR06 pass)                 | —         | small    |
| 7     | ON7 | Brain sync verification                                | ON1–ON6   | small    |
| 8     | ON8 | End-to-end smoke test + report                         | ON1–ON7   | small    |

Dependency edges: ON1→ON2 · ON1→ON4 · ON2→ON3 · ON2→ON5 · ON1→ON7 · ON2→ON7 ·
ON3→ON7 · ON4→ON7 · ON5→ON7 · ON6→ON7 · ON7→ON8

## Build order

```
ON1 —→ ON2 —→ ON4
       │
       ├—→ ON3
       │
       └—→ ON5
              │
ON6 (parallel)
              │
ON1–ON6 done —→ ON7 —→ ON8
```

## Acceptance criteria

- **AC1: `aios spec eval` exits 0 on the epic spec and all 8 child specs**
- **AC2:** Open a fresh OpenCode session in this workspace. The agent identifies the
  workspace as "John's AIOS workspace for Pravos/Vibrana," navigates the spine, lists
  available skills, and can run `aios status`.
- **AC3:** Running `node scripts/export-commands.mjs` produces
  `.opencode/command/*.md` files. Running it a second time produces identical output
  (idempotency). All 6 files have valid OpenCode YAML frontmatter.
- **AC4:** All 4 project agents load in OpenCode without errors. `aios-orchestrator` is the
  default agent per `opencode.json`. Subagents fire when invoked.
- **AC5:** The instincts plugin loads without errors on OpenCode startup. At least 5 of 10
  Claude instincts fire via OpenCode hooks. The remaining 5 have documented rationale for
  why they require Claude Code hooks.
- **AC6:** `aios skills export --runtime opencode` runs without errors for all 7 skills.
  OGR06 round-trip validator passes.
- **AC7:** `aios status`, `aios push --dry-run`, and `aios pull` all produce expected
  output when run from an OpenCode bash tool. Frontmatter guards (default-deny for untagged
  content, admin-tier block) are verified.
- **AC8:** Smoke report at `docs/specs/opencode-native/smoke-report.md` documents all 7
  verification steps from a real OpenCode session.

## Integration points

Existing files referenced (read-only unless noted):

- `.claude/CLAUDE.md` — canonical system prompt (read reference, not modified)
- `.claude/commands/draft-email.md` — command source for ON3 export
- `.claude/commands/draft-whatsapp.md` — command source
- `.claude/commands/granola-digest.md` — command source
- `.claude/commands/process-meeting.md` — command source
- `.claude/commands/process-statement.md` — command source
- `.claude/commands/publish-meeting.md` — command source
- `.claude/settings.json` — hook config (read reference for ON5 plugin mapping)
- `.claude/instincts.md` — 10 instinct triggers (read reference for ON5)
- `.claude/rules/*.md` — 13 governance rules (referenced in AGENTS.md and agents)
- `.claude/skills/*/SKILL.md` — 7 AIOS harnesses (read for ON6 export)
- `.claude/skills/INDEX.md` — skill catalog (referenced in AGENTS.md)
- `scripts/aios.mjs` — CLI shim (invoked by brain sync commands)
- `aios.yaml` — brain config (read by aios CLI)
- `validation/check-skill-export.mjs` — OGR06 validator (invoked by ON6)
- `0-context/index.md` — spine index (edited: declare `.claude/` runtime-agnostic)
- `0-context/role.md` — role definition (referenced in AGENTS.md)

New files created:

- `AGENTS.md` (workspace root) — ON1
- `opencode.json` (workspace root) — ON2
- `scripts/export-commands.mjs` — ON3
- `.opencode/command/draft-email.md` through `publish-meeting.md` (6 files) — ON3
- `.opencode/agents/aios-orchestrator.md` — ON4
- `.opencode/agents/decision-extractor.md` — ON4
- `.opencode/agents/scope-auditor.md` — ON4
- `.opencode/agents/weekly-synthesizer.md` — ON4
- `.opencode/plugins/aios-instincts.ts` — ON5
- `.opencode/package.json` — ON5
- `docs/specs/opencode-native/epic.md` (this file) + 8 child specs — planning

## Deps

- AIO-243 (done): OpenCode provider plugin (`@khalilgharbaoui/opencode-claude-code-plugin`)
  — used when OpenCode-as-client-over-Claude mode is active. Not required for this epic
  (which uses OpenCode's native agent loop), but the two modes coexist.
- `codebase-memory-mcp` MCP server (configured in global opencode.json) — available for
  code exploration from OpenCode sessions.
- `aios` CLI toolkit at `../aios/aios-workspace/scripts/aios.mjs` — required for brain
  sync commands. Must be present and functional.
- OpenCode >= latest (any version supporting skills, agents, commands, plugins) — assumed
  available per Abe's standard setup.
- Node.js >= 20 — required for `scripts/aios.mjs` and `scripts/export-commands.mjs`.

## Scope

**In scope:**
- Workspace-level files that make OpenCode sessions functional (AGENTS.md, opencode.json,
  .opencode/*)
- Generator script for command wrappers
- Instincts plugin covering all feasible OpenCode hooks
- Skill export verification against existing skills
- Brain sync verification using existing aios CLI
- Smoke test documenting the end-to-end flow

**Deferred (documented, not filed as ship-able):**
- Updates to the AIOS workspace scaffold template (`../aios/aios-workspace/scaffold/`) to
  include opencode-native files by default — this is the product-level change; this epic
  only covers John's workspace as the first instance
- BYOA axis extension: `agent_runtime: opencode` adapter improvements beyond the existing
  compat layer (this is the runtime adapter, not the workspace layer)
- Codex and GLM 5.2 command export targets (ON3's generator script is designed to accept
  new targets; adding them is a follow-on)
- OpenCode skills from scratch (reimplementing AIOS harnesses natively for OpenCode's
  agent loop) — the compat layer + honest degradation is sufficient for v1
- CI/git hook integration for command drift detection — manual re-run of generator is
  sufficient for this workspace

## Build-with

sonnet / medium

## Tier-safety

This epic touches the Team Brain sync surface (`aios push` / `aios pull` in ON7) and
creates files that reference access tiers. All new files created by this epic use
`access: team` (AGENTS.md, opencode.json, command files) or are admin-tier by
construction (agent files reference admin paths but contain no admin data; the instincts
plugin runs locally and never transmits data). No admin-tier content is embedded in any
syncable file. No brain API keys or secrets are placed in any new file. The existing
`team-ops-guard.sh` (referenced in ON5) is the safety boundary — its equivalent in the
OpenCode plugin must re-verify before any content leaves the machine.

## Testability

- **ON1:** File existence (`test -f AGENTS.md`); contains required sections (grep for spine
  map, access tiers, brain sync); no Claude-specific hook references (negative grep for
  "settings.json", "PreToolUse", "PostToolUse")
- **ON2:** JSON valid (`node -e "JSON.parse(require('fs').readFileSync('opencode.json','utf8'))"`);
  schema URL present; all referenced paths resolve
- **ON3:** Generator idempotency (`sha256sum .opencode/command/*.md` before and after
  re-run); 6 files exist; each has valid YAML frontmatter with `description` field
- **ON4:** 4 agent files exist with valid YAML frontmatter; each has `description`, `mode`,
  `permission` keys
- **ON5:** TypeScript compiles (`npx tsc --noEmit` or equivalent); plugin loads in OpenCode
  without errors; at least 5 instincts trigger (verified by log output)
- **ON6:** OGR06 exit code 0; all 7 skills export without errors
- **ON7:** `aios status` produces expected blocked/clean output; `aios push --dry-run`
  produces expected output; `aios pull` produces expected output
- **ON8:** Smoke report file exists; documents all 7 verification steps with pass/fail
