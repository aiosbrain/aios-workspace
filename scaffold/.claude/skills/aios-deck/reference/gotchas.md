# Deck gotchas

Entries 1-17 each cost a real debugging round in one of the two source decks — a
proposal deck (14 revision rounds) and a product demo deck (5 revision rounds).
Each fix is now a **default** in `deck-base.css`, not an opt-in flag. Entries
18-23 are the editorial anti-patterns: what made the classic default look dense,
fixed by default in `editorial.css`.

This file exists so nobody "fixes" a default back to the broken behaviour by
accident. The *reasoning* is the point — the CSS alone looks arbitrary, and an
agent that can't see why will reintroduce the bug.

Read this before touching `.shot`, `.two-col`, `.photo-slide`, any `@media print`
block, or any inline `<style>` inside an SVG diagram.

---

## 1. Don't let `.shot` auto-center away from left-aligned text

**Don't:** apply `margin: 0 auto` to a screenshot that sits above or below
left-aligned heading/body text in the same column. It visually drifts away from
the text it belongs to.

**Do:** use `.shot--col` (flush-left, `margin: 0`) whenever a screenshot is
paired with text in a `.two-col` layout. Reserve the centering default (`.shot`
alone) for genuinely standalone/centered contexts — inside `.demo-frame`, a
`.thumb-row`, or a `.center-slide`.

## 2. Size screenshot chrome to the image, not the column

**Don't:** let a screenshot's border/shadow/rounded-corner "card" stretch to the
width of its column or the slide. It reads as a giant empty box with a tiny
photo floating in it ("ultrawide with grey space").

**Do:** default `.shot` to `width: fit-content` so the chrome wraps the image's
own rendered bounds. This is already the default — don't add `width: 100%` to a
plain `.shot` to "fill the column" (use `.shot--col` for that, which is a
deliberately different, wider treatment).

## 3. Don't crop real content with `overflow: hidden` + a fixed max-height

**Don't:** combine a fixed `max-height` with `overflow: hidden` on a screenshot
wrapper that must show a diagram or full-page capture in full — it silently
crops content off the bottom or sides with no visual warning. Nothing errors;
you just ship a truncated diagram.

**Do:** use `.shot--plain` for anything that must render in full: no border, no
shadow, no `overflow: hidden`, generous `max-height`/`max-width`, and
`object-fit: contain` on the image itself. See also gotcha #9 — `.shot--plain`
has to *restate* `overflow: visible`, it doesn't get it for free.

## 4. Never combine a blurred pseudo-element with real slide text

**Don't:** put `backdrop-filter: blur()` on a slide's `::before`/`::after` to
soften a background photo. Pseudo-elements paint **on top of** the slide's real
DOM children in the same stacking context — the blur lands on the actual
headline and body text, not just the photo behind it.

**Do:** if a photo needs softening, blur the source image asset before
compositing it, or use a separate absolutely-positioned `<img>` sitting behind
the text with its own stacking context. `.photo-slide` in `deck-base.css` only
ever uses a `linear-gradient` overlay for contrast — no blur filter, ever, on
the slide's own pseudo-elements.

## 5. Full-bleed photo + gradient overlay, never a hard split

**Don't:** build a "photo slide" as two visually distinct panels — one solid
background colour, one photo. It reads as "half the slide is a flat black
rectangle."

**Do:** use `.photo-slide` — ONE continuous full-bleed background image with a
`linear-gradient` overlay fading from opaque (behind the text) to transparent
(revealing the photo). Set `--photo-bg-image` inline per slide; the scrim colour
comes from the theme's `--photo-scrim-rgb` token.

## 6. Screenshot format: PNG for anything with small UI text

**Don't:** capture screenshots via a generic full-viewport screenshot action and
save as JPEG — lossy compression makes small UI text look grainy, and the deck
is projected at scale.

**Do:** use a region-targeted ("zoom"-style) capture for anything with fine
text, and save as PNG. This is a process note, not a CSS rule — there is nothing
the stylesheet can do to fix a JPEG that is already lossy.

## 7. Paired screenshots: size by the same dimension

**Don't:** independently height-cap two screenshots sitting side-by-side in a
`.two-col`. A "tall" screenshot and a "wide" screenshot end up mismatched in
visual size even though they are conceptually paired.

