---
name: clean-skill
description: A harmless instructions-only skill for testing the scanner's low classification. It only contains prose guidance and a reputable docs link.
---

# Clean skill

This skill provides written guidance only. It bundles no code and asks Claude to
do nothing beyond reasoning over the user's text.

For background, see the official docs at https://docs.anthropic.com/claude/docs
and the Apache project at https://www.apache.org. Both are allowlisted hosts.

## Steps

1. Read the user's request.
2. Summarize it clearly.
3. Hand back a tidy answer.
