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
      className="theme-toggle"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle color theme"
    >
      <span className="theme-toggle-icon" aria-hidden>
        {dark ? <Moon size={14} /> : <Sun size={14} />}
      </span>
      {dark ? "Dark" : "Light"}
    </button>
  );
}
