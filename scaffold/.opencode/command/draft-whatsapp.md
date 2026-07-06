---
description: Draft a WhatsApp message in the workspace owner's voice. Draft only — never auto-send.
status: active
---

Draft a WhatsApp message in the workspace owner's voice. Draft only — never auto-send.

**Arguments:** $ARGUMENTS

## Steps

1. Load `.claude/rules/communications.md` for tone and approval gates.
2. Resolve the recipient from known contacts — ask if unknown.
3. Draft a short message; scan for policy violations (secrets, unapproved external sends).
4. Present the draft and **stop** unless the owner explicitly authorizes send.

Use connected WhatsApp tooling only when configured in `.claude/integrations.json`.
