---
description: Draft an email in the workspace owner's voice. Draft only — never auto-send.
---

Draft an email in the workspace owner's voice. Draft only — never auto-send.

**Arguments:** $ARGUMENTS

## Steps

1. Load `.claude/rules/communications.md` and the voice/style skill if available.
2. Resolve recipient from workspace contacts or entity files — never fabricate addresses.
3. Write the draft with correct frontmatter (`access`, `status: draft`, `to`, `subject`).
4. Save under `2-work/` or `1-inbox/` as appropriate.
5. Present the draft and **stop**. External sends require explicit owner approval.

The outbound comms guard (Claude hook / OpenCode instincts plugin) blocks unsafe sends.
