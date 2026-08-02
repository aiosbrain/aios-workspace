# Theme — AIOS Dark

**Mode:** dark · **Slug:** `aios-dark` · **File:** `themes/aios-dark.css`

The product identity. Use it for anything that is *about the software*: demos,
product walkthroughs, architecture, roadmap, internal all-hands.

## Colours

| Colour | Hex | Role |
|---|---|---|
| Near Black | `#0b0b0b` | Primary slide background |
| Carbon | `#131313` | Raised surface — cards, quotes, stat tiles, screenshot backing |
| Graphite | `#191919` | Floating chrome — the progress/navhint HUD, chips |
| True Black | `#000000` | Page backdrop behind the slides (the scroll gutter) |
| White | `#ffffff` | Primary text — headings, stat numbers, emphasis |
| Ash | `#b8b8b8` | Body text |
| Slate Grey | `#8a8a8a` | Micro-labels, captions, footnotes |
| Violet | `#8b5cf6` | Primary brand hue — quote rules, note rules, callout borders |
| Light Violet | `#a78bfa` | Small emphasis text and list markers (a *lighter* step on dark) |
| Blue | `#3b82f6` | Secondary accent, reserved for "recommended" ribbons |
| Teal | `#2dd4bf` | Tertiary accent (info notes) |
| Aqua | `#5eead4` | Info-note rule (lighter step of teal) |
| Emerald | `#10b981` | Positive / success |
| Amber | `#f59e0b` | Caution |
| Red | `#ef4444` | Warning / negative |
| Lime | `#84cc16` | **Live/active accent.** Eyebrow labels, the CTA pill, the live dot |

## Typography

| Role | Typeface | Note |
|---|---|---|
| Display | Instrument Serif | **Weight 400 only.** No true bold axis — a 700 request renders a broken faux-bold. Emphasise with size and italic. |
| Body | Instrument Sans | 400/500/600/700 all real |
| Mono | JetBrains Mono | Also the eyebrow face — the technical register |

## Layout concept

Editorial serif headline over a near-black field, with the interface itself as
the imagery. Screenshots are the hero; the type stays quiet around them.

## Signature element

The 3px violet → emerald → lime gradient rule across the top of every slide,
echoed in the list markers and step numerals. Nowhere else. That rationing is
what stops it reading as a generic AI gradient.

## Rationing rule

One filled lime action per slide, maximum. Lime means *live*: an active demo, a
running system, the single call to action. Use it twice and it means nothing.
