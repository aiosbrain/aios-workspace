# ARCH3 — Cross-repo seam review (workspace/brain/website)

Owner: john@john-ellison.com  
Parent: Pre-release architecture epic.

## Why

Three-repo seams must be documented before public ship.

## What

Produce a review document `docs/pre-ship/arch3-cross-repo-seams-review.md` that details the seams between
the aios workspace, brain, and website repositories.

The document **must itself be a valid spec/plan** so that it passes the project’s spec-readiness
checker. It must contain:

- A **Why** (the purpose of this seam review).
- A **What** describing the seams.
- A **Seam table** with the exact columns defined below.
- **Acceptance criteria** for the review (e.g., table present, eval passes).
- **Integration points** that reference real files in this workspace.
- **Deps / Scope / Build-with / Tier-safety** sections (these may be concise and inherited from
  this parent spec where applicable).
- **Testability** statement.

### Repository names

The following canonical repository names are used in the seam table. The builder must use exactly
these names when populating the **Source (repo / path)** and **Target (repo / path)** columns.

- `aios` — the workspace containing this spec (the Git repository where this file lives).
- `brain` — the brain API backend.
- `website` — the public documentation site.

The design-tokens npm package (`@aios-alpha/design`) is maintained in the `aios` repository;
`brain` and `website` are its consumers.

### Seam table schema

The table must be under a `## Seam table` heading. Columns:

| Column | Description |
|--------|-------------|
| **Seam name** | Short label for the cross-repo boundary. |
| **Source (repo / path)** | Repo (exactly `aios`, `brain`, or `website`) and key file(s) that initiate the exchange. |
| **Target (repo / path)** | Repo and key file(s) that respond or provide the data. |
| **Direction** | `→` for push, `←` for pull, `↔` for bidirectional. |
| **Protocol / interface** | Mechanism used (e.g., `fetch` over HTTP, npm package import, JSON schema contract). |
| **Tier restrictions** | Which tiers (`admin`, `team`, `external`) are allowed or denied; default-deny on missing `access:`. For brain API, note that `admin` at root-level resources is rejected with `422`. |
| **Error handling** | Expected failure modes and recovery (e.g., retry, fallback, user-visible error). |
| **Notes** | Any additional context (e.g., future plans, known gaps). |

### Minimum rows

The table **must contain at least one row** for each seam. The builder must produce the following
three rows.  Repository names and directions are **fixed** as shown below; cells that can be
determined from the `aios` workspace alone must be filled with that concrete information.  For
cells that depend on external repositories (`brain`, `website`) **and** cannot be deduced from
files already present in `aios`, the builder inserts a clear placeholder of the form
`[NEEDS brain REPO]` or `[NEEDS website REPO]` (or both as appropriate).  Every cell must be
non‑empty (placeholders count as non‑empty).

| Seam name | Source (repo / path) | Target (repo / path) | Direction | Protocol / interface | Tier restrictions | Error handling | Notes |
|-----------|----------------------|----------------------|-----------|----------------------|-------------------|----------------|-------|
| Workspace ↔ brain sync | `aios` (paths: `scripts/aios.mjs`, `scripts/brain-client.mjs`) | `brain` (the sync API endpoint implementation) | ↔ | HTTP fetch (JSON), client in `scripts/brain-client.mjs` | admin/team tiers allowed; root‑level admin rejected with 422 (per `docs/brain-api.md`) | (builder completes from workspace docs or `[NEEDS brain REPO]`) | (builder completes from workspace docs or placeholder) |
| Docs alignment | `aios` (`docs/brain-api.md`) | `website` (the documentation ingestion pipeline) | → | (builder fills from workspace knowledge or `[NEEDS website REPO]`) | none (public docs) – builder confirms or placeholders | (builder completes or placeholder) | (notes per builder) |
| Design tokens | `aios` (the design token source files – builder must identify the exact path, e.g., under `packages/design`) | `brain` and `website` (consume via `@aios-alpha/design` npm package) | → | npm package import, versioned | no tier restrictions – design tokens are public | `[NEEDS brain/website REPO]` for consumer‑side handling | known gap: versioning strategy TBD |

