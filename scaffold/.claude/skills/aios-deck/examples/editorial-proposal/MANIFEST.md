---
status: final
owner: example
access: team
created: 2026-10-29
updated: 2026-10-30
type: "Deliverable"
---

# Opening the Velmont archive: a proposal for the Velmont River Museum

**Deck:** `deck.html` · **Theme:** `prism-light` · **Design layer:** `editorial.css` ·
**Slides:** 15 · **Deck id:** `velmont-archive-proposal` · **Kind:** Proposal
(catalog target: 12-16)

Lanternfield Studio, a fictional imaging studio, proposes to digitize a fictional river
museum's archive of charts, logbooks and survey sheets on site over six months and
publish it as one public catalog. The work has two actors, the museum's archive team
and the visiting studio, so the deck uses the editorial layer's two-voice pair as a code
the reader learns on slide 4 and reads everywhere after: green (`--ed-voice-a`) is the
archive team handling the collection, violet (`--ed-voice-b`) is the studio running
the cameras.

This is the reference for the **default** look. Read it before writing an editorial
deck; it shows every `ed-` component in real use.

## Slides

| # | Shows | Components |
|---|---|---|
| 1 | Cover | `.ed-photo.ed-cover`, `.ed-lockup` (`__x`), `.ed-cover-mid`, `.ed-cover-foot`, `.ed-logos--on-photo`, `.ed-logo-note` |
| 2 | The collection today | `.ed-split--wide.ed-split--stretch`, `.ed-card--outline`, bar chart (`.ed-svg-bar`, `--target`, `.ed-svg-t-on`), `.ed-num small`, `.ed-snug` |
| 3 | What we heard | `.ed-split` with an inline ratio, `.ed-quote`, `.ed-who`, `.ed-portrait`, `.ed-grid2`, `.ed-card--voice-a/--voice-b`, `.ed-icon` |
| 4 | Process map | `.ed-head`, `.ed-h1--sm`, pill legend (`.ed-pill--a/--b`), `.ed-svg--map` with `.ed-svg-voice-a/-voice-b/-gate/-line` and `.ed-svg-t1/t2/t3` |
| 5 | Who does what | `.ed-grid3` with `--ed-grid-cols`, `.ed-list` in voice cards, `.ed-card--feature.ed-card--center`, `.ed-num` |
| 6 | The visitor's path | `.ed-split--visual`, `.ed-steps`, `.ed-shot` |
| 7 | Timeline | `.ed-track` with `--ed-track-n: 4`, `.ed-step` (`--b`, `--milestone`, `--a`), `.ed-when` |
| 8 | Care of the collection | icon cards in `.ed-grid2` beside a centered voice-B card |
| 9 | Handover | `.ed-card--row`, `.ed-snug`, `.ed-video` (`__img`, `__bar`, `__play`, `__title`, `__len`) |
| 10 | Placeholder | `.ed-split--even`, `.ed-placeholder`, `.ed-pill--draft` |
| 11 | Options | `.ed-head--row`, feature / outline / plain cards, `.ed-shot--crop`, `.ed-num--sm` |
| 12 | Track record | logo cards, `.ed-row`, `.ed-brand` chips, `.ed-after` |
| 13 | Terms | `.ed-split--narrow`, two `.ed-list` columns |
| 14 | Team | `.ed-stack--tight`, `.ed-portrait--lg` |
| 15 | Close | `.ed-photo.ed-cover`, `.ed-cta` (inverted over a photo), lockup at the foot |

## Everything here is fictional

Lanternfield Studio, the Velmont River Museum, P. Arnaud, T. Halvorsen, J. Whitcombe,
S. Ferreira-Lund, every archive logo (Brackwater Library, Orrin Valley Archive, Saltmarsh
Gallery, Hollin Street Records, Fenwick Observatory), every tool name (Platewise,
Tilehold, Shelvio, Loupehouse), every figure, quote, date and price, and every image are
**invented for this example**. The slide order follows the generic proposal
shape (thesis, need, plan, options, proof, team, close); no copy, figure or
case from any real engagement is used. Portraits are flat
silhouettes, photos are generated gradients, screenshots are drawn wireframes, all as
inline `data:image/svg+xml` URIs. No real client, person, price or screenshot appears
anywhere.

## Revision log

| Round | Date | Change | QA result |
|---|---|---|---|
| 2 | 2026-10-30 | Rewritten around a fully invented archive digitization engagement; process map resized so every label holds the 15px floor at 1280x720 | PASS (2 allowlisted base notes); overflow 0 at 1280x720 and 1440x810 (playwright) |
| 1 | 2026-10-29 | Built to show every editorial component | PASS (2 allowlisted base notes); overflow 0 at 1280x720 and 1440x810 (playwright) |
