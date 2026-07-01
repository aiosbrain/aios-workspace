/**
 * Localhost session-token handling. The server mints a random token at startup;
 * the first visit must carry it as `?token=…` (from the `npm run gui` link), after
 * which we reuse it for this browser tab so a refresh to `/` still authenticates.
 */
const GUI_TOKEN_KEY = "aios.gui.token";

export function resolveGuiToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("token") || "";
  if (fromUrl) {
    try {
      sessionStorage.setItem(GUI_TOKEN_KEY, fromUrl);
    } catch {
      /* storage blocked */
    }
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(GUI_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** User-facing message when a WebSocket connection fails. */
export function connectErrorMessage(reason: string, token: string): string {
  if (!token) {
    return "Missing session token — open the full link printed by `npm run gui` once, then refresh";
  }
  return `${reason} — if you restarted the GUI, open the new link from \`npm run gui\``;
}
