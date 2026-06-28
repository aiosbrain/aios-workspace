/** Shared light/dark toggle key for the workspace GUI (terminal-native dark default). */
export const THEME_KEY = "aios.gui.theme";

/** Apply saved theme before first paint; default dark when unset or storage blocked. */
export function applySavedTheme() {
  try {
    if (localStorage.getItem(THEME_KEY) !== "light") {
      document.documentElement.classList.add("dark");
    }
  } catch {
    document.documentElement.classList.add("dark");
  }
}

/** Whether dark mode is currently active. */
export function isDark() {
  return document.documentElement.classList.contains("dark");
}

/**
 * Flip (or set) the color theme and persist it. Returns the resulting dark state.
 * Single source of truth for the toggle — used by ThemeToggle and the ⌘K palette so
 * they never drift in how they read/write THEME_KEY.
 */
export function toggleTheme(next) {
  const dark = typeof next === "boolean" ? next : !isDark();
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    /* storage blocked */
  }
  // Let any mounted theme UI (e.g. the Settings toggle) re-sync when the palette flips it.
  try {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { dark } }));
  } catch {
    /* non-browser / no window */
  }
  return dark;
}

/** Fired on window whenever the theme changes; detail: { dark: boolean }. */
export const THEME_EVENT = "aios:theme-change";
