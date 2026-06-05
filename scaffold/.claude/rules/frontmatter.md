# Rule: Frontmatter

Markdown files carry YAML frontmatter so that humans and agents can reason about
status, ownership, and audience without reading the whole document.

## Minimum

Every non-trivial markdown file (excluding `README.md` and `CLAUDE.md`) starts with:

```yaml
---
status: draft        # draft | review | final | sent | signed
---
```

## Required fields by directory

| Directory | Required | Recommended |
|-----------|----------|-------------|
| `02-deliverables/` | `status`, `owner` | `created`, `sprint` |
| `03-status/` | — (living docs) | `updated` |
| `04-client-surface/` | `status`, `owner`, `access` | `created`, `approved_by` |
| `05-personal/*/01-intake/` | `status` | `created`, `from` |
| `05-personal/*/02-deliverables/` | `status`, `owner` | `created`, `sprint` |

## Field reference
- `status` — lifecycle: `draft → review → final → sent → signed`.
- `owner` — the single person accountable for the file.
- `access` — audience tier: `admin | team | client`.
- `created` / `updated` — ISO dates.
- `sprint` — sprint identifier when the content is sprint-scoped.

The `check-frontmatter` validator enforces presence; it does not judge values.
