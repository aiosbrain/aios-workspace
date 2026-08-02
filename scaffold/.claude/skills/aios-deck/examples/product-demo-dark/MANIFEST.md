---
status: final
owner: example
access: team
created: 2026-07-29
type: "Deliverable"
---

# Tideline — product demo

**Deck:** `deck.html` · **Theme:** `aios-dark` · **Slides:** 10 ·
**Deck id:** `tideline-product-demo` · **Kind:** Demo (catalog target: 8–12)

A ten-minute product walkthrough. Northwind Labs shows Tideline, a shipment
exception triage tool, to an operations team that currently runs its exception
desk out of a shared spreadsheet. The argument is one sentence long — *ranking
is the product* — and every slide either sets it up, proves it, or asks for the
pilot.

## Slides

| # | Type key | Purpose |
|---|---|---|
| 1 | `cover` | Three-column cover over a gradient photo: logo, headline, hero product shot. The right column stays empty so the photo reads through the scrim falloff. |
| 2 | `statement` | The thesis in one sentence: exception handling is a queue problem, not a data problem. |
| 3 | `content` (`ul.clean`) | The problem, argued in four named points — four feeds, alerts that fire on movement, priority by volume, nothing surviving the shift. |
| 4 | `two-col` | Before and after, two `.shot--col` screenshots sized by the same dimension so they match. `ul.tight` for today's failures, `ul.check-list` for what replaces them. |
| 5 | `diagram` | Inline SVG: ingest, score, resolve, plus the nightly feedback loop. Themed entirely through `.svg-*` classes — no literal colour anywhere inside the SVG. |
| 6 | `terminal` | `.two-col--wide-right` with the case for a CLI on the left and a `.term` transcript on the right. |
| 7 | `demo` | `.demo-frame` live-demo placeholder with a three-thumbnail `.thumb-row`, so a failed demo still leaves something on screen. |
| 8 | `stats` | A `.stats-row` of three tiles, then two `.quote`s — the second in the `--accent-blue` variant as a contrasting voice. |
| 9 | `people-duo` | 2-up bios: `.slide-people` + `.people-wrap` + `.people-grid--duo` + `.person-card--row`. |
| 10 | `close` | `.close-slide` vertical scrim, one lime `.cta-btn`, one `.mission-line`. |

## Everything here is fictional

Northwind Labs, Tideline, A. Rivera, B. Okafor, D. Mensah, C. Lindqvist, the
carriers (ACME Freight, Borea Logistics, Kestrel Lines, Meridian Air, Solent
Bulk), every lane, reference number, risk score, pilot figure and quote, the
logo, and every screenshot are **invented for this example**. No real company,
person, product, price or customer appears anywhere in this deck.

## Theme notes

- **Lime is rationed.** One *filled* lime element per slide at most: the
  `.live-dot` on slide 7, the `.cta-btn` on slide 10. Lime elsewhere is text
  only (the eyebrow colour, `.term__prompt`, `ul.check-list` ticks).
- **Instrument Serif has no true bold axis** — no `<strong>` inside a
  `.slide-title`, and `--weight-display: 400` is left alone.
- Screenshots are the hero; the type stays quiet around them.

## Assets

No binary files. Ten images, all inline `data:image/svg+xml;utf8,…` URIs: a
product dashboard, a "before" spreadsheet, a decision queue, a rules editor, a
partner-feed health view, two abstract geometric portraits, two logo lockups,
and two gradient "photos" (cover and close, the latter via
`--photo-bg-image`). Total folder weight is under 150 KB.

## Revision log

| Round | Date | Change | QA result |
|---|---|---|---|
| 1 | 2026-07-29 | First build: 10 slides, `aios-dark`, all imagery as inline SVG data URIs. | `qa-deck.mjs` PASS (0 fail). Overflow verified at 1280x720 and 1440x810 with a real browser. |
| 2 | 2026-07-29 | Fixed two data-URI encoding bugs found by looking at the render: the rules-editor SVG carried `<`/`>` inside text nodes (broke XML, image failed to load), and the CSS-embedded gradient photos were terminated by their own `'` (cover and close lost their background entirely). Brightened both photos so colour actually reads through the scrim. Removed em dashes from body copy. | `qa-deck.mjs` PASS (0 fail), overflow re-verified at both viewports. |
| 3 | 2026-07-29 | Upstream fix landed: `.cta-btn` now takes `--accent-fg` (a new required token, near-black in every theme) instead of `--bg`, so the CTA label is legible on a light theme. Refreshed the vendored `deck-base.css` + `theme.css`. | `qa-deck.mjs --strict` PASS (0 fail), overflow re-verified at both viewports. |
