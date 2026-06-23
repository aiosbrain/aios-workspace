# AIOS Design System — Consumer Contract

**Version: 0.1.0** (tracks `@aios-alpha/design@0.1.0` + `@aios-alpha/ui@0.1.0` on npm).
This document is the workspace toolkit's pinned pointer to the unified AIOS design system —
the UI counterpart to `brain-api.md` (sync). Both sides and every surface build against
the published packages; never hand-maintain a copy of the tokens in a consumer repo.

**Source of truth:** [`aios-design/DESIGN.md`](https://github.com/AIOS-alpha/aios-design)
(compiled to npm). Change tokens and `DESIGN.md` there first, publish, then bump consumers.

**Public summary:** [Design System reference](https://aios-alpha.github.io/reference/design-system/)
on the AIOS website.

## The two packages

| Package | What it ships |
|---------|---------------|
| **`@aios-alpha/design`** | CSS tokens (`tokens.css`), Tailwind v4 bridge (`tailwind-theme.css`), `DESIGN.md` |
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

- Brand **violet** (`--aios-primary`); **lime** rationed (`--aios-accent`, at most one filled
  lime action per screen).
- Typography: Space Grotesk (display), Plus Jakarta Sans (body), JetBrains Mono (code + UI labels).
- Elevation is mode-specific: light uses hairline border + subtle shadow; dark steps surface
  + border, glow instead of card drop shadows.

See `DESIGN.md` in the package for the full contract, palettes, and do's/don'ts.
