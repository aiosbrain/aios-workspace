# Brand schema — creating your own deck theme

The escape hatch from the two shipped themes, and the intake path for
"here are our logo and colours, make it ours". Treat this as a **schema**: fill
the form, apply the mapping, apply the derivation rules, lint. Don't freestyle a
palette.

## What this is modelled on

| Source | What it contributes |
|---|---|
| Anthropic `theme-factory` (github.com/anthropics/skills, `skills/theme-factory`) | Every colour carries a **semantic role**, never a raw hex. Canonical form: `Deep Navy #1a2332 - Primary background color`. Theme files stay small, human-readable markdown. And the protocol **blocks** on the user choosing a theme rather than silently defaulting. |
| `anthropics/skills` `frontend-design` | A brand is 4-6 named hexes + display / body / utility typefaces + a layout concept + **one signature element** the design is remembered for. Also the named-cliché list under "Anti-slop", below. |
| `robonuggets/marp-slides` | Examples are the quality bar. Reading 2-3 complete reference decks beats any volume of prose rules — so `examples/` is part of the contract, not decoration. |

**Blocking rule, inherited from `theme-factory`:** do not silently default to
`aios-dark` or `prism-light`. Ask which theme, or run the intake form.

---

## 1. Intake form

Hand this to the user, or ask them to fill it. One pass, no follow-ups needed.

```
BRAND NAME:            e.g. Northwind
SLUG:                  lowercase-hyphenated, becomes themes/<slug>.css
MODE:                  light | dark

COLOURS (4-6, each "Name #hex — role"):
  1.                   e.g. Ink #0f1115 — primary background
  2.                                     — primary surface / card
  3.                                     — primary text
  4.                                     — primary accent (brand hue)
  5.  (optional)                         — secondary accent
  6.  (optional)                         — status / highlight

TYPEFACES:
  Display:             headline face
  Body:                running text face
  Mono / utility:      code, chips, eyebrow labels
  Web-font source:     Google Fonts @import URL, OR "system stack" + the stack
                       (handover decks are file:// — no npm, no local font files
                       unless they ship inside the deck folder)

LOGO:
  Path:
  Intrinsic height:    px at 1x
  Variants:            light-background version? dark-background version?
                       (state which asset for which; a single-colour mark that
                       only works on one background is a constraint to record)

LAYOUT CONCEPT (one sentence):
  e.g. "Editorial: wide left margin, text hangs off a single vertical rule."

SIGNATURE ELEMENT (exactly one):
  the thing the deck is remembered for — a gradient rule, an oversized numeral,
  a duotone photo treatment. One. Not three.
```

Missing a field? Ask. Don't invent a brand colour.

---

## 2. Named-role → token mapping

The deck token contract is **32 required tokens plus 2 optional**
(`--accent-bar-height`, `--deck-logo-height`). The authoritative list is the
`/* @token-contract:begin */ … :end */` block at the top of
`assets/deck-base.css` — `qa-deck.mjs` parses that block, so it is what actually
gates. The required set splits into two groups.

### Group A — the tokens that alias 1:1 onto `@aios-alpha/design` (v0.3.0)

If the brand is AIOS, or you're deriving from a package-backed design system,
these are a direct copy. No judgement calls.

| Deck token | Package source | Intake role |
|---|---|---|
| `--bg` | `--aios-bg` | primary background |
| `--surface` | `--aios-surface` | primary surface / card |
| `--elevated` | `--aios-elevated` | raised card |
| `--fg` | `--aios-fg` | primary text |
| `--fg-2` | `--aios-fg-secondary` | secondary text |
| `--fg-3` | `--aios-fg-muted` | micro-labels, footnotes |
| `--border` | `--aios-border` | hairline dividers |
| `--border-visible` | `--aios-border-visible` | card outlines |
| `--border-strong` | `--aios-border-strong` | emphasis outlines |
| `--violet` | `--aios-violet` | primary accent (brand hue) |
| `--cyan` | `--aios-cyan` | tertiary accent |
| `--emerald` | `--aios-emerald` | positive / success |
| `--amber` | `--aios-amber` | caution |
| `--red` | `--aios-destructive` | negative / risk |
| `--lime` | `--aios-accent` | live / active status |
| `--gradient-prism` | `--aios-gradient-prism` | signature gradient |
| `--font-display` / `--font-body` / `--font-mono` | `--aios-font-*` | typefaces |

