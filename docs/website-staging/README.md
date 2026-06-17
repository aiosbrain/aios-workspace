# Website staging — drafts to port into `aios-website`

These are **drafts only**. They are written to be copied into the sibling
**`aios-website`** repo (Astro + Starlight) during the release. **Nothing here is
committed into that sibling repo by this branch** — porting is a deliberate,
human-approved step in [`../release-readiness.md`](../release-readiness.md).

Per the monorepo invariant, **public docs land *with* a tagged release**, not
ahead of one. Do not port these until `/oss-release` is ready to run.

## Files and their suggested destinations

| Draft file | Suggested page in `aios-website` | Sidebar |
|---|---|---|
| [`cockpit.mdx`](./cockpit.mdx) | `src/content/docs/guides/cockpit.mdx` (slug `guides/cockpit`) | **Guides** → "The Cockpit" |
| [`changelog.mdx`](./changelog.mdx) | `src/content/docs/changelog.mdx` (slug `changelog`) | top-level "Changelog" (new) |

## Porting steps (do at release time)

1. Copy `cockpit.mdx` → `aios-website/src/content/docs/guides/cockpit.mdx`.
2. Copy `changelog.mdx` → `aios-website/src/content/docs/changelog.mdx`.
3. Register both in `aios-website/astro.config.mjs` `sidebar`:
   - Under the existing **Guides** group, add
     `{ label: 'The Cockpit', slug: 'guides/cockpit' }` (after "Your Workspace").
   - Add a top-level `{ label: 'Changelog', slug: 'changelog' }` entry.
4. **Replace the screenshot placeholders** in `cockpit.mdx` with real captures
   from a verified `npm run gui` run (model picker, Chats sidebar, Settings →
   Personality, Skills tab, onboarding "draft from a link").
5. Build the site (`npm run build` / `astro build`) and confirm the new pages
   render and the screenshots resolve.
6. Re-run `/docs-sync` at the monorepo root to confirm no divergence remains.

## Accuracy guardrails

- Claims are kept to **what shipped** in #16 / #17 / #20. Do not add features that
  aren't in the tagged release.
- The **brain-api / sync contract is unchanged (v1)** — these pages must not imply
  any protocol change.
- Document skills (Word/Excel/PowerPoint/PDF) are **pointers** ("Enable in
  Claude"), not installable here — keep that distinction intact.
