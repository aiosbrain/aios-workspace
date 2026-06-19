---
name: plane-tasks
description: >
  Work AIOS tasks on the Plane board (workspace aios-alpha, project AIOS). Use when the user
  says "pick up <epic>", "what's my next Plane task", "mark this done in Plane", "move the
  ticket", or when an agent starts/finishes a chunk of AIOS work. Reads and updates work items
  via the Plane MCP; keeps the board honest as work moves.
---

# Plane Tasks (AIOS)

The AIOS backlog lives in **Plane** — workspace `aios-alpha`, project **AIOS**. Big pieces of work
are **epics** (parent work items, e.g. `F3`, `W1.1`); the chunks under them are **sub-issues**
(`F3.1`, `W1.1.2`). Items carry a stable `external_id` (+ `external_source=aios-backlog`) and live in
**Wave 1 — MVP** / **Wave 2 — Later** modules. Useful saved Views: **Epics** (overview), **Wave 1 —
Execution** (the active board), **By subsystem**, **Shipped**.

## One-time setup (each contributor, on your own machine)

The Plane MCP needs **your own** Plane Personal Access Token — never share or commit it.

1. Plane → **Profile settings → Personal Access Tokens → Add** → copy the token.
2. Put it in your workspace `.env` (dotenvx-encrypted): `PLANE_API_KEY=<token>`.
3. Register the MCP (the key is injected from your `.env` at launch — not stored in config):
   ```bash
   claude mcp add plane --scope user \
     -e PLANE_WORKSPACE_SLUG=aios-alpha \
     -e PLANE_BASE_URL=https://api.plane.so \
     -- npx --yes @dotenvx/dotenvx run -f <abs-path>/.env --quiet -- uvx plane-mcp-server stdio
   ```
4. `claude mcp get plane` should show **Connected**. If `/mcp` doesn't list it, restart the session.

Requires `uvx` (from `uv`). The token is yours — anything you create via it (e.g. saved views) is
owned by your identity; mark shared artifacts **public** so teammates see them.

## Procedure — taking a task

1. **Find it.** Use the Plane MCP to locate the epic (by title or `external_id`) and its sub-issues.
   Honor **blocked-by** relations — if an epic is blocked (e.g. `F4`/`F5` ← `F3`, `W1.3` ← `F5`),
   don't start it until the blocker is Done/merged. Check the **Wave 1 — Execution** view for what's open.
2. **Claim it.** Move the epic → **In Progress**. (Optionally assign yourself.)
3. **Do the work in a git worktree** — never the primary checkout (root `CLAUDE.md` mandates this):
   `git worktree add -b feat/<epic> ../<repo>-<epic> origin/main`. Follow the engineering rules
   (spec-first tests, single-writer guards, tier isolation, docs drift, brain-api contract discipline).
4. **Track chunks.** Move each sub-issue → **In Progress** while working it, → **Done** when its
   acceptance criteria pass. Keep the board matching reality.
5. **PR + close out.** Open the PR from the worktree branch. **Comment the PR URL on the epic.** When
   merged, move the sub-issues + epic → **Done**.

## Rules

- **Your own token, your own machine.** Never commit `PLANE_API_KEY`; it lives only in your dotenvx `.env`.
- **Don't create duplicate work items by hand** for things already in the backlog — find the existing
  `external_id` first. (Bulk/structural changes go through `aios-team-brain/scripts/plane-backlog.mjs`,
  which is idempotent by `external_id`.)
- **Respect blocked-by.** A blocked epic is not ready; resolve or wait on its blocker.
- **Move state to match reality, not aspiration** — In Progress means actually being worked now.
- The full per-epic handoff prompts (scope + acceptance per sub-issue) live in
  `docs/aios-agent-handoffs.md`.
