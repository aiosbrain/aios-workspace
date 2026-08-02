# Theme — Prism Light

**Mode:** light · **Slug:** `prism-light` · **File:** `themes/prism-light.css`

The editorial identity. Use it for anything that is *a document that happens to
be a deck*: proposals, engagement plans, board updates, anything that will be
printed or read as much as presented.

## Colours

| Colour | Hex | Role |
|---|---|---|
| Paper | `#ffffff` | Primary slide background |
| Bone | `#fafafa` | Raised surface — cards, quotes, stat tiles, screenshot backing |
| Veil | `rgba(255,255,255,0.85)` | Floating chrome — the progress/navhint HUD, chips |
| Mist | `#e9e9ec` | Page backdrop behind the slides (the scroll gutter) |
| Ink | `rgba(15,15,17,0.95)` | Primary text — headings, stat numbers, emphasis |
| Slate | `rgba(15,15,17,0.66)` | Body text |
| Fog | `rgba(15,15,17,0.48)` | Micro-labels, captions, footnotes |
| Royal Violet | `#7c3aed` | Primary brand hue — quote rules, note rules, callout borders |
| Deep Violet | `#6d28d9` | Eyebrow labels, small emphasis text, list markers |
| Cobalt | `#3b82f6` | **Recommended-option signal.** Reserved. |
| Teal | `#2dd4bf` | Tertiary accent (info-note tint) |
| Pine | `#0d9488` | Info-note rule |
| Emerald | `#10b981` | Positive / success |
| Amber | `#f59e0b` | Caution |
| Crimson | `#dc2626` | Warning / negative |
| Citron | `#a3e635` | Live/active accent — the CTA pill, the live dot |

## Typography

| Role | Typeface | Note |
|---|---|---|
| Display | Bricolage Grotesque | Real 700 and 800 axes — use them (`--weight-display: 800`) |
| Body | Hanken Grotesk | 400/500/600/700 |
| Mono | JetBrains Mono | Tables, chips, captions, footnotes |
| Eyebrow | Hanken Grotesk (body) | Body-face eyebrow = editorial register, not technical |

## Layout concept

A grotesque display face on white, generous measure, a violet → blue → teal
gradient rule at the head of every page. It should read like a well-set
document that has been paginated into slides, not like a presentation template.

## Signature element

The 5px gradient rule, plus the `.paperwhite` textured off-white section
divider that breaks a long deck into acts. The texture is the tell — it says
"this is a document" more than any typeface choice does.

## Rationing rule

**Cobalt is reserved for "recommended".** It is the only colour in the deck that
carries a decision. Use it decoratively anywhere else and the one moment where
you are actually guiding the reader stops registering.