### Group B — 13 tokens with NO package source

These have to be **derived**. Each rule below is followable — apply it, don't
guess.

| Token | Derivation rule |
|---|---|
| `--violet-strong` | One step of the primary hue **in the direction that increases contrast against `--surface`** — which means the step goes the OPPOSITE way in each mode. Light theme: darker (`#7c3aed → #6d28d9`). Dark theme: **lighter** (`#8b5cf6 → #a78bfa`) — going darker on a near-black surface is the intuitive move and it is wrong, because this token carries small text (list markers, `.person-card .p-role`, `td.total`). **Must hold ≥4.5:1 against `--surface`**; check it, don't assume. |
| `--cyan-strong` | Same relationship to `--cyan`, and the same mode inversion: darker on light, lighter on dark. Used for the `.note--info` left border. Note the package's own light-mode `cyan` is already the dark step, so on a light theme derived from the package you usually assign the package value to `--cyan-strong` and pick a lighter teal for `--cyan` (see `themes/aios-light.css`). |
| `--blue` | A secondary accent **distinct from the primary hue**. Used for "recommended option" ribbons and one quote variant. If the brand has no second accent, derive it by rotating the primary hue toward blue. Do **not** just reuse `--violet` — the recommended-option ribbon loses its meaning if it's the same colour as everything else. |
| `--page-backdrop` | The colour *behind* the slides — visible in the scroll gutter and around a scaled-down deck. Dark theme: darker than `--bg` (pure black works). Light theme: a desaturated grey. **Never equal to `--bg`**, or the slide edges vanish and the deck reads as one endless page. |
| `--kicker-color` | The eyebrow label. This is the one deliberate accent-on-body-text moment in the system. Dark theme: the accent (lime). Light theme: the strong primary. **≥4.5:1 on `--bg`.** |
| `--accent-fg` | Text sitting ON a filled `--lime` surface (the CTA pill). **Near-black in EVERY theme, light or dark** — lime is a bright colour in all of them, so this is mode-independent exactly like `--photo-fg`. Do **not** set it to `--bg`: on a light theme that puts white on citron at roughly 1.7:1 and the one call to action in the deck becomes unreadable. Where a package ships an `accent-fg`, use it. |
| `--photo-fg` | **Always `#ffffff`**, regardless of base theme mode. |
| `--photo-fg-soft` | **Always white at 85%** (`rgba(255,255,255,0.85)`), regardless of base theme mode. Both photo-text tokens are mode-independent because the scrim behind them is always dark. |
| `--photo-scrim-rgb` | ⚠️ **AN RGB TRIPLET, NOT A COLOUR.** Consumed as `rgba(var(--photo-scrim-rgb), 0.88)`, so the value must be bare comma-separated numbers: `6, 6, 8`. Writing `#060608` here **silently breaks every photo slide** — no error, the overlay just doesn't paint. This is the single most error-prone token in the contract; check it first when a photo slide looks wrong. Value: a near-black tinted very slightly toward the brand's primary hue. |
| `--shot-shadow` | Dark theme: a large soft black shadow **plus a 1px light hairline** — `0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.03)` — so the screenshot card edge separates from a near-black background. Light theme: two stacked shadows tinted with the text colour, **no hairline**. |
| `--font-kicker` | The mono face on a dark/product theme (technical register); the body face on a light/proposal theme (editorial register). |
| `--weight-display` | **Typeface-dependent, and a real trap.** A display serif with no true bold axis (e.g. Instrument Serif) must use `400` and lean on size and italic for emphasis — setting `700` triggers a synthesized faux-bold that looks broken. A grotesque with real weights (e.g. Bricolage Grotesque) uses `800`. **Check the font's actual available axes before choosing.** |
| `--weight-heading` | Same rule. No-bold-axis serif: `400`. Real-weight grotesque: `700`. |
| `--accent-bar-height` | The gradient rule across the top of every slide. `3px` on dark (a hairline signature), `5px` on light (needs more presence to register). Genuinely optional — falls back to `4px` if omitted. |
| `--deck-logo-height` | The intrinsic height of the cover logo, from the intake form's LOGO block. Optional — falls back to `26px`. Set it from the asset you were actually given rather than scaling a small raster up; a stretched logo is the most common cover defect. Record in the theme's role card which background variant the asset is for: a light theme needs the dark logo, and vice versa. |

