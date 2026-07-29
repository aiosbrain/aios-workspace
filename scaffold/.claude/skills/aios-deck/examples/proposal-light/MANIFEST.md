---
status: final
owner: example
access: team
created: 2026-07-29
type: "Deliverable"
---

# Partner onboarding — a proposal for Northwind Labs

**Deck:** `deck.html` · **Theme:** `prism-light` · **Slides:** 13 ·
**Deck id:** `northwind-onboarding-proposal` · **Kind:** Proposal (catalog
target: 12–16)

Harbourline Partners, a fictional operations consultancy, proposes a ten-week
engagement to Northwind Labs: rebuild how a carrier partner gets from signed to
sending. The diagnosis is that the delay is structural, not technical — eleven
handoffs and nobody who owns the clock — and the deck guides the reader to the
middle of three options rather than presenting them as peers.

It reads as a document that has been paginated into slides, which is what
`prism-light` is for.

## Slides

| # | Type key | Purpose |
|---|---|---|
| 1 | `cover` | The **text-only** cover variant — `.cover-mid` is dropped entirely and the grid holds. Logo, headline, one line of scope, the prepared-for line. |
| 2 | `statement` | The diagnosis in one sentence: not an integration problem, an ownership problem. |
| 3 | `content` (`ul.clean`) | What we heard, in the interviewees' own framing. Four points, one footnote naming the sample. |
| 4 | `two-col two-col--divided` | Cause on the left, consequence on the right, a vertical rule between them. Symmetric `.col-label` + `ul.tight` in both columns. |
| 5 | `paperwhite` act break | `center-slide paperwhite` — the textured off-white surface breaks the deck into two acts without a new template. |
| 6 | `spectrum` | The trade-off as a dial, not three buttons. Narrow / Balanced / Broad, with the middle stop carrying the `Recommended` badge. |
| 7 | `options` | Three `.option-card`s; the middle one is `.recommended` with a text `.badge`. A `.note` says why, in one sentence. |
| 8 | `two-col two-col--wide-left` | The recommended path in detail: a four-step `.step-list` beside a `.media-frame` schedule diagram. Week labels lead each step so the `.step-list` flex gutter reads as a calendar. |
| 9 | `table` | `table.deck-table` on `slide-title--sm`, with `td.num` for the counts, a `td.total` row, and a `.cite` for the assumptions. |
| 10 | `number` | One `.price-hero`: **41 days**, a duration rather than a currency amount. `.price-sub` gives the sample, `.price-note` says what the number excludes. |
| 11 | `content` + notes | Risks and assumptions: three conditions in `ul.clean`, then one `.note--warn` and one `.note--info`. |
| 12 | `people` | 5-up team row, `.people-grid` with `--people-cols: 5`. |
| 13 | `close` | `.close-slide` vertical scrim, `.cta-btn`, `.mission-line`. |

## Everything here is fictional

Harbourline Partners, Northwind Labs, D. Mensah, E. Yamada, C. Lindqvist,
G. Halvorsen, H. Sato, the forty-one-day baseline, the ten-week plan, the
scope table, the day counts, the logo and the five portraits are **invented for
this example**. No real client, engagement, person, rate or price appears
anywhere in this deck — and per `reference/brand-schema.md` and the repo's
access rules, none ever should in a public `examples/` folder.

The one deliberate constraint worth copying: the headline number is a
**duration**, not money. A real proposal's commercials do not belong in a
shared example.

## Theme notes

- **Cobalt is reserved for "recommended".** It appears exactly twice: the
  spectrum's middle stop (slide 6) and the recommended option card and its badge
  (slide 7). Nowhere else in the deck, including the quotes.
- **Bricolage Grotesque has real 700/800 axes**, so `--weight-display: 800`
  is used as intended rather than faked.
- `.paperwhite` (slide 5) is the signature move: the change of surface is what
  says "new act", not a change of layout.

## Assets

No binary files. Six images, all inline `data:image/svg+xml;utf8,…` URIs: one
logo lockup, five abstract geometric portraits, plus two gradient "photos"
(cover and close) supplied through `--photo-bg-image`. The slide-8 schedule is
an inline `<svg>` styled only with `.svg-accent` / `.svg-rule` / `.svg-label` /
`.svg-tick` / `.svg-cap` — no literal colour, so it survives a theme swap.
Total folder weight is under 90 KB.

## Revision log

| Round | Date | Change | QA result |
|---|---|---|---|
| 1 | 2026-07-29 | First build: 13 slides, `prism-light`, text-only cover, all imagery as inline SVG data URIs. | `qa-deck.mjs` PASS (0 fail). Overflow verified at 1280x720 and 1440x810 with a real browser. |
| 2 | 2026-07-29 | Cover and close slides were rendering as blank white — the CSS `url('data:…')` string was being terminated by the SVG's own single quotes, so `background-image` was dropped and white `--photo-fg` text landed on a white slide. Percent-encoded `'` as `%27` for CSS-embedded URIs. Also: brightened both photos, redrew the logo mark (the first one read as a warning triangle), swapped the schedule bars from `.svg-box` to a `.svg-accent` opacity ramp for legibility on white, put week labels on the `.step-list` so its gutter aligns, removed em dashes. | `qa-deck.mjs` PASS (0 fail), overflow re-verified at both viewports. |

## Known issue (not fixable from this folder)

On slide 13 the `.cta-btn` renders **white on citron** and is effectively
unreadable. `deck-base.css` sets `.cta-btn { color: var(--bg) }`, and on a light
theme `--bg` is white while `--lime` is `#a3e635` — roughly 1.7:1. It is correct
on `aios-dark` (near-black on lime). The fix belongs in `assets/deck-base.css`
or in the light theme files; a deck must not patch it with an inline colour.
