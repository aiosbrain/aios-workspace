# Release readiness — cockpit overhaul (#16 / #17 / #20)

The exact, ordered steps to ship the cockpit overhaul. This is **release
hygiene**: docs + changelog + tag move together, because the website must not
document features ahead of a tagged release (root `CLAUDE.md` invariant).

> **Scope of this branch (`docs/cockpit-release-prep`).** This branch does the
> *safe prep only*: workspace docs, changelog, release notes, and **staged**
> website drafts. It does **not** tag, bump versions, run `/oss-release`, or touch
> any sibling repo. The steps marked **HUMAN-APPROVAL-REQUIRED** below are
> deliberately left for a human (or a future approved session).

## Preconditions

| # | Precondition | Status |
|---|---|---|
| 1 | **`docs/brain-api.md` unchanged** — no sync-protocol change in #16/#17/#20; contract stays **v1**, no version bump, no workspace↔brain drift | ✅ confirmed (none of the three merges touched the file) |
| 2 | Workspace docs reference the new cockpit surfaces (README, `feature-set.md` §11) | ✅ done on this branch |
| 3 | `docs/byoa.md` GUI note current (Sonnet 4.6 default / Opus 4.8 live switch, persisted to `agent_model`) | ✅ verified accurate, no change needed |
| 4 | `CHANGELOG.md` + `docs/release-notes/cockpit-overhaul.md` cover #16/#17/#20 | ✅ done on this branch |
| 5 | Website drafts staged under `docs/website-staging/` (cockpit guide + changelog) | ✅ done on this branch |
| 6 | CI green on this PR | ⏳ verify before merge |
| 7 | Website content **ported** into `aios-website` and the site builds | ☐ HUMAN — at release time |

## `/docs-sync` audit (read-only, run at monorepo root)

`/docs-sync` flags cross-repo divergence; it does **not** auto-fix. Findings from
running its audits against the current repos:

| Audit | Result |
|---|---|
| 1 — brain-api version | **PASS** — `v1` consistent: workspace contract (`/api/v1`), brain routes (`app/api/v1`), website docs (`/api/v1/items`). No drift. |
| 2 — access-tier terminology | **PASS** — canonical `admin/team/external` + friendly aliases used consistently. |
| 3 — feature completeness (workspace vs website) | **WARN (expected)** — the new cockpit surfaces (chat/model picker, Skills library, onboarding-from-a-link) are **not yet on the website**. → Resolved by porting `docs/website-staging/cockpit.mdx` + `changelog.mdx` at release time. |
| 4 — CLI command surface | No new CLI commands in #16/#17/#20 (cockpit is GUI/API); no new divergence introduced. |
| 5 — spine folder names | **PASS** — unchanged. |

The only WARN is the deliberate, expected one that this release resolves: the
website doesn't yet document the cockpit. The staged drafts close it.

## Ordered release steps

> Run these **in order**. Steps marked **HUMAN-APPROVAL-REQUIRED** must not be
> automated.

1. **Merge this PR** (`docs/cockpit-release-prep`) once CI is green. — *Adds the
   workspace docs, changelog, release notes, and staged website drafts. No tag,
   no sibling-repo change.*

2. **Re-run `/docs-sync`** at the monorepo root. Confirm the only outstanding WARN
   is Audit 3 (website missing the cockpit) — i.e. nothing unexpected drifted.

3. **Port the staged website content** into `aios-website` (per
   `docs/website-staging/README.md`): **HUMAN-APPROVAL-REQUIRED**
   - Copy `cockpit.mdx` → `aios-website/src/content/docs/guides/cockpit.mdx`.
   - Copy `changelog.mdx` → `aios-website/src/content/docs/changelog.mdx`.
   - Register both in `aios-website/astro.config.mjs` `sidebar`.
   - **Replace the screenshot placeholders** with real captures from a verified
     `npm run gui` run.
   - `astro build` and confirm the pages render and screenshots resolve.
   - Commit in **`aios-website`** (separate repo, separate PR).

4. **Re-run `/docs-sync`** — confirm **no divergence remains** (Audit 3 now PASS).

5. **Run `/oss-release`** at the monorepo root: **HUMAN-APPROVAL-REQUIRED**
   - Bumps versions, checks API-contract drift (must report **no** brain-api
     change → no bump needed), tags each repo, flags the website changelog.
   - This is the actual tag/publish step. **Do not run it until steps 1–4 are
     done and the website builds.**

6. **Post-release verification**:
   - The tag's changelog matches what actually merged for this release — verify
     against the `[Unreleased]` section (#16 + #17 + #20, **plus #22 community-skill
     scanner if it landed before the tag**), nothing more. If #22 merges first, the
     cockpit guide + website changelog must mention the community trust tier too.
   - Website is live with the cockpit guide + changelog and correct screenshots.
   - `/docs-sync` reports clean.

## Explicitly NOT done by this branch

- ❌ No tag created.
- ❌ No version bump.
- ❌ No `/oss-release` run.
- ❌ No commit into `aios-website`, `aios-team-brain`, or any sibling repo.
- ❌ No merge of this PR (left for a human).