---

## 3. Anti-slop calibration

These are the looks that read as **templated AI defaults**. Avoid them.

- Cream `#F4F1EA` + a serif + a terracotta accent — "the AI editorial look".
- Near-black + acid/neon green — "the AI terminal look".
- Broadsheet hairline rules and all-caps micro-labels used **decoratively**
  rather than functionally.
- Purple-to-blue gradients on everything; gradient text; glassmorphism cards.
- Emoji as section icons.
- A stock "abstract network of glowing nodes" hero image.
- Centre-aligned everything.

The point isn't that these are ugly. Some of them are fine in isolation. The
point is that they are the **unchosen default** — the tell that nobody made a
decision. A brand that arrives at cream-and-terracotta *on purpose*, with a
reason, is a brand. A deck that arrives there because it's what came out is
slop.

**What to do instead:** commit to ONE signature element and let everything else
be quiet. Restraint is the differentiator, not more ideas.

**Honest note on our own theme:** the AIOS dark theme's `--gradient-prism` is
violet→emerald→lime, which is adjacent to the purple-gradient cliché above. It
earns its place by **rationing** — it appears only on a 3px accent bar, the list
markers, and the step numerals. Never on text. Never on a card background.
Rationing is what stops a gradient reading as slop; volume is what makes it one.

---

## 4. Contrast + accessibility gates

Check these while deriving, not after shipping.

| Check | Minimum |
|---|---|
| Body text (`--fg`) on `--bg` | ≥4.5:1 |
| Secondary text (`--fg-2`) on `--bg` | ≥4.5:1 |
| Micro-labels (`--fg-3`) on `--bg` | ≥3:1 hard floor; **flag it** if under 4.5:1 |
| `--kicker-color` on `--bg` | ≥4.5:1 |
| `--violet-strong` on `--surface` | ≥4.5:1 (renders as small text) |

Plus one non-numeric gate: **every colour that carries meaning must also be
distinguishable without colour.** The recommended-option ribbon carries a text
label, not just a blue border. Status is stated, not only tinted.

---

## 5. Workflow

1. **Fill the intake form.** Block on it — don't default to a shipped theme.
2. **Derive Group A** by direct mapping from the table above.
3. **Derive Group B** by the rules above. Double-check `--photo-scrim-rgb` is a
   bare triplet and the weight tokens match the typeface's real axes.
4. **Write `themes/<slug>.css`**, with the required header comment:
   ```css
   /* Theme: <Brand Name> — <one line>
      Mode: light | dark
      Derived against: @aios-alpha/design v0.3.0
      Source hash: <hash of the package token file>
      Date: YYYY-MM-DD */
   ```
5. **Write `themes/<slug>.md`** — the human-readable named-role card,
   theme-factory style: one line per colour as `Name #hex - role`, plus the
   typefaces, the layout concept, and the one signature element.
6. **Run `node scripts/qa-deck.mjs <deck> --strict`.** It lints the token
   contract and **fails on any missing required token**. Token omission is
   silent at runtime (gotcha #12) — this is the only thing that catches it.
7. **Visually check one slide of each type** against `examples/`. The examples
   are the quality bar; prose rules aren't.

---

## Why the tokens are inlined, not `@import`ed

Handover decks are zipped, emailed, and opened from `file://`. A `file://`
document cannot resolve `node_modules`, a bare specifier, or a path that escapes
the deck folder — all of which fail **silently** on the recipient's machine. So
`@aios-alpha/design` cannot be a runtime dependency of a shipped deck; the token
values have to be copied in.

What keeps that copy honest is the header comment: the **pinned package version**
plus a **source hash** of the token file it was derived from, plus the date.
That makes drift detectable — you can diff the current package against what a
theme was generated from instead of wondering. Copying without the provenance
header is the thing to refuse.
