---
description: Sanitize private meeting notes and publish a team-safe summary.
status: active
---

Sanitize private meeting notes and publish a team-safe summary.

**Arguments:** $ARGUMENTS (path to source meeting file)

## Steps

1. Read the source file. If already `access: team`, confirm with the owner before republishing.
2. Build a role-name mapping (names → roles). Show the mapping for review.
3. Generate a team-safe version: no verbatim quotes, no pricing, no psychological assessments.
4. Save to `4-shared/` with `access: team` (or outward tier per context).
5. Run workspace validators on the output before any brain push.
6. Summarize: source path, destination path, replacements made, content removed.

Never modify the original private file. Follow `.claude/rules/publishing.md`.
