import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { isDark, toggleTheme, THEME_EVENT } from "../../theme.js";

/** Dark is the workspace GUI's terminal-native default; light is opt-in. */
export function ThemeToggle() {
  const [dark, setDark] = useState(() => isDark());
  const toggle = () => setDark(toggleTheme());
  // Stay in sync when another surface (the ⌘K palette) flips the theme.
  useEffect(() => {
    const onChange = () => setDark(isDark());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  return (
    <button
      className="flex cursor-pointer items-center gap-2 self-start rounded-md border border-border-visible bg-secondary px-2.5 py-[5px] text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle color theme"
    >
      <span className="text-[13px] leading-none" aria-hidden>
        {dark ? <Moon size={14} /> : <Sun size={14} />}
      </span>
      {dark ? "Dark" : "Light"}
    </button>
  );
}
