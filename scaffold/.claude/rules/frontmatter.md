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
| `2-work/` | `status`, `owner` | `type`, `created`, `sprint` |
| `3-log/` | — (living docs) | `type`, `updated` |
| `4-shared/` | `status`, `owner`, `access` | `type`, `created`, `approved_by` |
| `5-personal/` | `status` | `created`, `from` |
| `*/index.md` | `type`, `access` | — |

(Legacy clones using `02-deliverables/`, `03-status/`, `04-client-surface/`,
`05-personal/*/` still validate — the checker accepts both spines.)

## Field reference
- `status` — lifecycle: `draft → review → final → sent → signed`.
- `owner` — the single person accountable for the file.
- `access` — audience tier. Friendly labels: `private | team | client` (consultant)
  or `private | team | company` (employee). These map to the engine's canonical
  tiers `admin | team | external` — `private→admin` (never syncs),
  `client`/`company`/`external`→external. Untagged content never syncs.
- `created` / `updated` — ISO dates.
- `sprint` — sprint identifier when the content is sprint-scoped.
- `type` — OKF document type (see OKF alignment section below). Recommended on all content files; required on `index.md` navigation files.
- `tags` — optional YAML list for cross-cutting categorization, e.g. `[governance, sprint-1]`.
- `resource` — optional URI linking to the canonical external source (meeting recording, ticket, etc.).

The `check-frontmatter` validator enforces `status`, `owner`, and `access` presence
by directory. It does not enforce `type` — run `AIOS_OKF_LINT=1 ./validation/check-frontmatter.sh <repo>` to get advisory notices on files missing `type:`.

## OKF alignment (Open Knowledge Format)

This repo's frontmatter is OKF v0.1-conformant. Field mapping:

| OKF field | This repo's field | Notes |
|-----------|-------------------|-------|
| `type` | `type` | Recommended; inferred from path by `aios export-okf` if absent |
| `title` | First `# Heading` in body | OKF consumers read the H1 heading |
| `timestamp` | `updated` | No rename needed; use ISO 8601 |
| `description` | `description` | Optional one-line summary |
| `tags` | `tags` | Optional list |
| `resource` | `resource` | Optional URI to the canonical source asset |

### `type` values by content path

| Path pattern | OKF `type` |
|---|---|
| `2-work/` | `"Deliverable"` |
| `1-inbox/transcripts/` | `"Transcript"` (lowercase `transcript` also accepted for back-compat) |
| `3-log/decision-log.md` | `"Decision Log"` |
| `3-log/tasks.md` | `"Task List"` |
| `3-log/*-ledger.md` | `"Sprint Ledger"` |
| `0-context/scope-baseline.md`, `scope-ledger.md` | `"Scope"` |
| `4-shared/` | `"Deliverable"` |
| `*/index.md` | `"index"` |

(Legacy path patterns — `02-deliverables/`, `01-intake/`, `03-status/`, `00-*/`,
`04-*/` — are still recognized by `aios export-okf`.)

Add `type:` when creating new files. Existing files without `type:` remain valid —
the validator does not require it. `aios export-okf` infers `type` from path when absent.

## OKF navigation fields

`index.md` files in each spine directory serve as the agent navigation layer.
They carry:
- `type: index` — marks the file as a navigation index, not a content deliverable.
- `access: team` — default tier for navigation documents.

`index.md` files are excluded from the `status:` requirement enforced by OGR02.
