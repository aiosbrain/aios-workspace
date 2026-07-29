# Spec — `aios-deck`: a reusable, brand-themeable deck builder skill

## What / Why

Ship a new workspace skill, `aios-deck`, that lets any workspace owner (or an agent acting
for them) produce a presentation-grade, single-file HTML slide deck in a chosen brand theme
without hand-writing CSS.

Why it matters: two production decks were built independently in a personal workspace and both
burned real revision rounds re-discovering the *same* layout and screenshot bugs — one over
14 rounds, one over 5. Their fixes were extracted into a loose `deck-system/` folder of CSS
that lives outside the product, has no QA gate, no scaffolding command, and no documented
brand-intake path. As a result the knowledge is unshippable: a second person cannot produce a
deck without reading a 216-line guide and hand-editing CSS.

This spec productizes that folder as a skill in `scaffold/`, hardens the CSS (fixing four
verified defects), adds the missing components, and adds the gate that does not exist today —
an automated QA script that catches the exact failures both decks hand-checked every round.

## Contract (interface, declared before implementation)

New files, all under `scaffold/.claude/skills/aios-deck/`:

| Path | Kind | Contract |
|---|---|---|
| `SKILL.md` | markdown | Frontmatter `name: aios-deck`, `description`, `version: 1.0.0`, `kind: skill`, `triggers`. Body is a 5-step blocking protocol: pick brand → read 2 examples → author → QA → render. |
| `reference/slide-catalog.md` | markdown | One section per slide type; each carries copy-pasteable markup, the classes it uses, and when NOT to use it. |
| `reference/brand-schema.md` | markdown | The brand intake form + the named-role → token mapping + derivation rules for the 13 tokens with no package source + anti-slop calibration. |
| `reference/gotchas.md` | markdown | 16 numbered Don't/Do entries, each with the reasoning that stops a revert. |
| `assets/deck-base.css` | CSS | v1.0.0. Brand-agnostic mechanics + component library. Declares a machine-readable token contract between the literal markers `/* @token-contract:begin */` and `/* @token-contract:end */`. Defines no colour or font values itself. |
| `assets/themes/aios-dark.css` | CSS | Dark product identity. Defines every `required` token. |
| `assets/themes/aios-light.css` | CSS | Light product identity (new — the design package's light mode is a third, previously unshipped palette). |
| `assets/themes/prism-light.css` | CSS | Light editorial/proposal identity. |
| `assets/themes/aios-dark.md` | markdown | Human-readable named-role card, one line per colour: `Name #hex — role`. Same for the other two themes. |
| `scripts/new-deck.mjs` | Node ESM | `node new-deck.mjs <target-dir> --theme <slug> [--slides a,b,c] [--title "..."]` → writes `deck.html`, copies `deck-base.css` + the one theme, writes `MANIFEST.md` with a revision-log stub. Exit 0 on success, 2 on usage error. |
| `scripts/qa-deck.mjs` | Node ESM | `node qa-deck.mjs <deck.html> [--out <dir>] [--json] [--strict]` → runs six checks (token contract, hardcoded colour, per-slide overflow at two viewports, progress-counter accuracy, missing `alt`, asset weight), emits per-slide PNGs + `qa-report.json`. **Exit 0 only when zero FAILs**, 1 on any FAIL, 2 on usage/IO error. |
| `scripts/deck-pdf.mjs` | Node ESM | `node deck-pdf.mjs <deck.html> [--out <file>]` → headless-Chrome print-to-PDF. Exit 0/2. |
| `examples/` | directory | Two or three complete, fully synthetic reference decks. These are the quality bar an authoring agent reads before writing anything. |

The token contract is 31 required tokens plus 2 optional. Most of them alias directly onto the `@aios-alpha/design` npm
package; 13 have no package source and carry documented derivation rules in
`reference/brand-schema.md`. One of them, `--photo-scrim-rgb`, is an RGB *triplet* consumed as
`rgba(var(--photo-scrim-rgb), 0.88)` — a hex value there silently breaks every photo slide.

Theme tokens are **inlined**, never `@import`ed from the npm package: handover decks are
emailed as `file://` folders and cannot resolve `node_modules`. Each generated theme carries a
header comment recording the pinned package version plus a source hash so the copy stays
honest and drift is detectable.

## Deps

None. No new npm dependencies. Node 22 ESM plus `node:` builtins only. The QA and PDF scripts
use an already-cached Playwright/Chromium if one resolves, and degrade to static-only checks
with an explicit warning when none does — they never install a browser.

## Scope / Deferred

**In scope:** the skill directory above; four verified fixes to the base CSS (`.shot--plain`
missing `overflow: visible`; a `@media print` block that handles only the vertical scroll axis;
ten hardcoded `border-radius` values and all hardcoded spacing where the design package already
ships `--aios-radius-*` and `--aios-space-*` scales); promotion of the components that exist
today only as per-deck one-offs (cover grid with a logo slot, vertical photo scrim, animated
terminal, people-row layout, small title variant, a table component, an option-card with a
recommended ribbon, a gradient spectrum, price/citation/textured-divider treatments, a ratio
modifier on the two-column layout, and one shared SVG chart-label class set replacing six
per-diagram style blocks); the QA gate; the scaffolding and PDF scripts; three themes; the
reference documents; the synthetic examples; and a regenerated skills catalog.

**Deferred (explicitly out of scope):**
- An HTML→pptx converter. Evaluated and rejected: the reference implementation was deleted by
  its authors after four months, and its constraints (no CSS gradients, no styling on text
  elements, web-safe fonts only, text in bare `div`s silently dropped) would destroy these
  decks. Output is single-file HTML; PDF is a print script.
- A logo/colour *upload* UI. The brand intake form in `reference/brand-schema.md` is
  deliberately designed as that future path's schema, but no UI ships here.
- Any change to the sync contract, tier model, or brain API. This skill writes local files only.

## Build-with

opus / high effort.

## Acceptance criteria

- [ ] `validation/validate-all.sh <workspace>` exits 0 for a workspace scaffolded with
      `--context consultant`, again for `--context employee`, and again for
      `--context business-owner`.
- [ ] `node scripts/gen-catalog.mjs` regenerates `scaffold/.claude/skills/INDEX.md` and the
      new skill appears in it; the file is not hand-edited.
- [ ] Scaffold a throwaway workspace, run `node .claude/skills/aios-deck/scripts/new-deck.mjs`
      inside it, and the emitted deck opens and renders themed with **zero** manual CSS edits.
- [ ] `node scripts/qa-deck.mjs <emitted-deck>` exits 0 on a good deck, and exits 1 on a deck
      with a deliberately omitted required token, a wrong progress counter, or a missing `alt`.
- [ ] `grep -rn "overflow: visible" assets/deck-base.css` matches inside the `.shot--plain`
      rule (regression guard for the verified defect).
- [ ] `grep -c "@token-contract" assets/deck-base.css` returns 2 (the begin and end markers the
      QA parser depends on).
- [ ] No hardcoded hex appears in `assets/deck-base.css` outside a comment, and the only
      literal `rgba()` values are the two neutral shadows over a photo scrim (black text-shadow,
      white numeral ring) — neither is a brand decision, and both are the shape `qa-deck.mjs`
      check (b) allowlists.
- [ ] `grep -ri` over the branch finds no client name and no content sourced from a private
      business folder. This repo is public.

## Integration points

- `scaffold/.claude/skills/` — the new skill directory is added here; the whole directory is
  already copied wholesale by the existing scaffold step, so no manifest edit is required.
- `scripts/toolkit-manifest.mjs` — verify the existing `{ dest: ".claude/skills", src:
  "scaffold/.claude/skills", kind: "dir" }` entry already covers the addition; no change
  expected, but the lockstep parity test with `scripts/scaffold-project.sh` must still pass.
- `scripts/gen-catalog.mjs` — regenerates the generated catalog; never hand-edit the catalog.
- `validation/validate-all.sh` — the done gate, run against all three contexts.
- `docs/design-system.md` — the existing design-system doc; the inlining trade-off is recorded
  against it.
- `examples/` — the repo's existing synthetic sample workspace convention ("use it; never put
  real data here") governs the reference decks.

## Tier safety

Not applicable to the sync boundary: this skill reads and writes local files only and adds no
new sync surface, no brain API call, and no new item kind. The one governance-relevant fact is
directional — all source material was read from a private workspace and this repo is public, so
every shipped example, screenshot, name, and number is synthetic. The acceptance criteria
include an explicit scan for leaked identifiers before the branch is pushed.
