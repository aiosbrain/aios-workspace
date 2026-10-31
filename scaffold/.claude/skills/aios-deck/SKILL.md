---
name: aios-deck
description: |
  Build a presentation-grade, brand-themeable HTML slide deck — demo, proposal,
  update, or pitch — from a pre-debugged component library instead of a blank
  page. New decks default to an editorial design layer (generous type, margins
  and spacing). Ships three themes, a slide catalog with copy-pasteable markup, a brand
  intake schema for adding your own colours and logo, complete reference decks,
  and an automated QA gate that catches the layout and screenshot bugs two
  production decks each rediscovered from scratch. Output is one self-contained
  HTML folder plus a print-to-PDF script — never PowerPoint.
version: 1.1.0
kind: skill
triggers:
  - build a deck
  - make a slide deck
  - presentation deck
  - demo deck
  - proposal deck
  - pitch deck
  - HTML slides
  - deck theme
  - QA this deck
  - export the deck to PDF
---

# aios-deck — build a deck that doesn't need five revision rounds

This skill exists because two production decks were built independently and
**both** burned real revision rounds rediscovering the same layout, screenshot
and export bugs — one over 14 rounds, one over 5. Everything those rounds proved
is baked in here as a **default**, not an opt-in flag.

## Editorial is the default

Every new deck links **`assets/editorial.css`** after the theme and starts from
editorial (`ed-`) markup. `--classic` opts out.

Why: the original default (`deck-base.css` + a theme, nothing else) produced
decks that looked dense and unfinished. Body copy sat at caption size, layouts
were cramped with no vertical balance, callouts ran as full-width strips, and
every heading carried an eyebrow label above it. A client deck rebuilt on a
deck-local editorial layer was judged a large step up in color, styling,
spacing and typography, so that layer is now the shipped default:

- **Type you can read from the back of a room.** Body copy never drops below
  17px at 1440 wide, captions never below 15px.
- **Real margins.** 7vw x 8.5vh, so content sits in a balanced composition.
- **Cards, pills, numbers and steps** instead of strips, eyebrows and bullets.
- **A two-voice color pair** (`--ed-voice-a` / `--ed-voice-b`) for any argument
  with two actors (people and AI, client and vendor, today and target).

Every editorial color is derived from the theme's token contract, so the layer
works on all three shipped themes, light and dark, and on any brand you add
through `reference/brand-schema.md`. Use `--classic` only when you need the
classic look on purpose, or a classic-only slide type (table, spectrum,
terminal, live demo) as the backbone of the deck. Classic components still
render inside an editorial deck, because `deck-base.css` is always loaded.

---

Your job is to follow the protocol below. It is deliberately blocking at step 1
and step 4. Do not skip either.

---

## The protocol

### Step 1 — Pick the brand. BLOCK here.

Ask which theme, and wait for an answer. **Do not silently default to a theme.**

| Slug | Mode | Use for |
|---|---|---|
| `aios-dark` | dark | Product demos, architecture, roadmap, internal. Presented on a screen you control. |
| `aios-light` | light | The same product material for a bright room, a projector, a printer, or embedding in a light document. |
| `prism-light` | light | Proposals, engagement plans, board updates — anything read as much as presented. |
| *(your own)* | — | A client's or a company's own brand. See below. |

Read the theme's role card (`assets/themes/<slug>.md`) before you write a slide.
Each one states a **rationing rule** — the single restraint that keeps the theme
from looking generic. Respect it.

**Adding a new brand:** follow `reference/brand-schema.md`. It carries the intake
form (4-6 named colours with semantic roles, three typefaces, a logo slot, a
layout concept, one signature element), the mapping onto the token contract,
explicit derivation rules for the 13 tokens that have no package source, and an
anti-slop calibration naming the looks that read as an unchosen AI default.
That intake form is deliberately the schema a future logo-and-colours upload
path would use — treat it as an interface, not a worksheet.

### Step 2 — Read two complete examples. BEFORE writing anything.

```
examples/editorial-proposal/deck.html   ← a 15-slide proposal, the DEFAULT editorial look
examples/product-demo-dark/deck.html    ← a 10-slide product demo, dark, classic
examples/proposal-light/deck.html       ← a 13-slide proposal, light, classic
```

Always read `editorial-proposal` unless you passed `--classic`. These are the quality bar. Prose rules do not calibrate an authoring agent;
complete examples do. Read the one closest to what you are building, plus one
other, before you write a slide. Everything in them is fictional — they are
synthetic samples, never a source of facts.

### Step 3 — Author.

**Scaffold first:**

```bash
node scripts/new-deck.mjs <target-dir> --theme <slug> --title "..." \
  [--slides cover,statement,content,two-voice,steps,timeline,options,team,close] \
  [--horizontal] [--classic]
```

It writes `deck.html`, copies `deck-base.css` + the one theme +
`editorial.css` + `deck-nav.js` into the folder, and seeds a `MANIFEST.md` with
a revision-log stub. With `--classic` it skips `editorial.css` and uses the
classic slide set. Run `--list-slides` (with or without `--classic`) and
`--list-themes` to see the options.

Then replace the content, one slide at a time, using
**`reference/slide-catalog.md`**: its **Editorial layer** section is the parts
list for the default look (every `ed-` component, copy-pasteable, each with a
note on when *not* to use it), and the numbered sections cover the 19 classic
slide types. Do not invent classes. If nothing fits, the answer is almost always
an `.ed-split` (or a classic `.two-col`) holding a different pair of existing
components.

In an editorial deck, read the editorial anti-patterns in
`reference/gotchas.md` (entries 18-23) before you write a slide: no full-width
callout strips, no eyebrow-plus-heading pairs, nothing below about 15px, no
tiny bullets, one heading per slide, and vertical balance.

