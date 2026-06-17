---
description: Stamp a throwaway workspace (both contexts) to manually verify template changes
argument-hint: [consultant|employee|both]
---

Scaffold one or more throwaway workspaces in a temp dir to verify a change to `scaffold/`.
Template/product behavior lives in `scaffold/`, so changes must be checked against a freshly
stamped workspace — and must hold for BOTH contexts.

For each requested context (default: both):

```bash
scripts/scaffold-project.sh --context consultant \
  --slug sandbox-consultant --stakeholder "Acme Corp" --owner alex --team "alex,sam,jordan"
scripts/scaffold-project.sh --context employee \
  --slug sandbox-employee --owner alex --team "alex,sam,jordan"
```

Then run `/validate <path>` on each stamped workspace and confirm the spine, frontmatter
defaults, access tiers, and `.claude/` (rules/skills/rubrics) came through. Scaffold into a
temp/gitignored location — never commit a stamped sandbox.
