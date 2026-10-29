# Slide catalog

Copy-pasteable markup for the editorial layer (`editorial.css`, the default)
and for every classic slide type `deck-base.css` v1.0.0 supports.

**How to use this file:** find the slide type that matches the *point you are
making*, copy its block into the deck between `<div id="deck">` and `</div>`,
and replace the content. Do not invent new classes. If nothing here fits, the
answer is almost always a `.two-col` with a different pair of components inside
it, not a new component.

**Before you use any of these, read two complete decks in `examples/`.** They are
the quality bar; this file is only the parts list.

---

## Deck shell

Every deck is one self-contained HTML file. The container, the HUD and the nav
script are identical in every deck — copy this shell verbatim and only change
the `<title>`, the theme filename, and `data-deck-id`. Drop the
`editorial.css` line only for a `--classic` deck.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deck title</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="deck-base.css">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="editorial.css">
</head>
<body>
<div id="deck" data-deck-id="my-deck">

  <!-- slides go here -->

</div>
<div class="side-brand">Brand mark</div>
<div class="progress" id="progress">1 / 1</div>
<div class="navhint">&larr; &uarr; &rarr; &darr; to navigate</div>
<script src="deck-nav.js"></script>
</body>
</html>
```

Notes that matter:

- **`.progress` starts at `1 / N` where N is the real slide count.** The nav
  script recomputes it at runtime, but the static text is what shows before the
  script runs and what shows in the PDF. `qa-deck.mjs` check (d) fails on a
  mismatch — both source decks shipped a hardcoded wrong count.
- **Horizontal deck:** add `class="deck--horizontal"` to `#deck`. Nothing else
  changes; the nav script listens on both arrow axes and the print block handles
  both orientations.
- **Handover:** the deck folder must contain `deck.html`, `deck-base.css`, the
  one theme `.css`, `editorial.css` (unless classic), `deck-nav.js` and `assets/`. It is opened from `file://`, so
  nothing may reference a path outside the folder.

## Editorial layer (the default)

Everything in this section needs `editorial.css` linked **after** the theme
(the deck shell above shows it). `new-deck.mjs` adds it unless you pass
`--classic`. Every class is prefixed `ed-`, and every color is derived from
the theme's tokens, so nothing here changes when you swap themes.
`examples/editorial-proposal/deck.html` shows all of it in real use.

**The shape of an editorial slide:** one `.ed-h1`, optionally one `.ed-lede`,
then one composition (a split, a grid, a track, a diagram). No eyebrow above the
heading, no full-width strip under it. `.slide` already centers its content
vertically, so do not pad a slide to push content down; let it balance.

### Type

```html
<h1 class="ed-h1">The one claim this slide makes</h1>
<h1 class="ed-h1 ed-h1--lg">Cover or statement headline</h1>
<h1 class="ed-h1 ed-h1--sm ed-h1--wide">A long title over a dense diagram</h1>
<h3 class="ed-h3">Card or column heading</h3>
<p class="ed-lede">One line that frames the slide. 46ch wide; add ed-lede--wide for 70ch.</p>
<p class="ed-body">Body copy. <span class="ed-strong">Emphasis</span> inside it.</p>
<p class="ed-small">Captions, sources, attributions. Never smaller than this.</p>
```

| Class | Size at 1440 | When not to |
|---|---|---|
| `.ed-h1` | about 59px | Never two on one slide. A second heading is a second slide. |
| `.ed-h1--lg` | about 75px | Only on a cover, a statement or a close. On a content slide it crowds the composition. |
| `.ed-h1--sm` | about 46px | Only when a full diagram or map needs the height. Not as a way to fit more copy. |
| `.ed-h3` | about 24px | Not as a slide title; it is for cards, steps and columns. |
| `.ed-lede` | about 23px | Not for a second paragraph. One lede, one line or two. |
| `.ed-body` | about 19px (17px floor) | Not for a sentence that only needs to be a caption. |
| `.ed-small` | about 16px (15px floor) | Not for anything the audience must read to follow the argument. |

### Layout

```html
<div class="ed-head">                     <!-- heading block above a composition -->
  <h1 class="ed-h1">Heading</h1>
  <p class="ed-lede">Lede.</p>
</div>
<div class="ed-head ed-head--row">        <!-- heading with a pill on the right -->
  <h1 class="ed-h1">Options and investment</h1>
  <span class="ed-pill ed-pill--draft">Draft figures</span>
</div>

<div class="ed-split">…two children…</div>                 <!-- 5:6, centered -->
<div class="ed-split ed-split--even">…</div>               <!-- 1:1 -->
<div class="ed-split ed-split--visual">…</div>             <!-- 4:7, text beside a big visual -->
<div class="ed-split ed-split--wide ed-split--stretch">…</div>  <!-- 7:4, equal-height columns -->
<div class="ed-split ed-split--narrow">…</div>             <!-- 4:7, top-aligned: heading beside a list -->
<div class="ed-split" style="--ed-split-cols: 0.9fr 1.15fr">…</div>  <!-- any ratio -->

<div class="ed-grid2">…</div>  <div class="ed-grid3">…</div>  <div class="ed-grid4">…</div>
<div class="ed-grid3" style="--ed-grid-cols: 1fr 1fr 0.85fr">…</div>

<div class="ed-stack">…</div>  <div class="ed-stack ed-stack--tight">…</div>
<div class="ed-row">…pills or chips in a line…</div>
<p class="ed-body ed-after">A closing sentence below a composition.</p>
```

