---
name: granola-direct
description: |
  Pull Granola meeting notes and transcripts into 1-inbox/transcripts/ by calling
  the Granola API directly (this is our own connector — it does NOT use the Granola
  MCP). Use when the user says "pull my Granola notes", "get today's meeting
  transcripts", "ingest my calls", or before running transcript-decisions /
  weekly-synthesis. Works on any Granola plan (see Auth).
kind: skill
version: 1.1.0
access: team
triggers:
  - pull granola notes
  - get my meeting transcripts
  - ingest my calls
  - granola digest
---

# Granola (direct)

Our own Granola connector — a single dependency-free Node script. It does **not**
use the Granola MCP, so behaviour is fully under our control. It is **dual-auth**:

1. **Public API** (preferred, portable) — `https://public-api.granola.ai/v1`,
   `Bearer grn_…` from `GRANOLA_API_KEY`. Requires a **Business/Enterprise** plan.
2. **Local app token** (automatic fallback, any plan, this machine only) — reuses the
   Granola desktop app's WorkOS session (`~/Library/Application Support/Granola/
   supabase.json`), self-refreshing the access token via the app's own
   `refresh-access-token` endpoint, then calling `api.granola.ai/v1/get-documents`
   and `get-document-transcript`.

The script tries the public key first and falls back to the local token on a
401/403 (or when no key is set, or with `--local`). The key/token is resolved
locally and never printed.

## How to run

```bash
node .claude/descriptors/skills/granola-direct/granola-pull.mjs \
  [--since YYYY-MM-DD] [--limit N] [--match SUBSTR] \
  [--access TIER] [--speaker NAME] [--local] [--dry-run]
```

| Flag | Effect |
|------|--------|
| `--since` | only notes created on/after this date (`created_after`) |
| `--limit` | cap how many notes are pulled (default 25) |
| `--match` | only write meetings whose **title or participants** contain SUBSTR (case-insensitive) — target one engagement without dumping everything |
| `--access` | frontmatter `access:` tier for written files (default `team`; use `private` for sensitive/prospect calls) |
| `--speaker` | label for the non-microphone party on 1:1 calls (default `Speaker`) — e.g. `--speaker "Abdul Bahri"` |
| `--local` | force the local-app-token path (skip the public API) |
| `--dry-run` | list what would be written without touching the filesystem |

Each meeting becomes one Markdown file at `1-inbox/transcripts/<date>-<slug>.md` with
frontmatter (`type: transcript`, `source: granola`, `granola_id`, `created`,
`participants`, `access`) and the transcript rendered as readable, speaker-labeled
turns (consecutive same-speaker fragments are merged).

## After pulling

Chain into `transcript-decisions` to turn the new transcripts into decision-log rows,
or `weekly-synthesis` for a digest. Promotion to the brain stays a deliberate
`aios push` — pull sensitive calls with `--access private` so they never sync.

## Connect / troubleshoot

- **Public key:** create it in the Granola desktop app — **Settings → Connectors →
  API keys → Create new key** (tick *Personal notes*; add *Public notes* for
  workspace-wide notes). Requires a Business/Enterprise plan. Put it in `.env` as
  `GRANOLA_API_KEY` (encrypt with `dotenvx set GRANOLA_API_KEY grn_…`).
- **Free/Pro plan, or 403 on the public API:** no key needed — just make sure the
  **Granola desktop app is signed in**; the script falls back to its local session
  automatically. If the local token can't refresh, open the app once to re-auth.
