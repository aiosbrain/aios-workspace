# Theme — AIOS Light

**Mode:** light · **Slug:** `aios-light` · **File:** `themes/aios-light.css`

The product identity on an inverted field. Use it for product material that has
to survive a bright room, a projector with a weak lamp, a printer, or being
embedded in a light-background document. Same voice as AIOS Dark — same
typefaces, same gradient, same restraint — just not on black.

Choose `aios-dark` when the deck will be presented on a screen you control.
Choose this when it will not.

## Colours

| Colour | Hex | Role |
|---|---|---|
| Warm White | `#fafaf8` | Primary slide background |
| Pure White | `#ffffff` | Raised surface — cards, quotes, stat tiles, screenshot backing |
| Oat | `#f3f3f0` | Floating chrome — the progress/navhint HUD, chips |
| Linen | `#e8e8e4` | Page backdrop behind the slides (the scroll gutter) |
| Charcoal | `#1a1a1a` | Primary text — headings, stat numbers, emphasis |
| Stone | `#57534e` | Body text |
| Pebble | `#a8a29e` | Micro-labels, captions, footnotes |
| Violet | `#7c3aed` | Primary brand hue — quote rules, note rules, callout borders |
| Deep Violet | `#6d28d9` | Small emphasis text and list markers |
| Cobalt | `#2563eb` | **Recommended-option signal.** Reserved. |
| Teal | `#2dd4bf` | Tertiary accent (info-note tint) |
| Pine | `#0d9488` | Info-note rule |
| Emerald | `#10b981` | Positive / success |
| Amber | `#f59e0b` | Caution |
| Red | `#ef4444` | Warning / negative |
| Lime | `#84cc16` | Live/active accent — **fill only** (the CTA pill). Never text. |
| Olive | `#4d7c0f` | Eyebrow labels — the lime identity at a contrast-safe value |

## Typography

| Role | Typeface | Note |
|---|---|---|
| Display | Instrument Serif | **Weight 400 only.** No true bold axis; 700 renders a broken faux-bold. Emphasise with size and italic. |
| Body | Instrument Sans | 400/500/600/700 all real |
| Mono | JetBrains Mono | Also the eyebrow face — the technical register |

## Layout concept

Editorial serif headline on warm white, with the interface as the imagery.
Screenshots carry a real border and a soft tinted shadow so they sit *on* the
page rather than floating in it — the inverse of the dark theme, where the
hairline is what separates a card from the field.

## Signature element

The same violet → emerald → lime gradient as AIOS Dark, in its light-mode
steps (`#7c3aed → #059669 → #65a30d`), still confined to the 4px rule, the list
markers and the step numerals.

## Rationing rule

Lime is a **fill**, never a text colour, in this theme. `#84cc16` fails contrast
badly on near-white — the eyebrow uses Olive `#4d7c0f` instead, which keeps the
accent identity and clears 4.5:1. Do not substitute the bright lime back in
because "it looks more like the product". It looks like the product on black.