**Do:** use `.shot--col` for both — it sizes by `width: 100%` of the column, not
by height, so paired screenshots match regardless of native aspect ratio.

## 8. QA navigation: drive with `scrollIntoView()`, not simulated key presses

**Don't:** QA a scroll-snap deck by scripting simulated keyboard arrow presses —
it is flaky and silently no-ops roughly every other press, so you "verify"
slides you never actually looked at.

**Do:** drive navigation via
`slides[i].scrollIntoView({behavior:'smooth', block:'start'})` in a JS console or
automation script. This is also exactly what `deck-nav.js` uses internally for
real keyboard nav, so console-driven QA and real usage take the same code path.

## 9. `.shot--plain` must set `overflow: visible`

**Don't:** assume that stripping the card chrome off `.shot` also strips the
clipping. `.shot` sets `overflow: hidden` for its rounded-corner card. A shipped
deck's copy of `.shot--plain` removed the border, shadow and radius but forgot
to reset `overflow` — so gotcha #3 (silent cropping) was *live in the very deck
that discovered it*.

**Do:** have `.shot--plain` explicitly restate `overflow: visible`. Removing the
visual chrome is not the same as removing the clipping; the clipping is a
separate declaration and has to be separately undone.

## 10. The `@media print` block must handle BOTH scroll axes

**Don't:** copy a vertical deck's print block into a horizontal deck. A
vertical-snap deck only needs `#deck { overflow: visible; height: auto; }`. A
horizontal deck ALSO needs `#deck { display: block; }` and
`.slide { width: 100%; }` — without them the flex row stays a flex row in print
and every slide collapses to a sliver.

**Do:** ship ONE merged print block that covers both axes (reset `display`,
`overflow`, `height` and `.slide` width unconditionally). The shipped base had
the vertical-only version and the horizontal deck had to re-derive the fix
inline — which is exactly the rediscovery this system exists to stop.

## 11. Never re-declare chart-label typography per diagram

**Don't:** give each inline SVG diagram its own `<style>` block re-declaring
`font-family` and a literal fill such as `fill: rgba(15,15,17,.95)` for its tick
labels, row labels and captions. One deck carried SIX of these. Every one of
those charts breaks silently on a theme swap — a light-theme fill on a dark
background is invisible text, with no error.

**Do:** use the shared `.svg-label` / `.svg-tick` / `.svg-cap` / `.svg-num` class
set from `deck-base.css` and drive fill from `var(--fg)` / `var(--fg-2)` /
`var(--fg-3)`. **Never put a literal colour inside an SVG that lives in a themed
deck.**

## 12. Theme-token omission fails SILENTLY

**Don't:** ship a deck on a new theme without linting the token contract.
`deck-base.css` deliberately defines no fallback colours (it stays
brand-agnostic), so a theme file that omits a required token renders that
component unstyled — no console error, no visual warning, just invisible or
default-black text that you may not hit until you're presenting.

**Do:** run `node scripts/qa-deck.mjs <deck>` before every handover. Linting the
token contract is precisely why that script exists.

## 12b. A token can be *defined* and still silently wrong

**Don't:** assume that because `qa-deck.mjs` reports the token contract complete,
the theme is correct. Completeness and correctness are different checks.

**Do:** remember that three tokens have a required VALUE SHAPE, not just a
required presence:

- `--photo-scrim-rgb` is consumed as `rgba(var(--photo-scrim-rgb), 0.88)`, so it
  must be a **bare comma-separated triplet** (`6, 6, 8`). Writing `#060608` — the
  intuitive thing, since every other colour token is a hex — produces
  `rgba(#060608, 0.88)`, which is invalid, which the browser drops, which means
  every photo slide loses its scrim and its white headline lands on a bright
  photograph. No console error. This is the single most error-prone token in the
  contract.
- `--weight-display` / `--weight-heading` must be a real CSS font-weight.
- `--accent-bar-height` must be a length with a unit.

`qa-deck.mjs` check (a) now validates all three shapes as well as presence. If
a photo slide looks wrong, check this token before anything else.

---

## 13. Handover decks are `file://` folders — they cannot resolve `node_modules`

**Don't:** `@import` a stylesheet from an npm package, use a bare-specifier
import, or reference a path that escapes the deck folder. Decks get zipped,
emailed, and opened by double-clicking. All three of those silently fail on the
recipient's machine — they see an unstyled or half-styled deck and you don't
find out.

