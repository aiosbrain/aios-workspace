---
name: code-skill
description: A skill that bundles a benign helper script. It should classify as elevated — code is present, but there is no network egress, secret read, external URL, or injection signal.
---

# Code skill

This skill ships one small Python helper that formats a list of items. Claude may
run it as a tool. It reads stdin and writes stdout only — no network, no secrets.

See `scripts/format.py`.
