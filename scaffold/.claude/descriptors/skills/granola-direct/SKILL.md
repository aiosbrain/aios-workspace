---
name: granola-direct
description: |
  Pull Granola meeting notes and transcripts into 1-inbox/transcripts/ by calling
  the Granola public REST API directly (this is our own connector — it does NOT use
  the Granola MCP). Use when the user says "pull my Granola notes", "get today's
  meeting transcripts", "ingest my calls", or before running transcript-decisions /
  weekly-synthesis. Requires Granola connected (GRANOLA_API_KEY).
kind: skill
version: 1.0.0
access: team
triggers:
  - pull granola notes
  - get my meeting transcripts
  - ingest my calls
  - granola digest
---

# Granola (direct)

Our own Granola connector. It calls the Granola **public API** directly
(`https://public-api.granola.ai/v1`, Bearer `grn_…`) rather than the Granola MCP,
so behaviour is fully under our control. The API key is resolved locally
(env → dotenvx → `.env`) and never leaves this machine.

## How to run

```bash
node .claude/skills/granola-direct/granola-pull.mjs [--since YYYY-MM-DD] [--limit N] [--dry-run]
```

- Lists notes (`GET /v1/notes`, paginated; `--since` → `created_after`), fetches each
  transcript (`GET /v1/notes/{id}?include=transcript`), and writes one Markdown file
  per meeting to `1-inbox/transcripts/<date>-<slug>.md` with frontmatter
  (`type: transcript`, `source: granola`, `granola_id`, `created`, `participants`,
  `access: team`).
- `--dry-run` lists what would be written without touching the filesystem.

## After pulling

Chain into `transcript-decisions` to turn the new transcripts into decision-log rows,
or `weekly-synthesis` for a digest. Pulled transcripts land at `access: team` in
`1-inbox/` — promotion to the brain stays a deliberate `aios push`.

## Connect / troubleshoot

If `GRANOLA_API_KEY` is missing, connect Granola first (in the app's Integrations
hub, or `aios connect granola`). Create the key in the Granola desktop app:
**Settings → Connectors → API keys** (Business/Enterprise plan; tick the *Personal
notes* scope, add *Public notes* for workspace-wide notes).