**Do:** INLINE the theme tokens (or copy the theme file into the deck folder
alongside `deck-base.css`). This trades against the standing "don't copy tokens
out of the design package" rule; the trade-off is managed by recording the
pinned package version **and a source hash** in the header comment of every
generated theme file, so drift is detectable rather than invisible.

## 14. Don't hand-check slide overflow — and don't skip it

**Don't:** eyeball slides for overflow, and don't wave it off because "it looked
fine on my screen". Both source decks' revision logs show them hand-checking
overflow at two viewport sizes *every single revision round*. Presenter laptops
and projectors differ; a slide that fits at 1440 wide overflows at 1280.

**Do:** let `scripts/qa-deck.mjs` check (c) do it, at **1280x720 and 1440x810**.
It is a mechanical check with a known failure mode — that is exactly the kind of
thing not to spend a human revision round on.

## 15. Do not build an HTML→pptx converter

**Don't:** try to machine-translate a deck into PowerPoint. This was evaluated
and rejected. Anthropic shipped an `html2pptx` and deleted it four months later
(PR #331, 2026-02-04). Its constraints — no CSS gradients, no styling on text
elements, web-safe fonts only, and text in a bare `<div>` silently dropped from
the output — would destroy every deck this system produces: the gradient accent
bar, the gradient list markers, the gradient step numerals and the display
typeface are all load-bearing.

**Do:** ship single-file HTML as the output, and a print-to-PDF script for the
paper/attachment case. If someone genuinely needs a `.pptx`, the honest answer
is to rebuild it natively in the target tool — not to run it through a converter
that drops content without telling you.

## 16. `.two-col` defaults to `align-items: flex-start`, not `center`

Recorded independently in both source decks' revision histories, which is what
promotes it from a style preference to a real defect.

**Don't:** set `align-items: center` on a two-column row. It looks correct right
up until one column grows taller than the other — an extra quote, a longer
bullet list, a two-line heading. At that point the *shorter* column's content
centres itself within the row instead of starting flush at the top, opening a
dead gap above it that reads as a broken layout rather than a deliberate one.

**Do:** leave `.two-col` at its default `align-items: flex-start`. Reach for the
`.two-col--center` modifier only when both columns are guaranteed near-equal
height — in practice, a short label beside a tall diagram, and almost nothing
else. The same applies to the ratio modifiers: `.two-col--wide-left` and
`.two-col--wide-right` change the flex ratio only, never the alignment.

Related: put the `.shot` or `.media-frame` **first** in a column and the
`.col-label` / heading **after** it, and use the same order in every column of
the row. Mixed order is the other way the headings stop lining up.

## 17. Inline `data:image/svg+xml` URIs have three encoding traps

All three were hit building the reference decks in `examples/`, and all three
fail **silently** — no console error, just missing artwork.

**Don't:** paste an SVG into a `data:` URI as-is.

**Do:** apply all three rules.

1. **Percent-encode `#` as `%23`.** A raw `#` starts a URL fragment and
   truncates the rest of the SVG. Every hex colour inside the SVG is affected.
2. **Write `alt` before `src` on every `<img>`.** A data URI contains `>`
   characters, so any regex-based tag scan — including `qa-deck.mjs` check (e)
   on its no-browser path — stops at the first one and reports a missing `alt`
   on an image that has one.
3. **Inside a CSS `url('…')`, percent-encode the SVG's own `'` as `%27`.**
   Otherwise the SVG's first attribute quote terminates the CSS string, the
   whole `background-image` declaration is dropped, and the slide loses its
   photo *and* its scrim — which on a photo slide means white text on a white
   background.

Note this is a technique for `examples/` specifically, where a public repo
should not carry binary assets. A real deck should use real screenshots —
PNG, region-targeted, per gotcha #6.

---

## Editorial anti-patterns (18-23)

These six came from one review. A client proposal was built on the classic
default, and the owner's verdict on the result was that it looked dense and
unfinished. The rebuild on an editorial layer was judged a large step up, and
every difference between the two decks is one of the entries below. The fixes
are now the defaults in `assets/editorial.css` and the editorial starter slides
in `new-deck.mjs`. Each entry exists so nobody walks a deck back to the old look
one "small" change at a time.

## 18. No full-width callout strips

**Don't:** close a slide with a `.note` or `.callout` that runs the full width
of the slide under the content. It reads as a warning banner, splits the slide
into two unrelated halves, and is usually a sentence that did not fit anywhere
else.

**Do:** put the point inside the composition: a `.ed-card--feature` beside the
cards it summarizes, an `.ed-lede` under the heading, or one `.ed-body.ed-after`
sentence at text width (it is capped near 70ch, never full bleed). If it
genuinely needs its own frame, it needs its own slide.

## 19. No eyebrow label above every heading

**Don't:** stack a small uppercase `.kicker` over every slide title. On one
slide it is a signpost; on every slide it is noise, doubles the number of
things the eye lands on before the claim, and pushes the heading down.

**Do:** let `.ed-h1` stand alone and state the claim. If the audience needs to
know which section they are in, say it in the heading itself or use one
statement slide as the act break. The editorial starter slides carry no
eyebrow anywhere, on purpose.

## 20. Nothing below about 15px

**Don't:** set body copy, captions or chart labels at caption size because a
slide is full. The classic default's body ran close to caption size, and that
is the single change that made the old decks look dense from across a room.

**Do:** keep `.ed-body` (17px floor) for anything the audience reads and
`.ed-small` (15px floor) as the smallest text on any slide. The floors are
`clamp()` minimums in `editorial.css`; do not override them, and `.ed-num small`
is held to the same 15px. SVG text is the trap: it scales with the viewBox, so a
label set at 15px renders smaller whenever the SVG is drawn narrower or shorter
than its viewBox. The `.ed-svg-t*` classes are 15-18px at a scale of 1, so at
1280x720 keep a full-width diagram's viewBox at most 1100 units wide, a
`.ed-svg--map` (capped at 50vh, 360px) at most 360 units tall, and a chart in a
7:4 split card near 540 units wide. The editorial starter slides and
`examples/editorial-proposal` hold every text node at 15px or more at 1280x720,
measured in Chromium. Text inside raster or data-URI images (mockups,
wireframes) is decoration and is exempt; never put copy the audience must read
inside an image. Text contrast is part of the same rule: `--ed-mist`,
`--ed-voice-a` and `.ed-svg-t-on` are mixed so they hold 4.5:1 or better on
paper and stone in both light themes. Voice-A text on its own soft tint sits
just under that on aios-light, so use it there only at heading size. If copy does not fit at those sizes, cut it or split the slide.

## 21. No tiny bullets

**Don't:** fill a slide with a long list of short, small bullets, or with
`ul.tight` as the main content. Six-plus lines of small text is a document
pasted onto a slide.

**Do:** use `.ed-list` with three to five items at body size, each one a full
thought with a bold lead-in, or turn the items into cards or numbered steps. A
list longer than five is a table or a second slide.

## 22. One heading per slide

**Don't:** give a slide a title, then a second heading-sized line, then card
headings that compete with both. Two headings means two claims, and the
audience will not know which one the slide is proving.

**Do:** one `.ed-h1` per slide, plus at most one `.ed-lede`. Everything below
that is `.ed-h3` or smaller. A title that needs a second sentence to make sense
is the wrong title.

## 23. Vertical balance

**Don't:** pin content to the top of the slide and leave the bottom third empty,
or pad with spacer elements and margins to push it down. Both read as a slide
that ran out of content halfway.

**Do:** let the composition sit in the middle. `.slide` already uses
`justify-content: center`, and `editorial.css` raises the vertical margin to
8.5vh so the centered block has air above and below. Build each slide as one
heading block plus one composition (`.ed-split`, a grid, a track, a diagram)
and let the slide center it. In a split, `.ed-split` centers its two sides
against each other; use `--narrow` (top-aligned) only when one side is much
taller.

---

## Adding a gotcha

A gotcha earns a place in this file when **both** are true:

1. It cost a real debugging round (not a hypothetical, not a style preference).
2. The fix is now a **default** in `deck-base.css`, `editorial.css` or `qa-deck.mjs`.

The entry exists so nobody reverts that default by accident. If a finding fails
either test it belongs in the deck's own notes, not here — this file is the
justification layer for the defaults, and it stops being useful the moment it
turns into a general tips list.