Read **`reference/gotchas.md`** before you touch `.shot`, `.two-col`,
`.photo-slide`, an inline `<svg>`, or the `@media print` block. Those defaults
are the fixed versions of real bugs; several of the "obvious" values are the
broken ones.

Three rules that are easy to get wrong:

1. **Never put a literal colour inside an SVG.** Use `.svg-label` / `.svg-tick` /
   `.svg-cap` / `.svg-num` / `.svg-box` / `.svg-rule`. A hardcoded fill renders
   invisible the moment the theme swaps.
2. **Never add a `<style>` block to a deck.** If a slide overflows, cut copy or
   split the slide. Adding CSS forks the system. (Inline custom properties the
   catalog documents, such as `--ed-grid-cols` or `--ed-track-n`, are fine.)
3. **The deck folder must be self-contained.** It is emailed and opened from
   `file://`. Nothing may reference a path outside the folder, and nothing may
   resolve through `node_modules`.

### Step 4 — QA. BLOCK here. This gate is not optional.

```bash
node scripts/qa-deck.mjs <deck.html>          # exit 0 = clean
node scripts/qa-deck.mjs <deck.html> --strict # promotes warnings to failures
```

Six checks, all of which were previously hand-done every revision round:

| | Check | Why |
|---|---|---|
| a | Theme-token contract — completeness **and shape** | An omitted token fails **silently** (the base ships no fallback colours, so you get invisible text and no error). So does a *malformed* one: `--photo-scrim-rgb` is consumed inside `rgba()` and must be a bare triplet, so a hex there kills every photo slide while still counting as "defined". |
| b | Hardcoded hex/rgb outside `:root` | The thing that breaks a theme swap. |
| c | Per-slide overflow at 1280x720 **and** 1440x810 | Both source decks hand-checked this every round. A slide that fits at 1440 can overflow at 1280. |
| d | Progress counter vs real slide count | Both source decks shipped a hardcoded wrong count. |
| e | Missing `alt` attributes | — |
| f | Total asset weight | One source deck carried ~11 MB for 10 slides. |

It also writes per-slide PNGs — **look at them.** Exit 0 or the deck is not done.

> **Browser dependency:** check (c) and the screenshots need Playwright or
> Puppeteer to resolve from somewhere. If neither does, the script runs
> **static-only**: it still gates on checks (a), (b), (d), (e), (f), and it warns
> loudly on stderr with `"browser": "unavailable"` in the JSON report. Never
> report overflow as verified when the run degraded — say it skipped.

Record each QA run in the deck's `MANIFEST.md` revision log. That log is what
makes the next round cheap.

### Step 5 — Render.

```bash
node scripts/deck-pdf.mjs <deck.html> [--out deck.pdf]
```

Headless-Chrome print-to-PDF (or Playwright's `page.pdf` when available),
landscape, backgrounds on. The `@media print` block in `deck-base.css` handles
both vertical and horizontal decks.

**Do not reach for the workspace's markdown-to-PDF helper.** It is
markdown-input-only and its renderer executes no JavaScript and supports neither
`color-mix()`, `scroll-snap`, nor `aspect-ratio` — all of which these decks
depend on.

---

## What this skill deliberately does not do

**It does not produce PowerPoint.** This was evaluated and rejected, not
overlooked. The reference HTML→pptx converter was deleted by its own authors
after four months, and its constraints — no CSS gradients, no styling on text
elements, web-safe fonts only, and text in a bare `<div>` silently dropped —
would destroy every deck this system makes. The gradient accent bar, the
gradient list markers, the gradient step numerals and the display typeface are
all load-bearing. Output is single-file HTML; PDF is the portable format. If
someone genuinely needs a `.pptx`, the honest answer is to rebuild it natively
in that tool, not to machine-translate it.

---

## Files

| Path | What |
|---|---|
| `reference/slide-catalog.md` | The editorial layer's components, then 19 classic slide types, copy-pasteable markup, the deck shell, density guidance, the full class index. **Start here when authoring.** |
| `reference/brand-schema.md` | Brand intake form, token mapping, derivation rules, anti-slop calibration, contrast gates. **Start here when theming.** |
| `reference/gotchas.md` | Don't/Do entries (including the editorial anti-patterns) with the reasoning that stops someone reverting a fix. |
| `assets/editorial.css` | v1.0.0. The default design layer: `ed-` type scale, margins and components. Linked after the theme. Every color derived from theme tokens. |
| `scripts/editorial-slides.mjs` | The editorial starter slides `new-deck.mjs` emits by default. |
| `assets/deck-base.css` | v1.0.0. Brand-agnostic mechanics + component library. Declares the token contract between `@token-contract:begin/end` markers. Defines no colour or font value itself. |
| `assets/themes/*.css` + `*.md` | Three themes, each with a machine file and a human role card. |
| `assets/deck-nav.js` | Arrow-key navigation + live progress counter. No click-to-advance, deliberately. |
| `scripts/new-deck.mjs` | Scaffold a deck folder from a theme + slide list. |
| `scripts/qa-deck.mjs` | The gate. Exit 0 or it isn't done. |
| `scripts/deck-pdf.mjs` | Print-to-PDF. |
| `examples/` | Three complete reference decks (one editorial, two classic). Fully synthetic — never a source of facts. |

## Extending it

A component earns a place in `deck-base.css` (or, for the editorial look,
`editorial.css`) once a **second** deck needs it.
Until then list it under "Unvalidated components" at the end of
`reference/slide-catalog.md`. A gotcha earns a place in `reference/gotchas.md`
once it has cost a real debugging round **and** its fix is a default in the base
CSS — the entry exists so nobody reverts the default by accident.
