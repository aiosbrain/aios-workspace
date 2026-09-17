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
export function terminalTheme(ctx: Capabilities) {
  const palette = palettes[ctx.background] ?? palettes.dark!;
  const color = (token: string, ansi: string) =>
    ctx.colorDepth === 0 ? undefined : ctx.colorDepth >= 24 ? palette[token] : ansi;
  // Undefined Ink colors inherit the user's foreground/background, even in truecolor.
  const native = undefined as unknown as string;
  const colors: ColorTokens = {
    primary: native,
    primaryForeground: native,
    secondary: native,
    secondaryForeground: native,
    accent: native,
    accentForeground: native,
    background: native,
    foreground: native,
    muted: native,
    mutedForeground: native,
    border: native,
    focusRing: native,
    selection: native,
    selectionForeground: native,
    success: color("emerald", "green") as string,
    successForeground: native,
    warning: color("amber", "yellow") as string,
    warningForeground: native,
    error: color("destructive", "red") as string,
    errorForeground: native,
    info: native,
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
