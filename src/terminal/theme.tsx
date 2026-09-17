import type { ReactNode } from "react";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createTheme, ThemeProvider } from "./vendor/providers/theme-provider.js";
import { MotionProvider } from "./vendor/providers/motion-provider.js";
import { UnicodeProvider } from "./vendor/providers/unicode-provider.js";
import type { ColorTokens } from "./vendor/ui/types.js";
import type { Capabilities } from "./types.js";

const require = createRequire(import.meta.url);
// Compatibility with design 0.3–0.6, before the additive /terminal export ships.
// Both sources are generated canonical tokens; no palette literals are duplicated here.
async function loadColors(): Promise<Record<string, Record<string, string>>> {
  const specifier = "@aios-alpha/design/terminal";
  try {
    return (await import(specifier)).terminalColors;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    const tokens = JSON.parse(
      readFileSync(require.resolve("@aios-alpha/design/tokens.pencil.json"), "utf8")
    );
    return { light: tokens.colorsLight, dark: tokens.colorsDark };
  }
}
const palettes = await loadColors();
// Derive readable ink from canonical colors, without changing the terminal canvas.
// Native palettes vary; use the selected AIOS light/dark canvas as the reference.
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (channels: number[]) =>
  channels.reduce((sum, channel, i) => {
    const v = channel / 255;
    return (
      sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!
    );
  }, 0);
function readableInk(ink: string, canvas: string, foreground: string) {
  const original = rgb(ink);
  const target = rgb(foreground);
  const background = luminance(rgb(canvas));
  for (let step = 0; step <= 100; step++) {
    const channels = original.map((value, i) =>
      Math.round(value + ((target[i]! - value) * step) / 100)
    );
    const light = luminance(channels);
    if ((Math.max(light, background) + 0.05) / (Math.min(light, background) + 0.05) >= 4.5) {
      return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return foreground;
}
export function terminalTheme(ctx: Capabilities) {
  const palette = palettes[ctx.background] ?? palettes.dark!;
  const color = (token: string, ansi: string) =>
    ctx.colorDepth === 0
      ? undefined
      : ctx.colorDepth >= 24
        ? readableInk(palette[token]!, palette.bg!, palette.fg!)
        : ansi;
  // Undefined Ink colors inherit the user's foreground/background, even in truecolor.
  const native = undefined as unknown as string;
  const colors: ColorTokens = {
    primary: color("violet", "magenta") as string,
    primaryForeground: native,
    secondary: color("cyan", "cyan") as string,
    secondaryForeground: native,
    accent: color("accent", "green") as string,
    accentForeground: native,
    background: native,
    foreground: native,
    muted: native,
    mutedForeground: native,
    border: native,
    focusRing: color("violet", "magenta") as string,
    selection: native,
    selectionForeground: native,
    success: color("emerald", "green") as string,
    successForeground: native,
    warning: color("amber", "yellow") as string,
    warningForeground: native,
    error: color("destructive", "red") as string,
    errorForeground: native,
    info: color("cyan", "cyan") as string,
    infoForeground: native,
  };
  return createTheme({ name: "aios", colors });
}
export function Providers({ ctx, children }: { ctx: Capabilities; children: ReactNode }) {
  return (
    <ThemeProvider theme={terminalTheme(ctx)}>
      <MotionProvider reducedMotion={!ctx.motion || ctx.tier !== "rich"}>
        <UnicodeProvider unicode={ctx.glyphs !== "ascii"}>{children}</UnicodeProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}
