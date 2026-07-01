# Rule: Design system

When you add or change **UI** in this workspace (a local app, dashboard, or HTML report),
use the shared AIOS design system — do not invent a one-off palette, font stack, or spacing scale.

## Packages

- **`@aios-alpha/design`** — CSS tokens + Tailwind v4 bridge (no React required).
- **`@aios-alpha/ui`** — React components (buttons, badges, terminal frames, etc.).

Both are public on npm; no auth. The human/agent contract is **`DESIGN.md`** inside
`@aios-alpha/design` (also at [github.com/AIOS-alpha/aios-design](https://github.com/AIOS-alpha/aios-design)).

## Consumption recipe

```css
@import "@aios-alpha/design/tokens.css";
@import "@aios-alpha/design/tailwind-theme.css";
@import "tailwindcss";
@source "../node_modules/@aios-alpha/ui/dist";
@custom-variant dark (&:where(.dark, .dark *));
```

Reference implementation: the **AIOS workspace GUI** (`gui/client/` in the toolkit repo) —
`app.css` token bridge, `theme.js` for dark default, `@aios-alpha/ui` for shared components.

## Rules

1. **Never hardcode hex, px type sizes, or ad-hoc font stacks** in components — use `--aios-*`
   tokens or Tailwind utilities from the bridge.
2. **Dual-mode:** ship light and dark; toggle via `class="dark"` on `<html>`.
3. **Violet** is the brand/CTA color; **lime** is rationed to live/active status (one filled
   lime action per screen max).
4. **Do not copy token JSON or CSS out of the package** into this repo — pin the npm version
   and import from `@aios-alpha/design`.
5. Markdown-first workspaces (the default scaffold) have no UI dependency until you add one.

Toolkit doc: `docs/design-system.md` (in the `aios-workspace` repo you were scaffolded from).
