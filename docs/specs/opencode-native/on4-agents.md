---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON4, agents]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON4: OpenCode Project Agents

## Why

OpenCode supports project-level agents defined as Markdown files in `.opencode/agents/`.
These agents carry workspace-specific system prompts, permission models, and temperature
settings. Without project agents, every OpenCode session starts with the generic `build`
or `plan` agent — no AIOS spine orientation, no governance awareness, no workflow
expertise.

## What

Four OpenCode agent definitions in `.opencode/agents/`:

1. **`aios-orchestrator.md`** — primary agent (`mode: all`). Full spine orientation from
   AGENTS.md, governance rules summary, brain sync instructions, skill catalog awareness.
   Default temperature 0.2. Full tool access with bash guarded to `aios` and `git`.

2. **`decision-extractor.md`** — subagent (`mode: subagent`). Extracts decisions from
   meeting transcripts into decision-log rows. References `.claude/rules/decision-log.md`.
   Restricted tool surface (read, grep, glob, edit on `3-log/` only).

3. **`scope-auditor.md`** — subagent (`mode: subagent`). Detects scope creep using the
   scope-creep skill pattern. References `.claude/skills/scope-creep/SKILL.md`. Read-only
   + edit on log files.

4. **`weekly-synthesizer.md`** — subagent (`mode: subagent`). Produces weekly digests
   using the weekly-synthesis skill. References `.claude/skills/weekly-synthesis/SKILL.md`
   and `.claude/rubrics/weekly-synthesis.md`. Read-only + edit on `2-work/`.

## Acceptance criteria

- 4 files exist in `.opencode/agents/` with `.md` extension
- Each file has valid YAML frontmatter with keys: `description`, `mode`, `temperature`,
  `permission`
- `aios-orchestrator.md` has `mode: all` (primary agent)
- The remaining 3 agents have `mode: subagent`
- Each agent's system prompt body includes the phrase "AIOS workspace" and references at
  least one `.claude/` rule or skill file
- `aios-orchestrator.md` references `AGENTS.md` or the spine map
- All file paths referenced in agent prompts resolve to real files

## Integration points

- `AGENTS.md` — workspace orientation (referenced in aios-orchestrator prompt)
- `.claude/rules/decision-log.md` — decision formatting rules (referenced in
  decision-extractor)
- `.claude/rules/access-control.md` — tier rules (referenced in all agents)
- `.claude/skills/scope-creep/SKILL.md` — scope creep harness (referenced in
  scope-auditor)
- `.claude/skills/weekly-synthesis/SKILL.md` — weekly synthesis harness (referenced in
  weekly-synthesizer)
- `.claude/rubrics/weekly-synthesis.md` — synthesis quality rubric (referenced in
  weekly-synthesizer)
- `opencode.json` — references `aios-orchestrator` as `default_agent`

## Deps

- ON1: AGENTS.md must exist (provides workspace context for agent prompts)

## Scope

In scope: 4 agent files with the structure above.
Deferred: Additional agents for other AIOS workflows (transcript-decisions, okf-traverse);
agent-specific model overrides; agent evaluation/testing harness.

## Build-with

sonnet / medium

## Tier-safety

Agent system prompts are `access: team`. They reference paths to admin-tier files
(e.g., `3-log/decision-log.md` which is `access: admin`) but contain no admin data
themselves. The `permission` maps on subagents restrict write access — they can't write
outside their designated log directories. No secrets or API keys in any agent prompt.

## Testability

Demonstrated by file-existence checks, YAML frontmatter validity, and path resolution for
all file references. Manual verification: set `default_agent: aios-orchestrator` in
opencode.json, open workspace in OpenCode — agent should self-identify as AIOS
orchestrator and demonstrate spine navigation.
