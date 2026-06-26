import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_KEY } from "../../theme.js";

/** Dark is the workspace GUI's terminal-native default; light is opt-in. */
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      /* storage blocked */
    }
  };
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
