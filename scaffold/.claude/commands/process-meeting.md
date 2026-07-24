Process a meeting transcript — save, analyze, extract actions.

**Arguments:** $ARGUMENTS

Parse arguments for:
- `transcript_path` — file path or `latest` (most recent `.md` in `1-inbox/transcripts/`)
- `type` — `transcript` or `agenda` (default: transcript)

## Steps

1. Locate the transcript in `1-inbox/transcripts/` (or path given).
2. Add frontmatter if missing: `access`, `date`, `attendees`, `type`.
3. Rename to `YYYY-MM-DD-<topic>-transcript.md` if needed.
4. For transcripts: write analysis to `2-work/` with key insights, gaps, and action items.
5. Offer to review decisions and tasks with the typed transcript CLI — the `transcript-decisions` skill runs `aios transcripts draft|list|approve` (grounded decisions **and** explicit tasks staged in a private V2 owner-review record, one approval gate before either log changes; approval then attempts `aios push` unless `--no-push`).
6. Summarize: saved paths, top action items, any access-tier flags.

Follow `.claude/rules/access-control.md`. Never promote admin-only content to team paths.