`.ed-snug` tightens the gap on any stack or grid. `--ed-split-cols` and
`--ed-grid-cols` are registered as non-inheriting, so a ratio set on a split
never leaks into a grid nested inside it.

When not to: do not use `.ed-split` with `align-items` overridden to `center`
when one side can grow much taller (the classic `.two-col` gotcha #16 applies);
reach for `--narrow` (top-aligned) instead. Do not nest a split inside a split.
Beyond `ed-grid4`, cards stop being readable at 1280 wide.

### Cards

```html
<div class="ed-card">                                <!-- stone: the default -->
  <div class="ed-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg></div>
  <h3 class="ed-h3">Name</h3>
  <p class="ed-body">One or two sentences.</p>
</div>
<div class="ed-card ed-card--outline">…</div>         <!-- paper with a hairline -->
<div class="ed-card ed-card--voice-a">…</div>         <!-- tinted with voice A -->
<div class="ed-card ed-card--voice-b">…</div>         <!-- tinted with voice B -->
<div class="ed-card ed-card--feature ed-card--center"> <!-- inverse: the one card that matters -->
  <div class="ed-num">00</div>
  <h3 class="ed-h3">the number that proves it</h3>
  <p class="ed-body">Why that number matters.</p>
</div>
<div class="ed-card ed-card--voice-a ed-card--row">   <!-- pill beside text, horizontal -->
  <span class="ed-pill ed-pill--a">Short label</span>
  <div><h3 class="ed-h3">Item name</h3><p class="ed-body">When and what.</p></div>
</div>
```

When not to: one `--feature` card per slide; two inverse cards fight. Do not
tint a card with a voice unless the slide is about who does what; tint as
decoration breaks the code. Not for a single sentence spanning the slide (that
is the full-width strip anti-pattern, gotcha #18).

### Pills and icons

```html
<span class="ed-pill">Neutral label</span>
<span class="ed-pill ed-pill--a">Voice A</span>
<span class="ed-pill ed-pill--b">Voice B</span>
<span class="ed-pill ed-pill--draft">Draft: for review</span>
<div class="ed-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></div>
```

Icons are 24-unit line drawings; `editorial.css` sets the stroke and fill, so
never color the SVG. When not to: a pill is a tag, not a heading; do not put a
pill above every card heading on a slide where it says nothing new. Use
`--draft` only for content that must change before the deck goes out. Do not
mix icon styles (filled and line) on one slide.

### Lists and numbered steps

```html
<ul class="ed-list">
  <li><strong>Named thing.</strong> Why it matters here.</li>
  <li><strong>Named thing.</strong> Why it matters here.</li>
</ul>

<ol class="ed-steps">
  <li><strong>First move</strong>What happens, in one line.</li>
  <li><strong>Second move</strong>What happens, in one line.</li>
</ol>
```

`ed-list` markers pick up the voice color inside a voice card. `ed-steps`
numerals use voice A. When not to: more than five items in an `ed-list` is a
table or a second slide. Never use `ed-steps` for an unordered list; the
numerals imply a sequence.

### Big numbers

```html
<div class="ed-num">00<small>unit</small></div>
<div class="ed-num ed-num--sm">00,000</div>
```

When not to: one hero number per card, and no more than three numbers per
slide. Use `--sm` when three option cards each carry a price; full size three
times reads as a dashboard.

### Quote and portrait

```html
<p class="ed-quote">"The sentence someone actually said."</p>
<div class="ed-who">
  <img class="ed-portrait" alt="Portrait of A. Rivera" src="assets/a-rivera.jpg">
  <div>
    <p class="ed-body ed-strong">A. Rivera</p>
    <p class="ed-small">Role, Company</p>
  </div>
</div>
<img class="ed-portrait ed-portrait--lg" alt="Portrait of B. Okafor" src="assets/b-okafor.jpg">
```

When not to: one quote per slide. Never invent or paraphrase a quote. A
portrait needs a real, square, consented photo; if you do not have one, drop
the portrait and keep the attribution text.

### Logos: lockup, logo row, brand chip

```html
<div class="ed-lockup">
  <img alt="Partner name" src="assets/partner-logo.svg">
  <span class="ed-lockup__x">×</span>
  <img alt="Our logo" src="assets/our-mark.svg">
  <span class="ed-lockup__word">OURNAME</span>
</div>

<div class="ed-logos ed-logos--on-photo">   <!-- or ed-logos--mono on paper; add ed-logos--start to left-align -->
  <img alt="Client one" src="assets/logos/client-one.svg">
  <img alt="Client two" src="assets/logos/client-two.svg">
  <span class="ed-logo-note">A short note</span>
</div>

<span class="ed-brand"><img alt="" aria-hidden="true" src="assets/tool.svg">Tool name</span>
```

When not to: the lockup appears on the cover and the close only. A logo row is
social proof; never list a logo you do not have permission to show; leave it
out. `.ed-logo-note` is a short caption at the end of the row. `--on-photo` forces logos to white, so it is
wrong on a light slide; use `--mono` there.

### Photo cover and close

```html
<section class="slide ed-photo ed-cover" style="--photo-bg-image:url('assets/cover.jpg')">
  <div class="ed-lockup">…</div>
  <div class="ed-cover-mid">
    <h1 class="ed-h1 ed-h1--lg">The one thing this deck is about.</h1>
    <p class="ed-lede">One sentence of sub-copy.</p>
    <p class="ed-small">Prepared for A. Rivera, Company. Date.</p>
  </div>
  <div class="ed-cover-foot">
    <p class="ed-small">Clients and partners</p>
    <div class="ed-logos ed-logos--on-photo">…</div>
  </div>
</section>

<!-- Close: an empty first child keeps the three-row composition. -->
<section class="slide ed-photo ed-cover" style="--photo-bg-image:url('assets/close.jpg')">
  <div></div>
  <div class="ed-cover-mid">
    <h1 class="ed-h1 ed-h1--lg">The concrete ask</h1>
    <p class="ed-lede">What happens next and when.</p>
    <a class="ed-cta" href="mailto:name@example.com">Book the next call</a>
  </div>
  <div class="ed-lockup">…</div>
</section>
```

The scrim is a vertical gradient from `--photo-scrim-rgb`, so the photo reads
across the full width with centered text. When not to: a busy photo with detail
behind the headline still fights the text; pick a calm one. Not for a content
slide; two photo slides is the usual budget (cover and close).

### Timeline track

```html
<div class="ed-track" style="--ed-track-n: 4">
  <div class="ed-step"><span class="ed-when">When</span><h3 class="ed-h3">Phase one</h3><p class="ed-body">What happens.</p></div>
  <div class="ed-step ed-step--b"><span class="ed-when">When</span><h3 class="ed-h3">Phase two</h3><p class="ed-body">What happens.</p></div>
  <div class="ed-step ed-step--milestone"><span class="ed-when">When</span><h3 class="ed-h3">The milestone</h3><p class="ed-body">What they see.</p></div>
  <div class="ed-step ed-step--a"><span class="ed-when">When</span><h3 class="ed-h3">Phase three</h3><p class="ed-body">What is true.</p></div>
</div>
```

`--ed-track-n` is the number of steps (default 3). When not to: more than five
steps stops fitting at 1280 wide; split the phases across two slides. Not for
things that do not happen in order.

### Video frame

```html
<div class="ed-video">
  <img class="ed-video__img" alt="Still from the walkthrough: its title" src="assets/still-1.jpg">
  <div class="ed-video__bar">
    <span class="ed-video__play"></span>
    <span class="ed-video__title">Walkthrough title</span>
    <span class="ed-video__len">0 min</span>
  </div>
</div>
```

A still with a play bar, for recorded walkthroughs (Loom or similar). Wrap the
frame in an `<a href>` if the recording is online. When not to: never embed a
live player; the deck is opened from `file://` and a third-party iframe may not
load. Not for a live demo; that is the classic `.demo-frame` (section 10).

### Placeholder

```html
<div class="ed-placeholder">
  <span class="ed-pill ed-pill--draft">For a named owner to complete</span>
  <p class="ed-lede">What this section needs to say, and who will write it.</p>
  <p class="ed-small">Move or delete this slide before the deck goes out.</p>
</div>
```

When not to: never in a deck that is leaving your hands. It exists for a
collaborator's section during drafting, and it is deliberately loud so nobody
ships it.

### CTA

```html
<a class="ed-cta" href="mailto:name@example.com?subject=Follow-up">Book the next call</a>
```

Ink on paper by default, a light pill on a photo slide. When not to: one CTA
per deck, on the close. A CTA on a content slide reads as a sales page.

### SVG diagrams and charts

```html
<svg class="ed-svg" viewBox="0 0 1000 150" role="img" aria-label="Describe the diagram in a sentence.">
  <rect class="ed-svg-voice-a" x="0" y="30" width="220" height="90" rx="12"/>
  <text class="ed-svg-t1" x="18" y="68">Stage one</text>
  <text class="ed-svg-t2" x="18" y="94">who owns it</text>
  <line class="ed-svg-line" x1="220" y1="75" x2="260" y2="75"/>
  <rect class="ed-svg-voice-b" x="260" y="30" width="220" height="90" rx="12"/>
  <rect class="ed-svg-gate" x="520" y="30" width="220" height="90" rx="12"/>
  <rect class="ed-svg-plain" x="780" y="30" width="220" height="90" rx="12"/>
  <path class="ed-svg-line ed-svg-line--dash" d="M630 30 V18 H110 V30"/>
  <text class="ed-svg-t3" x="370" y="14" text-anchor="middle">loop back label</text>
</svg>

<!-- Bar chart: today vs target -->
<!-- inside a card, keep the viewBox near 540 units wide (see the size note below) -->
<rect class="ed-svg-bar" x="0" y="32" width="520" height="24" rx="6"/>
<rect class="ed-svg-bar--target" x="0" y="60" width="330" height="24" rx="6"/>
<text class="ed-svg-t-on" x="12" y="78">Target</text>
```

| Class | For |
|---|---|
| `.ed-svg` (`--map`) | The `<svg>` itself. `--map` caps the height at 50vh for a tall process map. |
| `.ed-svg-voice-a` / `-voice-b` | Boxes owned by each voice. |
| `.ed-svg-gate` | A dashed decision point. |
| `.ed-svg-plain` | A neutral box. |
| `.ed-svg-bar` / `--target` | Chart bars: today in stone, target in voice A. |
| `.ed-svg-line` (`--dash`) | Connectors. |
| `.ed-svg-t1` / `t2` / `t3` | Box title, box detail, micro label. |
| `.ed-svg-t-on` | A label sitting on a filled target bar. |

The text classes are 15-18px at a scale of 1, so the SVG must never render
smaller than its viewBox. At 1280x720 a full-width diagram renders about 1100px
wide, so keep its viewBox at most 1100 units wide; a `--map` is capped at 50vh
(360px), so keep its viewBox at most 360 units tall; a chart inside a 7:4 split
card renders about 600px wide, so keep it near 540 units. Then no label drops
below the 15px floor (gotcha #20).
When not to: never put a literal color in the SVG (gotcha #11). If the labels
need a viewBox much wider than 1100 units to fit, the diagram has too many
boxes for one slide.

### Editorial component index

`.ed-after` · `.ed-body` · `.ed-brand` · `.ed-card` (`--outline`, `--voice-a`,
`--voice-b`, `--feature`, `--center`, `--row`) · `.ed-cover` · `.ed-cover-foot` ·
`.ed-cover-mid` · `.ed-cta` · `.ed-grid2` · `.ed-grid3` · `.ed-grid4` · `.ed-h1`
(`--lg`, `--sm`, `--wide`) · `.ed-h3` · `.ed-head` (`--row`) · `.ed-icon` ·
`.ed-lede` (`--wide`) · `.ed-list` · `.ed-lockup` (`__x`, `__word`) ·
`.ed-logo-note` · `.ed-logos` (`--on-photo`, `--mono`, `--start`) · `.ed-num`
(`--sm`) · `.ed-photo` · `.ed-pill` (`--a`, `--b`, `--draft`) · `.ed-placeholder` ·
`.ed-portrait` (`--lg`) · `.ed-quote` · `.ed-row` · `.ed-shot` (`--tilt`, `--crop`) ·
`.ed-small` · `.ed-snug` · `.ed-split` (`--even`, `--visual`, `--wide`, `--narrow`,
`--stretch`) · `.ed-stack` (`--tight`) · `.ed-step` (`--a`, `--b`, `--milestone`) ·
`.ed-steps` · `.ed-strong` · `.ed-svg` (`--map`) and the `.ed-svg-*` set ·
`.ed-track` · `.ed-video` (`__img`, `__bar`, `__play`, `__title`, `__len`) ·
`.ed-when`

Custom properties a deck may set inline: `--ed-split-cols`, `--ed-grid-cols`,
`--ed-track-n`, `--photo-bg-image`. To change the two voices for a brand,
define the optional hooks `--voice-a` and `--voice-b` in the theme file's
`:root` (never in a `<style>` block). Do not redefine `--ed-voice-a` there:
`editorial.css` loads after the theme and would win. The `-soft` tints follow
automatically.

### Classic components in an editorial deck

The numbered sections below still work, because `deck-base.css` is always
loaded. The table (section 8), spectrum (7), terminal (17) and live demo (10)
have no editorial equivalent; use them as they are. Do **not** mix classic
headings into an editorial deck: no `.kicker` + `.slide-title` pairs next to
`.ed-h1` slides.

---

# Classic slide types

These are the `deck-base.css` slide types (`new-deck.mjs --classic`).

## 1. Cover — photo, logo, hero visual

Use for: slide 1, always. The only slide with a logo.

```html
<section class="slide cover" style="--photo-bg-image:url('assets/hero.jpg')">
  <div class="cover-left">
    <img class="deck-logo" src="assets/logo.svg" alt="Company logo">
    <h1 class="slide-title">The one thing this deck is about.</h1>
    <h2 class="slide-sub">One sentence of sub-copy. State the outcome, not the process.</h2>
    <div class="brandline">Presenter name · Company · 1 January 2027</div>
  </div>
  <div class="cover-mid">
    <div class="shot"><img src="assets/hero-product.png" alt="Product dashboard"></div>
  </div>
  <div class="cover-right"></div>
</section>
```

- The right column is **deliberately empty** — it is what lets the photo read
  through the gradient falloff. Do not fill it "to balance".
- Drop `.cover-mid` entirely for a text-only cover; the grid holds.
- The photo must be wide and busy on the RIGHT, quiet on the left, because the
  scrim is opaque on the left. Crop accordingly before you use it.
- A light theme needs the dark variant of the logo asset, and vice versa.

**Text-only hero variant** (no cover grid, scrim runs left-to-right):

```html
<section class="slide photo-slide" style="--photo-bg-image:url('assets/hero.jpg')">
  <div class="kicker">Eyebrow</div>
  <h1 class="slide-title slide-title--lg">Headline over a photograph.</h1>
  <h2 class="slide-sub">Sub-copy.</h2>
  <div class="brandline">Attribution line</div>
</section>
```

---

## 2. Statement — one sentence, centred

Use for: the thesis, an act break, a question you want to sit with.

```html
<section class="slide center-slide">
  <div class="kicker">Section</div>
  <h1 class="slide-title slide-title--lg">One sentence that earns the whole slide.</h1>
  <h2 class="slide-sub">At most one line of qualification. Usually none.</h2>
</section>
```

Add `paperwhite` to the class list for a textured off-white act break that
signals "new chapter" without a new template: `class="slide center-slide paperwhite"`.

---

## 3. Standard content — title, sub, list

The workhorse. Use for: anything that is a short argued list.

```html
<section class="slide">
  <div class="kicker">Eyebrow</div>
  <h1 class="slide-title">The claim this slide proves.</h1>
  <h2 class="slide-sub">The one-line version of the argument.</h2>
  <ul class="clean">
    <li><strong>Named thing.</strong> What it is and why it matters here.</li>
    <li><strong>Named thing.</strong> What it is and why it matters here.</li>
    <li><strong>Named thing.</strong> What it is and why it matters here.</li>
  </ul>
  <div class="footnote">Source or caveat.</div>
</section>
```

List variants:

| Class | Use for |
|---|---|
| `ul.clean` | 3-5 argued points. Gradient dot marker, hairline row divider. The default. |
| `ul.tight` | 6+ dense detail lines. En-dash marker, no dividers. Never the primary list on a slide. |
| `ul.check-list` | Feature/benefit summary where every item is a *yes*. Lime checkmark. |
| `.step-list` | An ordered process. Gradient-filled numerals. Never use it for an unordered list — the numbers imply sequence. |

```html
<ol class="step-list">
  <li><strong>First move.</strong> What happens and who does it.</li>
  <li><strong>Second move.</strong> What happens and who does it.</li>
</ol>
```

---

## 4. Two-column

Use for: before/after, cause/consequence, text beside a visual.

```html
<section class="slide">
  <div class="kicker">Eyebrow</div>
  <h1 class="slide-title">Two columns, one comparison</h1>
  <h2 class="slide-sub">Say what the reader should compare.</h2>
  <div class="two-col">
    <div>
      <div class="shot shot--col"><img src="assets/before.png" alt="Before state"></div>
      <div class="col-heading--plain">Before</div>
      <ul class="check-list">
        <li>Point</li>
        <li>Point</li>
      </ul>
    </div>
    <div>
      <div class="shot shot--col"><img src="assets/after.png" alt="After state"></div>
      <div class="col-heading--plain">After</div>
      <ul class="check-list">
        <li>Point</li>
        <li>Point</li>
      </ul>
    </div>
  </div>
</section>
```

Ratio and alignment modifiers — add to the `.two-col` element:

| Class | Effect | Use when |
|---|---|---|
| *(none)* | 1 : 1, top-aligned | Default. Two peers. |
| `two-col--wide-left` | 1.25 : 1 | Text-heavy left, diagram right. |
| `two-col--wide-right` | 0.85 : 1.15 | Short label left, dominant visual right. |
| `two-col--center` | vertically centred | **Only** when both columns are guaranteed near-equal height. Otherwise it opens a dead gap — see gotchas. |
| `two-col--divided` | vertical rule between | Cause/consequence, us/them. |

Arbitrary ratio: `style="--col-a: 2; --col-b: 1"`.

**Column ordering rule:** put the `.shot` or `.media-frame` FIRST and the
`.col-label` / heading AFTER it, never before. Every column in a row must follow
the same order or the headings won't line up.

```html
<div class="two-col two-col--wide-left">
  <div>
    <div class="media-frame" style="--media-h: 22vh">
      <svg viewBox="0 0 400 200"><!-- see §11 for themed SVG --></svg>
    </div>
    <div class="col-label">
      <div class="col-eyebrow">Eyebrow</div>
      <div class="col-heading">Heading</div>
    </div>
    <p>Body copy.</p>
  </div>
  <div>…same order…</div>
</div>
```

Set the **same** `--media-h` on every `.media-frame` in a row so the diagrams
bottom-align and the headings under them share a baseline.

---

## 5. Card grid — principles, values, capabilities

Use for: 3 or 4 parallel things that are peers, none recommended over another.

```html
<section class="slide">
  <div class="kicker">Eyebrow</div>
  <h1 class="slide-title">Four things, one grid</h1>
  <div class="principle-grid" style="--cols: 4">
    <div class="principle-card">
      <div class="card-media">
        <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet">
          <rect class="svg-box" x="40" y="68" width="44" height="44" rx="9"/>
          <circle class="svg-accent" cx="62" cy="90" r="6"/>
        </svg>
      </div>
      <h3>Name</h3>
      <p>One or two sentences. Not a list disguised as a card.</p>
    </div>
    <!-- repeat -->
  </div>
</section>
```

`.card-media` is optional — drop it for a text-only card grid. Set `--cols: 3`
for a 3-up. Beyond 4 columns the cards stop being readable at 1280 wide; use
`ul.clean` instead.

---

## 6. Option cards — three ways to do it, one recommended

Use for: a choice you are guiding the audience through. Distinct from §5: these
are **not** peers, one is recommended.

```html
<section class="slide">
  <div class="kicker">The options</div>
  <h1 class="slide-title">Three paths, one recommendation</h1>
  <div class="grid3">
    <div class="option-card">
      <h3>Option A</h3>
      <div class="thesis">The one-line case for it.</div>
      <ul class="tight"><li>Detail</li><li>Detail</li></ul>
      <div class="chip-row"><span class="chip">4 weeks</span><span class="chip">1 person</span></div>
    </div>
    <div class="option-card recommended">
      <div class="badge">Recommended</div>
      <h3>Option B</h3>
      <div class="thesis">The one-line case for it.</div>
      <ul class="tight"><li>Detail</li><li>Detail</li></ul>
      <div class="chip-row"><span class="chip">8 weeks</span><span class="chip">2 people</span></div>
    </div>
    <div class="option-card">
      <h3>Option C</h3>
      <div class="thesis">The one-line case for it.</div>
    </div>
  </div>
  <div class="note"><strong>Why B.</strong> The reason, in one sentence.</div>
</section>
```

The `.badge` text is required, not decorative — the blue border alone is not an
accessible signal. Use `.badge--center` to centre the ribbon instead of
right-aligning it.

---

## 7. Spectrum — a continuous trade-off with named stops

Use when the choice is **not** three discrete products but a position on an
axis (cheap↔thorough, fast↔durable, pilot↔rollout). Better than option cards
whenever the real answer is "somewhere along here".

```html
<section class="slide">
  <div class="kicker">The trade-off</div>
  <h1 class="slide-title">It's a dial, not three buttons</h1>
  <div class="spectrum">
    <div class="spectrum-track"></div>
    <div class="spectrum-stops">
      <div class="spectrum-stop">
        <div class="spectrum-dot" style="background: var(--violet)"></div>
        <h3>Narrow</h3>
        <p>What this end buys you.</p>
      </div>
      <div class="spectrum-stop recommended">
        <div class="badge badge--center">Recommended</div>
        <div class="spectrum-dot" style="background: var(--blue)"></div>
        <h3>Balanced</h3>
        <p>What this position buys you.</p>
      </div>
      <div class="spectrum-stop">
        <div class="spectrum-dot" style="background: var(--cyan-strong)"></div>
        <h3>Broad</h3>
        <p>What this end buys you.</p>
      </div>
    </div>
    <div class="spectrum-axis"><span>Faster, cheaper</span><span>Slower, more durable</span></div>
  </div>
</section>
```

The dot colours are the one place a `var(--token)` inline style is correct —
they must sample the gradient track underneath them.

---

## 8. Table

Use for: anything with more than two dimensions. Neither source deck's base had
a table and both suffered for it — do not rebuild a table out of `.grid4`.

```html
<section class="slide">
  <div class="kicker">Eyebrow</div>
  <h1 class="slide-title slide-title--sm">What it comprises</h1>
  <table class="deck-table">
    <thead>
      <tr><th>Item</th><th>What it covers</th><th class="num">Weeks</th></tr>
    </thead>
    <tbody>
      <tr><td>Discovery</td><td>Interviews, systems map</td><td class="num">2</td></tr>
      <tr><td>Build</td><td>Two working modules</td><td class="num">4</td></tr>
      <tr><td class="total">Total</td><td></td><td class="num total">6</td></tr>
    </tbody>
  </table>
  <div class="cite">Assumes a single workstream and no parallel review cycle.</div>
</section>
```

`td.num` right-aligns and sets mono. `td.total` bolds and accents. Rows
zebra-stripe automatically. Use `.slide-title--sm` on a table slide — a full-size
title plus a table overflows at 1280x720.

---

## 9. Screenshots

Pick the right variant. This is where both source decks lost the most time.

```html
<!-- Standalone, centred. Chrome sizes to the image, never the column. -->
<section class="slide center-slide">
  <div class="kicker">Eyebrow</div>
  <h1 class="slide-title">What you are looking at</h1>
  <div class="shot"><img src="assets/screen.png" alt="Describe what the screen shows"></div>
  <div class="shot-cap">Caption naming the screen.</div>
</section>

<!-- Full diagram that must not be cropped. No card chrome, no clipping. -->
<section class="slide center-slide">
  <h1 class="slide-title">System map</h1>
  <div class="shot shot--plain"><img src="assets/diagram.png" alt="Architecture diagram"></div>
</section>
```

| Variant | Use when | Never |
|---|---|---|
| `.shot` | Standalone, centred, inside `.demo-frame` or `.thumb-row` | Beside left-aligned text — it drifts away from the copy |
| `.shot--col` | Inside a `.two-col` column, paired with text | — |
| `.shot--plain` | A full diagram or full-page capture that must show entirely | For a UI screenshot that benefits from card chrome |
| `.shot--sm` | Thumbnails in a `.thumb-row` | As the primary visual |

Capture rules: PNG, never JPEG, for anything with small UI text. Region-targeted
capture, not a full-viewport grab. Every `<img>` needs a real `alt` — `qa-deck.mjs`
check (e) fails on a missing one.

---

## 10. Live demo placeholder

Use for: "we'll drive this live from here."

```html
<section class="slide center-slide">
  <div class="kicker"><span class="live-dot"></span>Live demo</div>
  <h1 class="slide-title">What we'll show you</h1>
  <div class="demo-frame">
    <img class="deck-logo deck-logo--sm" src="assets/glyph.svg" alt="" aria-hidden="true">
    <div class="demo-label">Live demo</div>
    <div class="demo-note">What you'll click through and why it matters.</div>
    <div class="thumb-row">
      <div class="shot shot--sm"><img src="assets/t1.png" alt="Bookings queue"></div>
      <div class="shot shot--sm"><img src="assets/t2.png" alt="Reconciliation view"></div>
    </div>
  </div>
</section>
```

Always keep a thumbnail row. A live demo that fails leaves you with a dashed
empty box otherwise.

---

## 11. Diagram (inline SVG)

Use the shared label classes. **Never** put a literal colour inside an SVG in a
themed deck — it renders invisible the moment the theme swaps.

```html
<section class="slide">
  <div class="kicker">How it works</div>
  <h1 class="slide-title slide-title--sm">Three stages, one loop</h1>
  <svg viewBox="0 0 900 260" style="width:100%;height:auto">
    <rect class="svg-box" x="20"  y="60" width="200" height="90" rx="10"/>
    <text class="svg-strong" x="120" y="100" text-anchor="middle">Capture</text>
    <text class="svg-cap"    x="120" y="122" text-anchor="middle">inputs land here</text>

    <line class="svg-rule" x1="230" y1="105" x2="330" y2="105"/>

    <rect class="svg-box" x="340" y="60" width="200" height="90" rx="10"/>
    <text class="svg-strong" x="440" y="100" text-anchor="middle">Synthesise</text>
    <text class="svg-num"    x="440" y="126" text-anchor="middle">3x</text>

    <text class="svg-tick" x="20" y="200">0</text>
    <text class="svg-tick" x="860" y="200" text-anchor="end">100</text>
    <text class="svg-label" x="440" y="230" text-anchor="middle">Axis label</text>
  </svg>
  <div class="cite">Illustrative.</div>
</section>
```

| Class | For |
|---|---|
| `.svg-strong` | Box titles, emphasised values |
| `.svg-label` | Default label text |
| `.svg-num` | A numeric readout inside a box (mono, bold) |
| `.svg-tick` | Axis ticks and scale marks (mono, small) |
| `.svg-cap` | Captions and annotations |
| `.svg-muted` | Secondary/de-emphasised series |
| `.svg-box` | Box fill + border, themed |
| `.svg-rule` | Connector and grid lines |
| `.svg-accent` | An accented shape fill |

---

## 12. Stats row

```html
<div class="stats-row">
  <div class="stat"><span class="stat-num">8</span><span class="stat-label">Documented gotchas, fixed by default</span></div>
  <div class="stat"><span class="stat-num">3</span><span class="stat-label">Themes shipped</span></div>
  <div class="stat"><span class="stat-num">&lt;1h</span><span class="stat-label">From brief to reviewable deck</span></div>
</div>
```

Three to five tiles. Two looks unfinished; six stops scanning.

---

## 13. Headline number

Use for: the one number the audience should leave with. **One per deck.**

```html
<section class="slide center-slide">
  <div class="kicker">The number</div>
  <div class="price-hero">42 days</div>
  <div class="price-sub">median, across the last six engagements</div>
  <div class="price-note">One sentence saying what the number means and what it excludes.</div>
</section>
```

Two competing hero numbers read as a dashboard, not a point.

---

## 14. Quote

```html
<div class="quote">
  "The sentence someone actually said."
  <span class="quote__cite">Role, context — date</span>
</div>
```

`.quote--accent-blue` for a second, contrasting voice on the same slide. Do not
stack more than two quotes on one slide.

---

## 15. Annotation boxes

One component, four semantic modifiers. Do not invent a fifth box.

```html
<div class="note"><strong>Note.</strong> A short inline caveat or claim.</div>
<div class="note note--warn"><strong>Risk.</strong> What could go wrong.</div>
<div class="note note--info"><strong>Context.</strong> Something the reader needs to know.</div>
<div class="note note--success"><strong>Confirmed.</strong> Something already true.</div>

<div class="callout">
  A longer standalone aside that needs its own frame. <strong>One per slide.</strong>
</div>
```

---

## 16. People

```html
<!-- 2-up bios with real copy -->
<section class="slide slide-people">
  <div class="people-wrap">
    <div class="kicker">Who's presenting</div>
    <h1 class="slide-title">Built by people who've shipped this before</h1>
    <div class="people-grid people-grid--duo">
      <div class="person-card person-card--row">
        <img src="assets/person-a.jpg" alt="Portrait of A. Rivera">
        <div>
          <div class="p-name">A. Rivera</div>
          <div class="p-role">Founder</div>
          <div class="p-bio">Two or three lines of relevant background.</div>
        </div>
      </div>
      <!-- repeat -->
    </div>
  </div>
</section>

<!-- 5-up team row, photo above name -->
<div class="people-grid" style="--people-cols: 5">
  <div class="person-card">
    <img src="assets/person.jpg" alt="Portrait of B. Okafor">
    <div class="p-name">B. Okafor</div>
    <div class="p-role">Engineering</div>
    <div class="p-bio">One line.</div>
  </div>
</div>
```

`.slide-people` + `.people-wrap` centre the heading **and** the grid as one
block. Without the wrapper the grid centres and the heading pins left, which
reads as a mistake.

---

## 17. Terminal

Use for: showing a command-line product without a screenshot.

```html
<div class="term">
  <div class="term__bar">
    <span class="term__dot"></span><span class="term__dot"></span><span class="term__dot"></span>
    <span class="term__title">~/workspace</span>
  </div>
  <div class="term__body">
    <div class="term__line"><span class="term__prompt">$</span>tool status</div>
    <div class="term__line">3 items ready to sync</div>
    <div class="term__line"><span class="term__prompt">$</span><span class="term__caret"></span></div>
  </div>
</div>
```

The caret blink is pure CSS and keeps animating with no JS. To type it out, have
the deck's script append `.term__line` elements on a timer.

---

## 18. Dense detail

Use for: the appendix-flavoured "what's under the hood" slide.

```html
<section class="slide">
  <div class="kicker">Under the hood</div>
  <h1 class="slide-title slide-title--sm">What it actually runs on</h1>
  <div class="tech-blurb">
    <ul class="tight">
      <li>Detail</li><li>Detail</li><li>Detail</li>
      <li>Detail</li><li>Detail</li><li>Detail</li>
    </ul>
  </div>
  <div class="footnote footnote--micro">Versions as of the deck date.</div>
</section>
```

`.tech-blurb ul.tight` flows into two columns automatically.

---

## 19. Close

```html
<section class="slide close-slide center-slide" style="--photo-bg-image:url('assets/close.jpg')">
  <div class="kicker">Next step</div>
  <h1 class="slide-title">The question you want them thinking about.</h1>
  <h2 class="slide-sub">Or the concrete ask.</h2>
  <div class="cta-btn">Book the next session</div>
  <div class="mission-line">One or two sentences. No more.</div>
</section>
```

`.close-slide` uses the **vertical** scrim (dark top and bottom, photo readable
across the full width) — the right shape for centred text. `.photo-slide` uses
the **horizontal** scrim, for text pinned left. Do not swap them.

---

## Slide-count and density guidance

| Deck kind | Slides | Shape |
|---|---|---|
| Demo | 8-12 | Cover · statement · problem · 2-3 product · live demo · people · close |
| Proposal | 12-16 | Cover · diagnosis · options/spectrum · detail · table · people · close |
| Update | 6-9 | Cover · statement · stats · 2-3 content · close |

Density rule: if a slide needs `.slide-title--sm` **and** a `.footnote--micro`
to fit, it is two slides. `qa-deck.mjs` check (c) will tell you at 1280x720 and
1440x810 — run it rather than eyeballing your own screen.

## Component index

`.badge` · `.brandline` · `.callout` · `.card-media` · `.center-slide` ·
`.check-eyebrow` · `.chip` · `.chip-row` · `.cite` · `.close-slide` ·
`.col-eyebrow` · `.col-heading` · `.col-heading--plain` · `.col-label` ·
`.cover` · `.cover-left` · `.cover-mid` · `.cover-right` · `.cta-btn` ·
`.deck--horizontal` · `.deck-logo` (`--sm`, `--lg`, `--inline`) · `.deck-table` ·
`.demo-frame` · `.demo-label` · `.demo-note` · `.footnote` (`--micro`) ·
`.grid3` · `.grid4` · `.grid-auto` · `.kicker` · `.live-dot` · `.media-frame`
(`--fill`) · `.mission-line` · `.navhint` · `.note` (`--warn`, `--info`,
`--success`) · `.option-card` (`.recommended`) · `.paperwhite` · `.people-grid`
(`--duo`) · `.people-wrap` · `.person-card` (`--row`) · `.photo-slide`
(`--vertical`) · `.price-hero` · `.price-note` · `.price-sub` ·
`.principle-card` · `.principle-grid` · `.progress` · `.quote`
(`--accent-blue`) · `.quote__cite` · `.shot` (`--col`, `--plain`, `--sm`) ·
`.shot-cap` · `.side-brand` · `.slide` · `.slide-people` · `.slide-sub` ·
`.slide-title` (`--sm`, `--lg`) · `.spectrum` (`-track`, `-stops`, `-stop`,
`-dot`, `-axis`) · `.stat` · `.stats-row` · `.step-list` · `.svg-accent` ·
`.svg-box` · `.svg-cap` · `.svg-label` · `.svg-muted` · `.svg-num` · `.svg-rule` ·
`.svg-strong` · `.svg-tick` · `.tech-blurb` · `.term` (`__bar`, `__dot`,
`__title`, `__body`, `__line`, `__prompt`, `__caret`) · `.thumb-row` ·
`.two-col` (`--center`, `--divided`, `--wide-left`, `--wide-right`) ·
`ul.check-list` · `ul.clean` · `ul.tight` · `.wide`

### Aliases — recognised, but do not reach for them

`deck-base.css` also answers to `.aios-logo`, `.path-card`, `.value-card` and
`table.cost`. They exist so markup lifted from an older deck keeps rendering, and
they are deliberately left out of the index above. Use the canonical names in
anything new: `.deck-logo`, `.option-card`, `.principle-card`, `table.deck-table`.

## Unvalidated components

A component earns a place in `deck-base.css` once a **second** deck needs it.
If you build something reusable that only one deck has used, list it here rather
than promoting it.

- (none yet)

The `ed-` components above came from a single production deck and were promoted to
the default by an owner decision rather than by the second-deck rule, because
the improvement over the classic look was judged large enough to ship to every
new deck. Treat any new `ed-` component under the normal rule.
