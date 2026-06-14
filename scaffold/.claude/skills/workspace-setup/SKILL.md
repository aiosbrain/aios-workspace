---
name: workspace-setup
description: |
  Set up (or update) the owner's profile in this workspace: interview the user about
  who they are and what they're working on, then write it into .claude/CLAUDE.md so the
  agent has durable context. Use on first run, when the "About" section in CLAUDE.md is
  still a placeholder, or when the user says "set me up", "onboard me", "set up my
  profile", or "update my profile".
kind: skill
version: 1.0.0
triggers:
  - set me up
  - onboard me
  - set up my profile
  - update my profile
  - who am I
---

# Workspace setup

Seed this workspace with durable context about its owner so every future session
starts informed. Conduct a short, warm interview — **one question at a time**, at most
six questions, and let them skip any. Then write it into `.claude/CLAUDE.md`.

## Interview (one at a time)

1. **You** — name and role/title.
2. **Context** — consultant (which client(s) right now?) or employee (which company /
   team / department?).
3. **Current focus** — what you're actually working on now: projects/initiatives and
   the goals behind them.
4. **Working style** — how you want the agent to operate: tone, level of autonomy,
   what to always do, what to avoid.
5. **Your tools** — what you use day to day (Slack, Jira, Notion, Linear, Granola,
   email, …) so we can suggest which integrations to connect.
6. **Anything else** the agent should always know about you or the work.

## Then write `.claude/CLAUDE.md`

Read the current file, and replace the placeholder sections (keep everything else):
- **`## About <owner>`** — 2–4 lines: name, role, context (client/company).
- **`## Current focus`** — a tight bullet list of projects/goals; prefix with today's
  date so it's clearly a snapshot.
- **`## Working preferences`** — a short bullet list of how to operate.

Rules:
- Confirm a concise summary with the user **before** writing.
- Keep it crisp — no filler. This is context the agent reads every session.
- **Never** put secrets, API keys, or passwords in CLAUDE.md.
- After writing, point them at the **Integrations** tab to connect the tools they named.
