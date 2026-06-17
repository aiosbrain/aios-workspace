# Plan — Cockpit docs + changelog + release

> Status: **plan**. This is release hygiene for the cockpit features shipped in #16
> + #17. Per the monorepo invariant, **public docs land *with* a tagged release**, not
> before — so this is one coordinated pass, driven by the root cross-cutting skills.

## Context

#16 (model picker, resumable sessions, context meter, markdown, personality) and #17
(Skills library) added significant, user-facing cockpit capability that is **not yet
documented** on the public site. The website must not document features ahead of a
tagged release (root `CLAUDE.md` invariant), so docs + changelog + tag move together.

## Scope

In **`aios-workspace`** (this repo):
- `docs/byoa.md` already notes the model behavior; confirm it's current.
- Ensure `README` / getting-started references the cockpit's new surfaces (Model
  picker, Chats, Skills, Settings/personality) at a high level.

In **`aios-website`** (Astro + Starlight, sibling repo):
- **Getting-started / cockpit page:** document the chat (model picker Sonnet 4.6 /
  Opus 4.8, in-session switch, context meter, markdown, resumable chat history),
  **Skills** (install official Apache-2.0 skills; document skills are Anthropic-hosted
  pointers), and **personality** presets. Screenshots from the verified runs.
- **Changelog:** entries for the cockpit overhaul (#16) and Skills library (#17).
- Keep claims to what's in the tagged release.

## Invariant check (do first)
- **`brain-api.md` is unchanged** by this work — none of #16/#17 touched the sync
  protocol — so no version bump and no brain/website contract drift. Confirm before
  release.

## Execution (use the root skills, don't hand-roll)
1. **`/docs-sync`** at the monorepo root — audit brain-api.md version + feature-set vs
   website copy; it flags exactly what's stale/missing. Use its output as the doc TODO.
2. Write the website docs + changelog entries against that TODO (Starlight content).
3. **`/oss-release`** — bumps versions, checks API-contract drift, tags each repo,
   flags the website changelog. Run when the docs are ready so everything tags together.

## Verification
- `/docs-sync` reports no divergence after the docs land.
- Website builds (Astro) and the new pages render with correct screenshots.
- The tag's changelog matches what actually shipped (#16 + #17), nothing more.

## Out of scope
- Marketing copy / launch assets — separate effort.
- Documenting the not-yet-built onboarding-enrichment and untrusted-install features
  (those document with *their* releases).
