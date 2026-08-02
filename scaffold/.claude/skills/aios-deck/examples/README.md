---
status: final
owner: example
access: team
created: 2026-07-29
type: "Deliverable"
---

# Example decks

Two complete, presentable decks. They are the **quality bar** — read one end to
end before you write a slide. `reference/slide-catalog.md` is the parts list;
these are what the parts are supposed to add up to.

| Folder | Deck | Theme | Slides | Shows |
|---|---|---|---|---|
| [`product-demo-dark/`](product-demo-dark/deck.html) | Tideline product demo | `aios-dark` | 10 | Cover with hero shot · statement · problem · before/after · diagram · terminal · live demo · stats + quotes · 2-up bios · close |
| [`proposal-light/`](proposal-light/deck.html) | Partner-onboarding proposal | `prism-light` | 13 | Text-only cover · diagnosis · what we heard · cause/consequence · act break · spectrum · options · detail + schedule · table · headline number · risks · 5-up team · close |

Each folder is **self-contained** and opens from `file://` by double-clicking
`deck.html`. Nothing references a path outside its own folder
(`reference/gotchas.md` #13).

```
<deck>/
├── deck.html        the deck
├── deck-base.css    copied verbatim from ../../assets/
├── theme.css        copied verbatim from ../../assets/themes/<slug>.css
├── deck-nav.js      copied verbatim from ../../assets/
└── MANIFEST.md      slide-by-slide index + revision log
```

## Everything here is fictional

**Northwind Labs**, its product **Tideline**, the consultancy **Harbourline
Partners**, every person named, every figure, every quote, every logo and every
screenshot are invented for this example. This repo is public: never put a real
client, company, person, price or screenshot in `examples/`. If you need a
sample, extend the fiction above rather than anonymising something real.

## What to copy from these

- **The narrative arc.** One point per slide, in an order that argues. Neither
  deck has a slide that is only "here is some more information".
- **The colour rationing.** `aios-dark` spends at most one *filled* lime action
  per slide (the live dot, the CTA pill). `prism-light` spends cobalt only on
  "recommended" — the spectrum's middle stop and the recommended option card,
  nowhere else. Break either rule and the one moment that carries a decision
  stops registering.
- **Density.** Both decks clear `qa-deck.mjs` check (c) at 1280x720 **and**
  1440x810 with zero overflow. If a slide of yours needs `--sm` *and*
  `--micro` to fit, it is two slides.
- **Real `alt` on every image**, and a `.progress` whose static text matches the
  real slide count.

## The image trick these decks use

Every image is an inline `data:image/svg+xml;utf8,…` URI, so a deck folder is
four files and weighs under 150 KB with no binary assets. Three encoding rules
make that safe, and all three are load-bearing:

1. **Percent-encode `#` as `%23`.** A raw `#` starts a URL fragment and silently
   truncates the rest of the SVG.
2. **Write `alt` before `src` on every `<img>`.** The data URI contains `>`
   characters, and a regex-based tag scan (including `qa-deck.mjs` check (e) on
   its no-browser path) stops at the first one.
3. **In a CSS `url('…')`, percent-encode the SVG's own `'` as `%27`.** Otherwise
   the SVG's first attribute quote terminates the CSS string, the
   `background-image` declaration is dropped whole, and the slide loses its
   photo *and* its scrim — white text on a white slide, with no error anywhere.

For a real deck, real screenshots are still better (`reference/gotchas.md` #6:
PNG, region-targeted). The data-URI approach exists so `examples/` can ship
plausible visuals without committing binaries to a public repo.

## Verify

```bash
node ../scripts/qa-deck.mjs product-demo-dark/deck.html
node ../scripts/qa-deck.mjs proposal-light/deck.html
```

Both must exit 0. The overflow check needs a browser; set
`AIOS_DECK_BROWSER_DIR` to a directory from which `playwright` resolves, or
check (c) SKIPs and only the static checks gate.
