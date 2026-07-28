# AIOS Design System — Consumer Contract

**Version: 0.3.0** (tracks `@aios-alpha/design@0.3.0` + `@aios-alpha/ui@0.3.0` on npm).
Design direction: **Editorial Minimal**.
This document is the workspace toolkit's pinned pointer to the unified AIOS design system —
the UI counterpart to `brain-api.md` (sync). Both sides and every surface build against
the published packages; never hand-maintain a copy of the tokens in a consumer repo.

**Source of truth:** [`aios-design/DESIGN.md`](https://github.com/aiosbrain/aios-design)
(compiled to npm). Change tokens and `DESIGN.md` there first, publish, then bump consumers.

**Public summary:** [Design System reference](https://aios-alpha.github.io/reference/design-system/)
on the AIOS website.

## The two packages

| Package | What it ships |
|---------|---------------|
| **`@aios-alpha/design`** | CSS tokens (`tokens.css`), Tailwind v4 bridge (`tailwind-theme.css`), Pencil variables (`tokens.pencil.json`), `DESIGN.md` |
| **`@aios-alpha/ui`** | shadcn-based React components themed through the bridge |

```bash
npm install @aios-alpha/design @aios-alpha/ui
```

## Consumption recipe (Tailwind v4)

In a global stylesheet, in this order:

```css
@import "@aios-alpha/design/tokens.css";
@import "@aios-alpha/design/tailwind-theme.css";
@import "tailwindcss";
@source "../node_modules/@aios-alpha/ui/dist";
@custom-variant dark (&:where(.dark, .dark *));
```

Light is `:root` default; add `class="dark"` on `<html>` for dark mode. Per-surface
defaults differ (Team Brain defaults light; workspace GUI defaults dark).

## Reference implementations in this repo

| Surface | Path | Notes |
|---------|------|-------|
| **Workspace GUI** | `gui/client/` | Full recipe + token bridge in `src/app.css`; see `src/theme.js` |
| **Scaffold** | `scaffold/.claude/rules/design-system.md` | Agent conventions — no frontend shipped in the template |

Scaffolded workspaces inherit these conventions via `.claude/rules/design-system.md` in
the template. When an owner adds UI, follow the GUI client pattern or import the packages
directly.

## Dual-mode and tokens

**The semantic split landed in 0.2.0 — `primary` is no longer violet.** Consuming code written
against the old mapping will render the wrong buttons:

- **`primary`** — filled pill buttons and active tabs. Near-black `#0a0a0a` light / white
  `#ffffff` dark, `rounded-full`, no glow, no drop shadow. **Not violet.**
- **`violet`** (`#7c3aed` light / `#8b5cf6` dark) — brand mark, team tier, deliverable kind,
  default badge tint.
- **`accent`** — lime `#84cc16`, rationed: status dots, terminal live indicator, at most one
  filled lime action per screen.
- **Supporting** — cyan (external/transcript), emerald (task), amber (decision), fuchsia
  (skill). Badge semantics and KPI sparklines only, never chrome.

Typography (self-hosted via `@fontsource/*`, never a Google CDN):

- **Instrument Serif** — display/headings, **weight 400 only**; set `font-synthesis: none` so
  the browser never faux-bolds it.
- **Instrument Sans** — body and UI, weights 400–700.
- **JetBrains Mono** — code, eyebrows, metadata, badges.

Chrome is greyscale: white/off-white in light, matte near-black steps
(`#0b0b0b → #131313 → #191919`) in dark. Elevation is mode-specific — light uses a hairline
border plus a subtle shadow; dark steps the surface and border, with glow instead of card drop
shadows.

See `DESIGN.md` in the package for the full contract, palettes, and do's/don'ts.
