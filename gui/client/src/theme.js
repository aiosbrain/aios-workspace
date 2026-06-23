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