The builder is responsible for filling columns with accurate values based on the `aios` workspace
(including `scripts/brain-client.mjs`, `docs/brain-api.md`, design‑token source path) and for
inserting the specified placeholders where external‑repo knowledge is required.

## Acceptance criteria

- `docs/pre-ship/arch3-cross-repo-seams-review.md` exists.
- The file contains a `## Seam table` heading and a markdown table with the eight columns listed
  above.
- The table has exactly one row for each of the three mandatory seams (workspace ↔ brain sync,
  docs alignment, design tokens) using the canonical repository names (`aios`, `brain`, `website`).
- **Every cell in those rows contains non‑empty text.**  Placeholders like `[NEEDS brain REPO]` are
  acceptable where the builder cannot obtain information from the `aios` workspace alone.
- Running `npm run aios -- spec eval docs/pre-ship/arch3-cross-repo-seams-review.md` exits with code **0**,
  indicating the document meets the spec-readiness contract.
- The table documents tier-safety: admin/team/external tiers, default-deny when `access:` is absent,
  and the brain’s `422` for admin access at root-level resources (this information is present in the
  workspace and reflected in the relevant row).

## Builder vs operator closure

- **Builder delivers:** file `docs/pre-ship/arch3-cross-repo-seams-review.md` structured as a spec/plan
  that passes `spec eval`. The file is committed to the `aios` workspace.  Placeholders are accepted
  for information that requires external repositories; the spec-readiness checker treats them as
  non‑empty.
- **Operator verifies:** run `npm run aios -- spec eval docs/pre-ship/arch3-cross-repo-seams-review.md` —
  exit 0 confirms readiness. Optional: review table rows for correctness, replace placeholders when
  external repos become available.

## Optional follow-up

- Cross-repo doc PRs filed as separate Linear children — not blocking ARCH3.

## Integration points

The following existing files in this workspace are the primary integration surfaces referenced in
the seam table’s `aios` rows:

- `scripts/aios.mjs`
- `scripts/brain-client.mjs`
- `docs/brain-api.md`

(These are real files in the `aios` repository and resolve correctly.)

## Deps

Deps: none.

## Scope

Read-only documentation. In scope: producing the seam table file with the three mandatory rows,
populated with either workspace‑available data or placeholders for external repos.  
Out of scope: monorepo merge, cross-repo pull requests, behavior changes to sync or brain.

## Build-with

Build-with: sonnet / medium.

## Tier-safety

This slice is a read-only review — it does **not** modify sync behavior or tier policy.

The seam table must record that:

- Workspace ↔ brain sync respects `admin`/`team`/`external` tiers.
- Default-deny applies when the `access:` property is missing.
- The brain API rejects `admin` at root-level resources with HTTP **422**.
- No tier logic is changed by this code path.

The builder must reflect these facts in the Tier restrictions column of the relevant row.  All
required tier information is available from the `aios` workspace (e.g., `docs/brain-api.md`).

## New files to create

- `docs/pre-ship/arch3-cross-repo-seams-review.md` — seam table review doc (separate from this spec file).

## Testability

Named acceptance test (run from repo root; `REVIEW=docs/pre-ship/arch3-cross-repo-seams-review.md`):

```bash
REVIEW=docs/pre-ship/arch3-cross-repo-seams-review.md
test -f "$REVIEW" && \
grep -q '^## Seam table' "$REVIEW" && \
grep -qE '^\| Workspace ↔ brain sync \|' "$REVIEW" && \
grep -qE '^\| Docs alignment \|' "$REVIEW" && \
grep -qE '^\| Design tokens \|' "$REVIEW"
```

Exit **0** proves the review doc exists with the mandatory seam rows.  The spec‑conformance check
(`npm run aios -- spec eval docs/pre-ship/arch3-cross-repo-seams-review.md`) ensures the document
is a valid spec; the placeholder‑friendly cell completion is verified by manual review of the table.